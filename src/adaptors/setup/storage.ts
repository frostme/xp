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
  if (options.userStorage === "create")
    up.push(table("users", [`id ${userType} NOT NULL`, "CONSTRAINT users_pkey PRIMARY KEY (id)"]));
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
