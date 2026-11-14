import type { GeneratedArtifacts, ResolvedSetup } from "~/interfaces/setup";

import { STORAGE } from "../storage";
import { codeExtension, generatedHeader, outputPath, userPrimitive } from "./common";

type Kind =
  | "id"
  | "text"
  | "slug"
  | "experimentType"
  | "cohortType"
  | "winner"
  | "foreignId"
  | "userId"
  | "percentage"
  | "json"
  | "version";
const tables: { name: string; model: string; fields: Record<string, Kind> }[] = [
  {
    name: "experiments",
    model: "XpExperiment",
    fields: {
      id: "id",
      name: "text",
      slug: "slug",
      type: "experimentType",
      description: "text",
      winner: "winner",
    },
  },
  {
    name: "cohorts",
    model: "XpCohort",
    fields: {
      id: "id",
      experiment_id: "foreignId",
      slug: "slug",
      type: "cohortType",
      description: "text",
      percentage: "percentage",
      value: "json",
    },
  },
  {
    name: "user_cohorts",
    model: "XpUserCohort",
    fields: { id: "id", user_id: "userId", experiment_id: "foreignId", cohort_id: "foreignId" },
  },
];

function indices(table: string): { fields: string[]; unique?: boolean; name?: string }[] {
  const result: { fields: string[]; unique?: boolean; name?: string }[] = STORAGE.indexes
    .filter((index) => index.table === table)
    .map((index) => ({ fields: [...index.columns], name: index.name }));
  if (table === "cohorts") result.push({ fields: ["id", "experiment_id"], unique: true });
  if (table === "user_cohorts") result.push({ fields: ["user_id", "experiment_id"], unique: true });
  return result;
}

function moduleSource(
  options: ResolvedSetup,
  packageName: string,
  imports: string,
  body: string,
  exports: string[],
): string {
  const esm = options.language === "typescript" || options.moduleFormat === "esm";
  return (
    generatedHeader +
    (esm
      ? `import { ${imports} } from ${JSON.stringify(packageName)};\n\n`
      : `const { ${imports} } = require(${JSON.stringify(packageName)});\n\n`) +
    "// Read/query helpers. Apply the generated migration; do not use schema sync or direct writes to xp-owned records.\n" +
    body +
    (esm
      ? `\nexport { ${exports.join(", ")} };\n`
      : `\nmodule.exports = { ${exports.join(", ")} };\n`)
  );
}

function sequelizeType(kind: Kind, options: ResolvedSetup): string {
  const mssql = options.database === "mssql";
  if (kind === "id" || kind === "foreignId" || kind === "version") return "DataTypes.INTEGER";
  if (kind === "percentage") return mssql ? "DataTypes.DOUBLE" : "DataTypes.DOUBLE";
  if (kind === "json")
    return options.database === "postgres"
      ? "DataTypes.JSONB"
      : mssql
        ? "DataTypes.TEXT"
        : "DataTypes.JSON";
  if (kind === "text") return "DataTypes.TEXT";
  if (kind === "experimentType" || kind === "cohortType")
    return `DataTypes.STRING(${mssql ? "20" : "32"})`;
  if (kind === "userId") {
    const type = options.userIdType.toLowerCase();
    if (type === "uuid" || type === "uniqueidentifier") return "DataTypes.UUID";
    const numeric = /^(tinyint|smallint|mediumint|int|integer|bigint)/.exec(type)?.[1];
    if (numeric)
      return `DataTypes.${numeric === "int" ? "INTEGER" : numeric.toUpperCase()}${/unsigned/.test(type) ? ".UNSIGNED" : ""}`;
    if (/^(numeric|decimal)/.test(type))
      return `DataTypes.DECIMAL${/\([^)]*\)/.exec(type)?.[0] ?? ""}`;
    const length = /\((\d+)\)/.exec(type)?.[1];
    if (length) return `DataTypes.STRING(${length})`;
    return "DataTypes.TEXT";
  }
  return options.database === "postgres"
    ? "DataTypes.TEXT"
    : `DataTypes.STRING(${mssql ? "255" : "191"})`;
}

function sequelizeModels(options: ResolvedSetup): string {
  let body = `function defineXpModels(sequelize${options.language === "typescript" ? ': import("sequelize").Sequelize' : ""}) {\n`;
  for (const table of tables) {
    body += `  const ${table.model} = sequelize.define(${JSON.stringify(table.model)}, {\n`;
    for (const [name, kind] of Object.entries(table.fields)) {
      const config = [
        `type: ${sequelizeType(kind, options)}`,
        `field: ${JSON.stringify(name)}`,
        `allowNull: ${kind === "winner"}`,
      ];
      if (kind === "id") config.push("primaryKey: true", "autoIncrement: true");
      if (kind === "slug") config.push("unique: true");
      if (kind === "percentage") config.push("validate: { min: 0, max: 100 }");
      if (kind === "experimentType" || kind === "cohortType")
        config.push(
          `validate: { isIn: [${JSON.stringify(kind === "experimentType" ? STORAGE.experimentTypes : STORAGE.cohortTypes)}] }`,
        );
      body += `    ${name}: { ${config.join(", ")} },\n`;
    }
    body += `  }, { tableName: ${JSON.stringify(table.name)}, freezeTableName: true, timestamps: false, indexes: ${JSON.stringify(indices(table.name))} });\n`;
  }
  body += "  return { XpExperiment, XpCohort, XpUserCohort };\n}\n";
  return moduleSource(options, "sequelize", "DataTypes", body, ["defineXpModels"]);
}

function sqlColumn(kind: Kind, options: ResolvedSetup): Record<string, unknown> {
  const pg = options.database === "postgres";
  const mssql = options.database === "mssql";
  let column: Record<string, unknown>;
  switch (kind) {
    case "id":
      column = { type: "int", primary: true, generated: "increment" };
      break;
    case "foreignId":
    case "version":
      column = { type: "int" };
      break;
    case "percentage":
      column = { type: pg ? "double precision" : mssql ? "float" : "double" };
      break;
    case "json":
      column = {
        type: pg ? "jsonb" : mssql ? "nvarchar" : "json",
        ...(mssql ? { length: "MAX" } : {}),
      };
      break;
    case "text":
      column = { type: mssql ? "nvarchar" : "text", ...(mssql ? { length: "MAX" } : {}) };
      break;
    case "userId": {
      const type = options.userIdType.trim().toLowerCase();
      const numeric = /^(decimal|numeric)\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(type);
      const length = /\(\s*(\d+)\s*\)/.exec(type)?.[1];
      column = {
        type: type
          .replace(/\s*\(.*\)|\s+unsigned/g, "")
          .replace(/^integer$/, "int")
          .replace(/^character varying$/, "varchar"),
        ...(numeric
          ? { precision: Number(numeric[2]), scale: Number(numeric[3]) }
          : length
            ? { length: Number(length) }
            : {}),
        ...(/unsigned/.test(type) ? { unsigned: true } : {}),
      };
      if (options.userIdCollation) column["collation"] = options.userIdCollation;
      if (options.userIdCharset) column["charset"] = options.userIdCharset;
      break;
    }
    case "experimentType":
    case "cohortType":
      column = {
        type: mssql ? "nvarchar" : pg ? "text" : "varchar",
        ...(!pg ? { length: mssql ? 20 : 32 } : {}),
      };
      break;
    default:
      column = {
        type: mssql ? "nvarchar" : pg ? "text" : "varchar",
        ...(!pg
          ? {
              length: mssql ? 255 : 191,
              collation: mssql ? "Latin1_General_100_BIN2" : "utf8mb4_0900_bin",
            }
          : {}),
      };
  }
  column["nullable"] = kind === "winner";
  if (kind === "slug") column["unique"] = true;
  return column;
}

function typeormModels(options: ResolvedSetup): string {
  const mongo = options.database === "mongodb";
  let body = "";
  for (const table of tables) {
    const fields: Record<string, Kind> = {
      ...table.fields,
      ...(mongo && table.name === "experiments" ? { version: "version" as const } : {}),
    };
    const columns: Record<string, unknown> = mongo
      ? { _id: { type: "string", objectId: true, primary: true } }
      : {};
    for (const [name, kind] of Object.entries(fields)) {
      if (!mongo) columns[name] = { name, ...sqlColumn(kind, options) };
      else
        columns[name] = {
          name,
          type: ["percentage", "version"].includes(kind)
            ? "double"
            : kind === "json"
              ? "json"
              : kind === "userId"
                ? userPrimitive(options) === "number"
                  ? "double"
                  : "string"
                : "string",
          nullable: kind === "winner",
          ...(["id", "slug"].includes(kind) ? { unique: true } : {}),
        };
    }
    const definition = {
      name: table.model,
      tableName: table.name,
      synchronize: false,
      columns,
      indices: indices(table.name).map(({ fields: cols, ...rest }) => ({ ...rest, columns: cols })),
    };
    body += `const ${table.model} = new EntitySchema(${JSON.stringify(definition, null, 2)});\n\n`;
  }
  return moduleSource(
    options,
    "typeorm",
    "EntitySchema",
    body,
    tables.map((table) => table.model),
  );
}

function mikroModels(options: ResolvedSetup): string {
  const mongo = options.database === "mongodb";
  let body = "";
  for (const table of tables) {
    const fields: Record<string, Kind> = {
      ...table.fields,
      ...(mongo && table.name === "experiments" ? { version: "version" as const } : {}),
    };
    const properties: Record<string, unknown> = mongo
      ? { _id: { type: "ObjectId", primary: true } }
      : {};
    for (const [name, kind] of Object.entries(fields)) {
      const type =
        kind === "json"
          ? "json"
          : ["percentage", "version", ...(!mongo ? ["id", "foreignId"] : [])].includes(kind)
            ? "number"
            : kind === "userId"
              ? userPrimitive(options)
              : "string";
      properties[name] = {
        type,
        fieldName: name,
        nullable: kind === "winner",
        ...(kind === "id" && !mongo ? { primary: true, autoincrement: true } : {}),
        ...(["slug", ...(mongo ? ["id"] : [])].includes(kind) ? { unique: true } : {}),
      };
      if (!mongo) {
        const sql = sqlColumn(kind, options);
        const sqlType =
          kind === "userId"
            ? options.userIdType
            : String(sql["type"]) + (sql["length"] ? `(${sql["length"]})` : "");
        Object.assign(properties[name] as object, {
          columnType: sqlType,
          ...(sql["collation"] ? { extra: `collate ${String(sql["collation"])}` } : {}),
        });
      }
    }
    const definition = {
      name: table.model,
      tableName: table.name,
      properties,
      indexes: indices(table.name)
        .filter((index) => !index.unique)
        .map((index) => ({ name: index.name, properties: index.fields })),
      uniques: indices(table.name)
        .filter((index) => index.unique)
        .map((index) => ({ properties: index.fields })),
    };
    const row = Object.entries(fields).map(([name, kind]) => {
      const type =
        kind === "json"
          ? "unknown"
          : ["percentage", "version", ...(!mongo ? ["id", "foreignId"] : [])].includes(kind)
            ? "number"
            : kind === "userId"
              ? userPrimitive(options)
              : "string";
      return `${name}: ${type}${kind === "winner" ? " | null" : ""}`;
    });
    if (mongo) row.unshift('_id: import("mongodb").ObjectId');
    const generic = options.language === "typescript" ? `<{ ${row.join("; ")} }>` : "";
    body += `const ${table.model} = new EntitySchema${generic}(${JSON.stringify(definition, null, 2)});\n\n`;
  }
  return moduleSource(
    options,
    "@mikro-orm/core",
    "EntitySchema",
    body,
    tables.map((table) => table.model),
  );
}

function mongooseModels(options: ResolvedSetup): string {
  const typed = options.language === "typescript";
  let body = "";
  for (const table of tables) {
    const fields: Record<string, Kind> = {
      ...table.fields,
      ...(table.name === "experiments" ? { version: "version" as const } : {}),
    };
    body += `const ${table.model}Schema = new Schema({\n`;
    for (const [name, kind] of Object.entries(fields)) {
      const type = ["percentage", "version"].includes(kind)
        ? "Number"
        : kind === "json"
          ? "Schema.Types.Mixed"
          : kind === "userId"
            ? userPrimitive(options) === "number"
              ? "Number"
              : "String"
            : "String";
      const attributes = [`type: ${type}`, `required: ${kind !== "winner" && kind !== "json"}`];
      if (kind === "winner" || kind === "json") attributes.push("default: null");
      if (kind === "version") attributes.push("default: 0");
      if (kind === "percentage") attributes.push("min: 0", "max: 100");
      if (["slug", "id"].includes(kind)) attributes.push("unique: true");
      if (kind === "experimentType" || kind === "cohortType")
        attributes.push(
          `enum: ${JSON.stringify(kind === "experimentType" ? STORAGE.experimentTypes : STORAGE.cohortTypes)}`,
        );
      body += `  ${name}: { ${attributes.join(", ")} },\n`;
    }
    body += `}, { collection: ${JSON.stringify(table.name)}, timestamps: false, id: false, versionKey: false, autoCreate: false, autoIndex: false });\n`;
    for (const index of indices(table.name))
      body += `${table.model}Schema.index(${JSON.stringify(Object.fromEntries(index.fields.map((field) => [field, 1])))}, ${JSON.stringify({ unique: index.unique ?? false, ...(index.name ? { name: index.name } : {}) })});\n`;
  }
  body += `\nfunction defineXpModels(connection${typed ? ': import("mongoose").Connection' : ""}) {\n  return {\n${tables.map((table) => `    ${table.model}: connection.models[${JSON.stringify(table.model)}] ?? connection.model(${JSON.stringify(table.model)}, ${table.model}Schema, ${JSON.stringify(table.name)}),`).join("\n")}\n  };\n}\n`;
  return moduleSource(options, "mongoose", "Schema", body, [
    "defineXpModels",
    ...tables.map((table) => `${table.model}Schema`),
  ]);
}

function tableTypes(options: ResolvedSetup): string {
  const kysely = options.orm === "kysely";
  const json = options.database === "mssql" ? "string" : "XpJsonValue";
  return (
    generatedHeader +
    (kysely
      ? 'import type { Generated } from "kysely";\n'
      : options.orm === "knex"
        ? 'import type { Knex } from "knex";\n'
        : "") +
    `\nexport type XpJsonValue = null | string | number | boolean | XpJsonValue[] | { [key: string]: XpJsonValue };\nexport interface XpExperimentRow {\n  id: ${kysely ? "Generated<number>" : "number"};\n  name: string;\n  slug: string;\n  type: "flag" | "simple" | "multivariate" | "dynamic";\n  description: string;\n  winner: string | null;\n}\nexport interface XpCohortRow {\n  id: ${kysely ? "Generated<number>" : "number"};\n  experiment_id: number;\n  slug: string;\n  type: "control" | "treatment";\n  description: string;\n  percentage: number;\n  value: ${json};\n}\nexport interface XpUserCohortRow {\n  id: ${kysely ? "Generated<number>" : "number"};\n  user_id: ${userPrimitive(options)};\n  experiment_id: number;\n  cohort_id: number;\n}\nexport interface XpTables {\n  experiments: XpExperimentRow;\n  cohorts: XpCohortRow;\n  user_cohorts: XpUserCohortRow;\n}\n` +
    (options.orm === "knex"
      ? '\ndeclare module "knex/types/tables.js" {\n  interface Tables {\n    experiments: Knex.CompositeTableType<XpExperimentRow>;\n    cohorts: Knex.CompositeTableType<XpCohortRow>;\n    user_cohorts: Knex.CompositeTableType<XpUserCohortRow>;\n  }\n}\n'
      : "")
  );
}

export function generateModels(options: ResolvedSetup): GeneratedArtifacts {
  const result: GeneratedArtifacts = { files: [], prerequisites: [], nextSteps: [], warnings: [] };
  if (!options.models) return result;
  let content: string;
  let filename = `xp-models.${codeExtension(options)}`;
  switch (options.orm) {
    case "sequelize":
      content = sequelizeModels(options);
      break;
    case "typeorm":
      content = typeormModels(options);
      break;
    case "mikroorm":
      content = mikroModels(options);
      break;
    case "mongoose":
      content = mongooseModels(options);
      break;
    case "kysely":
    case "knex":
    case "none":
      if (options.database === "mongodb" || options.database === "dynamodb") return result;
      content = tableTypes(options);
      filename = options.language === "typescript" ? "xp-tables.ts" : "xp-tables.d.ts";
      break;
    default:
      return result;
  }
  const path = outputPath(options.modelsDir, filename);
  result.files.push({ path, content, purpose: `Optional ${options.orm} supporting models/types` });
  if (["typeorm", "mikroorm"].includes(options.orm))
    result.prerequisites.push(
      `Register the exported EntitySchemas from ${path} in your ORM's entity list. Preserve the generated SQL constraints; use migrations rather than schema synchronization.`,
    );
  else if (["sequelize", "mongoose"].includes(options.orm))
    result.nextSteps.push(
      `Import defineXpModels from ${path} and pass your existing ${options.orm === "sequelize" ? "Sequelize instance" : "Mongoose connection"} to use the optional models.`,
    );
  else
    result.nextSteps.push(
      `Include ${path} in your TypeScript project${options.orm === "kysely" ? " and extend your application's database interface with XpTables" : ""}.`,
    );
  result.warnings.push(
    "Supporting models are for reading xp data. Apply migrations and mutate experiments through xp/server; schema sync/direct ORM writes can bypass xp integrity rules.",
  );
  return result;
}
