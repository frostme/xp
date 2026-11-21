import type { Sequelize, Transaction } from "sequelize";

import type { IDataAccessAdaptor } from "~/interfaces";
import type { SequelizeDialect } from "~/interfaces/config";

import { relationalAdaptor, type Row, type SqlSession } from "../relational";

export function supportedDialect(client: Sequelize): SequelizeDialect {
  const dialect = client.getDialect();
  if (dialect === "postgres" || dialect === "mysql" || dialect === "mssql") return dialect;
  throw new TypeError(
    `Unsupported Sequelize dialect "${dialect}". Expected postgres, mysql, or mssql.`,
  );
}

function session(
  client: Sequelize,
  dialect: SequelizeDialect,
  transaction: Transaction | null,
): SqlSession {
  const parameter = (index: number) => `$p${index}`;
  // Ask the database for JSON text, including quotes for JSON scalar strings.
  const cohortColumns =
    dialect === "mssql"
      ? "*"
      : `id, experiment_id, slug, description, percentage, type, ${dialect === "postgres" ? "value::text" : "CAST(value AS CHAR CHARACTER SET utf8mb4)"} AS value`;
  const execute = (sql: string, values: unknown[]) =>
    client.query(sql, {
      bind: Object.fromEntries(values.map((value, index) => [`p${index + 1}`, value])),
      transaction,
      // Reads following a pause or a concurrent assignment must use the writer.
      useMaster: true,
      raw: true,
    });
  const query = async (sql: string, values: unknown[] = []): Promise<Row[]> => {
    const statement = sql.replace("SELECT * FROM cohorts", `SELECT ${cohortColumns} FROM cohorts`);
    const [rows] = await execute(statement, values);
    return Array.isArray(rows) ? (rows as Row[]) : [];
  };
  return {
    query,
    parameter,
    lock: (table, where, values) =>
      query(
        dialect === "mssql"
          ? `SELECT * FROM ${table} WITH (UPDLOCK, HOLDLOCK) WHERE ${where}`
          : `SELECT * FROM ${table} WHERE ${where} FOR UPDATE`,
        values,
      ),
    insert: async (table, fields) => {
      const entries = Object.entries(fields);
      const columns = entries
        .map(([name]) => client.getQueryInterface().quoteIdentifier(name))
        .join(", ");
      const placeholders = entries.map((_, index) => parameter(index + 1)).join(", ");
      const values = entries.map(([, value]) => value);
      const insert = `INSERT INTO ${table} (${columns})`;
      const payload = `VALUES (${placeholders})`;
      if (dialect === "mysql") {
        // Both statements run on the connection held by the managed transaction.
        await execute(`${insert} ${payload}`, values);
        return (await query(`SELECT * FROM ${table} WHERE id = LAST_INSERT_ID()`))[0]!;
      }
      const statement =
        dialect === "mssql"
          ? `${insert} OUTPUT INSERTED.* ${payload}`
          : `${insert} ${payload} RETURNING ${table === "cohorts" ? cohortColumns : "*"}`;
      return (await query(statement, values))[0]!;
    },
  };
}

export function sequelizeAdaptor(client: Sequelize, dialect: SequelizeDialect): IDataAccessAdaptor {
  return relationalAdaptor({
    dialect,
    read: (work) => work(session(client, dialect, null)),
    transaction: (work) =>
      client.transaction((transaction) => work(session(client, dialect, transaction))),
  });
}
