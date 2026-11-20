import type { SqlDatabase } from "./relational";

interface SqlError {
  code?: string;
  number?: number;
  constraint?: string;
  detail?: string;
  message?: string;
  sqlMessage?: string;
  parent?: SqlError;
}

/** Only called for the parent INSERT after its transaction successfully rolls back. */
export async function isExperimentSlugConflict(
  database: SqlDatabase,
  error: unknown,
): Promise<boolean> {
  const wrapped = error as SqlError | undefined;
  const cause = wrapped?.parent ?? wrapped; // Sequelize carries the native error in parent.
  if (cause?.code === "23505") {
    return (
      cause.constraint === "experiments_slug_key" ||
      cause.detail?.startsWith("Key (slug)=(") === true
    );
  }
  if (cause?.code === "ER_DUP_ENTRY") {
    const index = /for key '(?:experiments\.)?([^']+)'$/i.exec(
      cause.sqlMessage ?? cause.message ?? "",
    )?.[1];
    if (!index) return false;
    if (index === "experiments_slug_key" || index === "slug") return true;
    return database.read(
      async (s) =>
        (
          await s.query(
            `SELECT index_name FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = 'experiments' AND index_name = ${s.parameter(1)} AND non_unique = 0
       GROUP BY index_name HAVING COUNT(*) = 1 AND MAX(column_name) = 'slug'`,
            [index],
          )
        ).length > 0,
    );
  }
  if (cause?.number === 2601 || cause?.number === 2627) {
    const index = /(?:constraint|unique index) '([^']+)'/i.exec(cause.message ?? "")?.[1];
    if (!index) return false;
    if (index === "experiments_slug_key") return true;
    // A v1 SQL Server guide used an anonymous UNIQUE constraint. Resolve its generated name.
    return database.read(
      async (s) =>
        (
          await s.query(
            `SELECT i.name FROM sys.indexes i
       JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
       JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       WHERE i.object_id = OBJECT_ID('experiments') AND i.is_unique = 1 AND i.name = ${s.parameter(1)} AND ic.key_ordinal > 0
       GROUP BY i.name HAVING COUNT(*) = 1 AND MAX(c.name) = 'slug'`,
            [index],
          )
        ).length > 0,
    );
  }
  return false;
}
