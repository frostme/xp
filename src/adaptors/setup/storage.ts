import type { ResolvedSetup, SetupDatabase } from "~/interfaces/setup";

/** Persistence contract, intentionally separate from the public domain entities. */
export const STORAGE_VERSION = 1;
export const STORAGE = {
  experimentTypes: ["flag", "simple", "multivariate", "dynamic"],
  cohortTypes: ["control", "treatment"],
  ownedTables: ["experiments", "cohorts", "user_cohorts"],
  indexes: [
    { table: "cohorts", columns: ["experiment_id"], name: "cohorts_experiment_id_idx" },
    { table: "user_cohorts", columns: ["experiment_id"], name: "user_cohorts_experiment_id_idx" },
    { table: "user_cohorts", columns: ["cohort_id"], name: "user_cohorts_cohort_id_idx" },
  ],
} as const;

export const MONGO_INDEXES = [
  { collection: "experiments", key: { id: 1 }, unique: true },
  { collection: "experiments", key: { slug: 1 }, unique: true },
  { collection: "cohorts", key: { id: 1 }, unique: true },
  { collection: "cohorts", key: { slug: 1 }, unique: true },
  { collection: "cohorts", key: { experiment_id: 1 }, unique: false },
  { collection: "users", key: { id: 1 }, unique: true },
  { collection: "user_cohorts", key: { id: 1 }, unique: true },
  { collection: "user_cohorts", key: { user_id: 1, experiment_id: 1 }, unique: true },
  { collection: "user_cohorts", key: { experiment_id: 1 }, unique: false },
  { collection: "user_cohorts", key: { cohort_id: 1 }, unique: false },
] as const;

export function isSql(database: SetupDatabase): database is "postgres" | "mysql" | "mssql" {
  return database === "postgres" || database === "mysql" || database === "mssql";
}

/** Only a type declaration is accepted; constraints/default expressions belong to xp. */
export function userIdSql(options: ResolvedSetup): string {
  const { database, userIdType, userIdCollation, userIdCharset } = options;
  const type = userIdType.trim();
  const patterns = {
    postgres:
      /^(?:text|uuid|smallint|integer|int|bigint|(?:character varying|varchar|character|char)\s*\(\s*[1-9]\d*\s*\)|(?:numeric|decimal)\s*\(\s*[1-9]\d*\s*,\s*0\s*\))$/i,
    mysql:
      /^(?:(?:tinyint|smallint|mediumint|int|integer|bigint)(?:\s+unsigned)?|(?:varchar|char)\s*\(\s*[1-9]\d*\s*\)|(?:decimal|numeric)\s*\(\s*[1-9]\d*\s*,\s*0\s*\)(?:\s+unsigned)?)$/i,
    mssql:
      /^(?:tinyint|smallint|int|integer|bigint|uniqueidentifier|(?:nvarchar|varchar|nchar|char)\s*\(\s*[1-9]\d*\s*\)|(?:decimal|numeric)\s*\(\s*[1-9]\d*\s*,\s*0\s*\))$/i,
  };
  if (!isSql(database) || !patterns[database].test(type)) {
    throw new Error(
      `Unsupported ${database} user ID type ${JSON.stringify(type)}. Supply a scalar SQL ID type such as integer, uuid (PostgreSQL), varchar(191) (MySQL), or nvarchar(255) (SQL Server).`,
    );
  }
  const stringType =
    /^(?:text|(?:character varying|varchar|character|char|nvarchar|nchar)\b)/i.test(type);
  if ((userIdCollation || userIdCharset) && !stringType) {
    throw new Error("User ID collation/charset may only be supplied for a character column.");
  }
  if (userIdCharset && database !== "mysql")
    throw new Error("--user-id-charset is only supported for MySQL.");
  const quote = (name: string): string => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new Error(`Invalid collation or charset ${JSON.stringify(name)}.`);
    return database === "postgres" ? `"${name}"` : name;
  };
  return (
    type +
    (userIdCharset ? ` CHARACTER SET ${quote(userIdCharset)}` : "") +
    (userIdCollation ? ` COLLATE ${quote(userIdCollation)}` : "")
  );
}

function userTableSql(options: ResolvedSetup, userType: string): string[] {
  const { database, userIdType } = options;
  const declaration = userIdType
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*\(\s*/g, "(")
    .replace(/\s*\)/g, ")")
    .replace(/\s*,\s*/g, ",");
  const create = database === "mysql" ? "CREATE TABLE IF NOT EXISTS users" : "CREATE TABLE users";
  const table = () =>
    `${create} (\n  id ${userType} NOT NULL,\n  CONSTRAINT users_pkey PRIMARY KEY (id)\n)${database === "mysql" ? " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4" : ""};`;
  if (database === "postgres") {
    const expected = declaration
      .replace(/^int$/, "integer")
      .replace(/^varchar\b/, "character varying")
      .replace(/^char\b/, "character")
      .replace(/^decimal\b/, "numeric");
    return [
      `DO $xp$ BEGIN\n  IF to_regclass('users') IS NULL THEN\n    ${table()}\n  END IF;\n  IF NOT EXISTS (\n    SELECT 1 FROM pg_attribute a\n    WHERE a.attrelid = to_regclass('users') AND a.attname = 'id' AND a.attnotnull\n      AND format_type(a.atttypid, a.atttypmod) = '${expected}'\n      AND EXISTS (\n        SELECT 1 FROM pg_constraint p\n        WHERE p.conrelid = a.attrelid AND p.contype = 'p' AND p.conkey = ARRAY[a.attnum]::smallint[]\n      )\n  ) THEN\n    RAISE EXCEPTION 'Existing users table has an incompatible id; xp will not alter user data.';\n  END IF;\nEND $xp$;`,
    ];
  }
  if (database === "mysql") {
    const expected = declaration
      .replace(/^integer$/, "int")
      .replace(/^character varying\b/, "varchar")
      .replace(/^character\b/, "char")
      .replace(/^numeric\b/, "decimal");
    const charset = options.userIdCharset
      ? ` AND CHARACTER_SET_NAME = '${options.userIdCharset}'`
      : "";
    const collation = options.userIdCollation
      ? ` AND COLLATION_NAME = '${options.userIdCollation}'`
      : "";
    return [
      table(),
      `SELECT IF(EXISTS (\n  SELECT 1 FROM information_schema.columns\n  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'id'\n    AND IS_NULLABLE = 'NO' AND COLUMN_TYPE = '${expected}' AND COLUMN_KEY = 'PRI'${charset}${collation}\n    AND (SELECT COUNT(*) FROM information_schema.statistics\n      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'PRIMARY') = 1\n), 1, (SELECT 1 UNION ALL SELECT 1));`,
    ];
  }
  const parsed = /^([a-z ]+)(?:\((\d+)(?:,\s*(\d+))?\))?$/.exec(declaration)!;
  const base = parsed[1]!
    .trim()
    .replace(/^integer$/, "int")
    .replace(/^numeric$/, "decimal");
  const checks = [`TYPE_NAME(c.user_type_id) = N'${base}'`, "c.is_nullable = 0"];
  if (/^(?:n?varchar|n?char)$/.test(base) && parsed[2])
    checks.push(`c.max_length = ${Number(parsed[2]) * (base.startsWith("n") ? 2 : 1)}`);
  if (base === "decimal" && parsed[2]) {
    checks.push(`c.precision = ${Number(parsed[2])}`);
    checks.push(`c.scale = ${Number(parsed[3] ?? 0)}`);
  }
  checks.push(
    `EXISTS (SELECT 1 FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id WHERE i.object_id = c.object_id AND i.is_primary_key = 1 AND ic.column_id = c.column_id AND ic.key_ordinal = 1 AND (SELECT COUNT(*) FROM sys.index_columns pkc WHERE pkc.object_id = i.object_id AND pkc.index_id = i.index_id AND pkc.key_ordinal > 0) = 1)`,
  );
  return [
    `IF OBJECT_ID(N'users', N'U') IS NULL BEGIN\n  ${table()}\nEND;\nIF NOT EXISTS (SELECT 1 FROM sys.columns c WHERE c.object_id = OBJECT_ID(N'users') AND c.name = N'id' AND ${checks.join(" AND ")}) BEGIN\n  ;THROW 50000, 'Existing users table has an incompatible id; xp will not alter user data.', 1;\nEND;`,
  ];
}

export function renderSql(options: ResolvedSetup): { up: string[]; down: string[] } {
  if (!isSql(options.database))
    throw new Error(`SQL generation is not supported for ${options.database}.`);
  const database = options.database;
  const userType = userIdSql(options);
  const id =
    database === "postgres"
      ? "SERIAL NOT NULL"
      : database === "mysql"
        ? "INTEGER AUTO_INCREMENT NOT NULL"
        : "INT IDENTITY(1,1) NOT NULL";
  const text = database === "mssql" ? "NVARCHAR(MAX)" : "TEXT";
  const slug =
    database === "mysql"
      ? "VARCHAR(191) COLLATE utf8mb4_0900_bin"
      : database === "mssql"
        ? "NVARCHAR(255) COLLATE Latin1_General_100_BIN2"
        : "TEXT";
  const enumType =
    database === "mssql" ? "NVARCHAR(20)" : database === "mysql" ? "VARCHAR(32)" : "TEXT";
  const percentage =
    database === "postgres" ? "DOUBLE PRECISION" : database === "mysql" ? "DOUBLE" : "FLOAT";
  const json =
    database === "postgres"
      ? "JSONB NOT NULL DEFAULT 'null'::jsonb"
      : database === "mysql"
        ? "JSON NOT NULL"
        : "NVARCHAR(MAX) NOT NULL CONSTRAINT cohorts_value_df DEFAULT N'null'";
  const suffix = database === "mysql" ? " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4" : "";
  const table = (name: string, definitions: string[]) =>
    `CREATE TABLE ${name} (\n  ${definitions.join(",\n  ")}\n)${suffix};`;
  const enums = (values: readonly string[]) => values.map((value) => `'${value}'`).join(", ");
  const up: string[] = [];
  if (options.userStorage === "create") up.push(...userTableSql(options, userType));
  up.push(
    table("experiments", [
      `id ${id}`,
      `name ${text} NOT NULL`,
      `slug ${slug} NOT NULL`,
      `type ${enumType} NOT NULL`,
      `description ${text} NOT NULL`,
      `winner ${slug} NULL`,
      "CONSTRAINT experiments_pkey PRIMARY KEY (id)",
      "CONSTRAINT experiments_slug_key UNIQUE (slug)",
      `CONSTRAINT experiments_type_check CHECK (type IN (${enums(STORAGE.experimentTypes)}))`,
    ]),
  );
  up.push(
    table("cohorts", [
      `id ${id}`,
      "experiment_id INTEGER NOT NULL",
      `slug ${slug} NOT NULL`,
      `type ${enumType} NOT NULL`,
      `description ${text} NOT NULL`,
      `percentage ${percentage} NOT NULL`,
      `value ${json}`,
      "CONSTRAINT cohorts_pkey PRIMARY KEY (id)",
      "CONSTRAINT cohorts_slug_key UNIQUE (slug)",
      "CONSTRAINT cohorts_id_experiment_id_key UNIQUE (id, experiment_id)",
      `CONSTRAINT cohorts_type_check CHECK (type IN (${enums(STORAGE.cohortTypes)}))`,
      "CONSTRAINT cohorts_percentage_check CHECK (percentage >= 0 AND percentage <= 100)",
      ...(database === "mssql"
        ? ["CONSTRAINT cohorts_value_check CHECK (ISJSON(value, VALUE) = 1)"]
        : []),
      "CONSTRAINT cohorts_experiment_id_fkey FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE NO ACTION ON UPDATE NO ACTION",
    ]),
  );
  up.push(
    table("user_cohorts", [
      `id ${id}`,
      `user_id ${userType} NOT NULL`,
      "experiment_id INTEGER NOT NULL",
      "cohort_id INTEGER NOT NULL",
      "CONSTRAINT user_cohorts_pkey PRIMARY KEY (id)",
      "CONSTRAINT user_cohorts_user_id_experiment_id_key UNIQUE (user_id, experiment_id)",
      "CONSTRAINT user_cohorts_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE NO ACTION ON UPDATE NO ACTION",
      "CONSTRAINT user_cohorts_experiment_id_fkey FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE NO ACTION ON UPDATE NO ACTION",
      "CONSTRAINT user_cohorts_cohort_id_experiment_id_fkey FOREIGN KEY (cohort_id, experiment_id) REFERENCES cohorts(id, experiment_id) ON DELETE NO ACTION ON UPDATE NO ACTION",
    ]),
  );
  for (const index of STORAGE.indexes)
    up.push(`CREATE INDEX ${index.name} ON ${index.table}(${index.columns.join(", ")});`);
  return {
    up,
    down: ["DROP TABLE user_cohorts;", "DROP TABLE cohorts;", "DROP TABLE experiments;"],
  };
}
