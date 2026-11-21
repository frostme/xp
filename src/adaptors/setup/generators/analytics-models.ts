import type { GeneratedArtifacts, ResolvedSetup } from "~/interfaces/setup";

import { analyticsMongoIndexes, analyticsTables, analyticsSqlType } from "../analyticsStorage";
import { codeExtension, generatedHeader, outputPath } from "./common";

type Table = (typeof analyticsTables)[number];
type Column = Table["columns"][number];

function prismaScalar(column: Column, database: ResolvedSetup["database"], datasource: string) {
  const optional = column.nullable ? "?" : "";
  const mongo = database === "mongodb";
  if (column.kind === "time") return (mongo ? "Float" : "BigInt") + optional;
  if (column.kind === "integer") return "Int" + optional;
  if (mongo) return "String" + optional;
  const native = column.length
    ? `VarChar(${column.length})`
    : database === "mssql"
      ? "NVarChar(Max)"
      : "Text";
  return `String${optional} @${datasource}.${native}`;
}

export function analyticsPrismaModels(
  database: ResolvedSetup["database"],
  datasource: string,
): string {
  const mongo = database === "mongodb";
  return analyticsTables
    .map((table) => {
      const fields = table.columns.map(
        (column) => `  ${column.name} ${prismaScalar(column, database, datasource)}`,
      );
      if (mongo) {
        fields.unshift(`  mongoId String @id @default(auto()) @map("_id") @${datasource}.ObjectId`);
        for (const idx of analyticsMongoIndexes(table))
          fields.push(
            `  @@${idx.unique ? "unique" : "index"}([${idx.fields.join(", ")}], map: "${idx.name}")`,
          );
      } else {
        fields.push(
          `  @@id([${table.key.join(", ")}]${database === "mysql" ? "" : `, map: "${table.name}_pk"`})`,
        );
        for (const idx of table.indexes)
          fields.push(`  @@index([${idx.fields.join(", ")}], map: "${idx.name}")`);
      }
      return `model ${table.model} {\n${fields.join("\n")}\n  @@map("${table.name}")\n}\n`;
    })
    .join("\n");
}

export function analyticsDrizzleModels(options: ResolvedSetup, declaration: string) {
  const pg = options.database === "postgres";
  return analyticsTables
    .map((table) => {
      const fields = table.columns.map((column) => {
        const name = JSON.stringify(column.name);
        let expression: string;
        if (column.kind === "time") expression = `bigint(${name}, { mode: "number" })`;
        else if (column.kind === "integer") expression = `${pg ? "integer" : "int"}(${name})`;
        else if (column.length) expression = `varchar(${name}, { length: ${column.length} })`;
        else expression = `text(${name})`;
        return `  ${column.name}: ${expression}${column.nullable ? "" : ".notNull()"},`;
      });
      const references = (cols: string[]) => cols.map((col) => "table." + col).join(", ");
      const keys = [
        `  primaryKey({ columns: [${references(table.key)}], name: "${table.name}_pk" }),`,
        ...table.indexes.map((idx) => `  index("${idx.name}").on(${references(idx.fields)}),`),
      ];
      return `\n${declaration} ${table.model} = ${pg ? "pgTable" : "mysqlTable"}("${table.name}", {\n${fields.join("\n")}\n}, (table) => [\n${keys.join("\n")}\n]);\n`;
    })
    .join("");
}

function modelFields(options: ResolvedSetup, table: Table): string {
  const mongo = options.database === "mongodb";
  const orm = options.orm;
  const fields: string[] = [];
  if (mongo && orm === "typeorm")
    fields.push('    _id: { type: "string", primary: true, objectId: true },');
  if (mongo && orm === "mikroorm") fields.push('    _id: { type: "ObjectId", primary: true },');
  for (const column of table.columns) {
    let type: string;
    const required = !column.nullable;
    const key = table.key.includes(column.name);
    if (orm === "mongoose") {
      type = `type: ${column.kind === "string" ? "String" : "Number"}, required: ${required}`;
    } else if (orm === "sequelize") {
      const dataType =
        column.kind === "time"
          ? "BIGINT"
          : column.kind === "integer"
            ? "INTEGER"
            : column.length
              ? `STRING(${column.length})`
              : "TEXT";
      type = `type: DataTypes.${dataType}, allowNull: ${!required}, primaryKey: ${key}`;
    } else if (orm === "mikroorm") {
      const scalar =
        column.kind === "string"
          ? "string"
          : column.kind === "time" && !mongo
            ? "bigint"
            : "number";
      type = `type: "${scalar}", nullable: ${!required}`;
      if (!mongo)
        type += `, columnType: "${analyticsSqlType(column, options.database).split(" COLLATE")[0]}", primary: ${key}`;
    } else {
      const columnType = mongo
        ? column.kind === "string"
          ? "string"
          : "double"
        : analyticsSqlType(column, options.database).toLowerCase().split(/[ (]/)[0];
      type = `type: "${columnType}", nullable: ${!required}`;
      if (!mongo) {
        type += `, primary: ${key}`;
        if (column.length) type += `, length: ${column.length}`;
        else if (columnType === "nvarchar") type += ', length: "MAX"';
      }
    }
    fields.push(`    ${column.name}: { ${type} },`);
  }
  return fields.join("\n");
}

function modelSource(options: ResolvedSetup): string {
  const esm = options.language === "typescript" || options.moduleFormat === "esm";
  const ts = options.language === "typescript";
  const packages: Record<string, [string, string]> = {
    sequelize: ["sequelize", "DataTypes"],
    mongoose: ["mongoose", "Schema"],
    typeorm: ["typeorm", "EntitySchema"],
    mikroorm: ["@mikro-orm/core", "EntitySchema"],
  };
  const [pkg, symbol] = packages[options.orm]!;
  let code = esm
    ? `import { ${symbol} } from "${pkg}";\n`
    : `const { ${symbol} } = require("${pkg}");\n`;
  const factory = options.orm === "mongoose" || options.orm === "sequelize";
  if (factory) {
    const connectionType =
      options.orm === "mongoose"
        ? 'import("mongoose").Connection'
        : 'import("sequelize").Sequelize';
    code += `\nfunction defineXpAnalyticsModels(connection${ts ? ": " + connectionType : ""}) {\n`;
  }
  for (const table of analyticsTables) {
    const fields = modelFields(options, table);
    const indexes =
      options.database === "mongodb"
        ? analyticsMongoIndexes(table)
        : table.indexes.map((idx) => ({ ...idx, unique: false }));
    switch (options.orm) {
      case "sequelize":
        code += `  const ${table.model} = connection.define("${table.model}", {\n${fields}\n  }, { tableName: "${table.name}", freezeTableName: true, timestamps: false, indexes: ${JSON.stringify(indexes)} });\n`;
        break;
      case "mongoose": {
        const schema = table.model + "Schema";
        code += `  const ${schema} = new Schema({\n${fields}\n  }, { collection: "${table.name}", timestamps: false, versionKey: false, autoIndex: false, autoCreate: false });\n`;
        for (const idx of indexes)
          code += `  ${schema}.index(${JSON.stringify(Object.fromEntries(idx.fields.map((field) => [field, 1])))}, { unique: ${idx.unique}, name: "${idx.name}" });\n`;
        code += `  const ${table.model} = connection.models.${table.model} ?? connection.model("${table.model}", ${schema});\n`;
        break;
      }
      case "typeorm": {
        const definitions = indexes.map((idx) => ({
          name: idx.name,
          columns: idx.fields,
          unique: idx.unique,
        }));
        code += `const ${table.model} = new EntitySchema({ name: "${table.model}", tableName: "${table.name}", synchronize: false, columns: {\n${fields}\n}, indices: ${JSON.stringify(definitions)} });\n`;
        break;
      }
      case "mikroorm": {
        const definitions = (unique: boolean) =>
          indexes
            .filter((idx) => idx.unique === unique)
            .map((idx) => ({ name: idx.name, properties: idx.fields }));
        const row = table.columns.map(
          (col) =>
            `${col.name}: ${col.kind === "string" ? "string" : col.kind === "time" && options.database !== "mongodb" ? "bigint" : "number"}${col.nullable ? " | null" : ""}`,
        );
        if (options.database === "mongodb") row.unshift('_id: import("mongodb").ObjectId');
        code += `const ${table.model} = new EntitySchema${ts ? `<{ ${row.join("; ")} }>` : ""}({ name: "${table.model}", tableName: "${table.name}", properties: {\n${fields}\n}, indexes: ${JSON.stringify(definitions(false))}, uniques: ${JSON.stringify(definitions(true))} });\n`;
        break;
      }
    }
  }
  const names = analyticsTables.map((table) => table.model).join(", ");
  if (factory) code += `  return { ${names} };\n}\n`;
  return (
    code +
    (esm ? "export" : "module.exports =") +
    ` { ${factory ? "defineXpAnalyticsModels" : names} };\n`
  );
}

export function generateAnalyticsModels(options: ResolvedSetup): GeneratedArtifacts {
  const result: GeneratedArtifacts = { files: [], warnings: [], prerequisites: [], nextSteps: [] };
  if (
    !options.models ||
    ["prisma", "drizzle"].includes(options.orm) ||
    options.database === "dynamodb"
  )
    return result;
  let filename = "xp-analytics-models." + codeExtension(options);
  let content: string;
  if (["kysely", "knex", "none"].includes(options.orm)) {
    if (options.database === "mongodb") return result;
    filename =
      options.language === "typescript" ? "xp-analytics-tables.ts" : "xp-analytics-tables.d.ts";
    content = analyticsTables
      .map((table) => {
        const fields = table.columns.map(
          (col) =>
            `  ${col.name}: ${col.kind === "string" ? "string" : col.kind === "time" ? "string | number | bigint" : "number"}${col.nullable ? " | null" : ""};`,
        );
        return `export interface ${table.model}Row {\n${fields.join("\n")}\n}`;
      })
      .join("\n");
    content += `\nexport interface XpAnalyticsTables {\n${analyticsTables.map((table) => `  ${table.name}: ${table.model}Row;`).join("\n")}\n}\n`;
    if (options.orm === "knex")
      content +=
        'declare module "knex/types/tables.js" { interface Tables extends XpAnalyticsTables {} }\n';
  } else content = modelSource(options);
  const path = outputPath(options.modelsDir, filename);
  result.files.push({
    path,
    content: generatedHeader + content,
    purpose: `Optional ${options.orm} analytics outbox models/types`,
  });
  result.nextSteps.push(
    `Use the generated read models or types in ${path} for analytics storage. Apply migrations through your host, and leave ORM schema synchronization disabled.`,
  );
  return result;
}
