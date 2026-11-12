import type { GeneratedArtifacts, ProjectDetection, ResolvedSetup } from "~/interfaces/setup";

import { renderSql } from "../storage";
import {
  codeExtension,
  command,
  generatedHeader,
  migrationStamp,
  nativeGuidance,
  outputPath,
  sqlHeader,
  shellQuote,
} from "./common";

export function generateSql(options: ResolvedSetup, project: ProjectDetection): GeneratedArtifacts {
  const { up, down } = renderSql(options);
  const stamp = migrationStamp();
  const result: GeneratedArtifacts = { files: [], warnings: [], prerequisites: [], nextSteps: [] };
  const directory = options.migrationsDir;
  const typed = options.language === "typescript";
  const esm = typed || options.moduleFormat === "esm";
  let name = `${stamp}_xp_setup.${codeExtension(options)}`;
  let code = "";
  if (options.orm === "none") {
    const upPath = outputPath(directory, `${stamp}_xp_setup.up.sql`);
    result.files.push(
      { path: upPath, content: sqlHeader + up.join("\n\n") + "\n", purpose: "Create xp storage" },
      {
        path: outputPath(directory, `${stamp}_xp_setup.down.sql`),
        content:
          sqlHeader + "-- Application users are deliberately preserved.\n" + down.join("\n") + "\n",
        purpose: "Remove xp-owned storage; preserve users",
      },
    );
    result.nextSteps.push(
      `Apply ${upPath} using your normal ${options.database} SQL client or deployment migration process.`,
    );
  } else if (options.orm === "sequelize") {
    name = `${stamp}_xp_setup.cjs`;
    code = `"use strict";\n\nmodule.exports = {\n  async up(queryInterface) {\n${up.map((sql) => `    await queryInterface.sequelize.query(${JSON.stringify(sql)});`).join("\n")}\n  },\n  async down(queryInterface) {\n    // Preserve the application users table, including one scaffolded by setup.\n${down.map((sql) => `    await queryInterface.sequelize.query(${JSON.stringify(sql)});`).join("\n")}\n  },\n};\n`;
    if (typed || options.moduleFormat === "esm")
      result.warnings.push(
        "Sequelize CLI v6 migrations are emitted as CommonJS .cjs; supporting models retain the selected project language/module format.",
      );
    if (!project.versions["sequelize-cli"])
      result.prerequisites.push("Install sequelize-cli v6 to run the generated migration.");
    result.nextSteps.push(
      `${command(project, "sequelize-cli")} db:migrate --migrations-path ${shellQuote(directory)}${options.config ? ` --config ${shellQuote(options.config)}` : ""}`,
    );
  } else if (options.orm === "typeorm") {
    const timestamp = Date.now();
    const className = `XpSetup${timestamp}`;
    name = `${timestamp}-XpSetup.${codeExtension(options)}`;
    code =
      (typed ? `import type { MigrationInterface, QueryRunner } from "typeorm";\n\n` : "") +
      `${esm ? "export " : ""}class ${className}${typed ? " implements MigrationInterface" : ""} {\n  name = ${JSON.stringify(className)};\n  async up(queryRunner${typed ? ": QueryRunner" : ""})${typed ? ": Promise<void>" : ""} {\n${up.map((sql) => `    await queryRunner.query(${JSON.stringify(sql)});`).join("\n")}\n  }\n  async down(queryRunner${typed ? ": QueryRunner" : ""})${typed ? ": Promise<void>" : ""} {\n${down.map((sql) => `    await queryRunner.query(${JSON.stringify(sql)});`).join("\n")}\n  }\n}\n${esm ? "" : `module.exports = { ${className} };\n`}`;
    result.prerequisites.push(
      `Ensure ${outputPath(directory, name)} is included in your TypeORM DataSource migrations list or glob (including its file extension); provide the DataSource path with -d when running migrations.`,
    );
    result.nextSteps.push(
      `${command(project, typed ? (options.moduleFormat === "commonjs" ? "typeorm-ts-node-commonjs" : "typeorm-ts-node-esm") : "typeorm")} migration:run -d ${shellQuote(options.config ?? "path/to/data-source")}`,
    );
  } else if (options.orm === "mikroorm") {
    const className = `Migration${stamp}_xp_setup`;
    name = `${className}.${codeExtension(options)}`;
    code = `${esm ? 'import { Migration } from "@mikro-orm/migrations";' : 'const { Migration } = require("@mikro-orm/migrations");'}\n\n${esm ? "export " : ""}class ${className} extends Migration {\n  ${typed ? "override " : ""}async up()${typed ? ": Promise<void>" : ""} {\n${up.map((sql) => `    this.addSql(${JSON.stringify(sql)});`).join("\n")}\n  }\n  ${typed ? "override " : ""}async down()${typed ? ": Promise<void>" : ""} {\n${down.map((sql) => `    this.addSql(${JSON.stringify(sql)});`).join("\n")}\n  }\n}\n${esm ? "" : `module.exports = { ${className} };\n`}`;
    result.files.push({
      path: outputPath(".xp", "mikroorm-schema-options.json"),
      purpose: "Exclude xp-owned tables from automatic MikroORM schema diffing",
      content:
        JSON.stringify(
          { schemaGenerator: { skipTables: ["experiments", "cohorts", "user_cohorts"] } },
          null,
          2,
        ) + "\n",
    });
    result.prerequisites.push(
      "Merge .xp/mikroorm-schema-options.json into your MikroORM configuration, preserving any existing schemaGenerator.skipTables entries. Canonical xp migrations own these tables; automatic schema diffing must exclude them.",
    );
    if (!project.versions["@mikro-orm/migrations"])
      result.prerequisites.push(
        "Install @mikro-orm/migrations v7 and register its Migrator extension in your MikroORM config.",
      );
    result.nextSteps.push(
      `Ensure MikroORM migrations.path${typed ? "Ts" : ""} includes ${directory}, then run ${command(project, "mikro-orm")} migration:up${options.config ? ` --config ${shellQuote(options.config)}` : ""}.`,
    );
  } else if (options.orm === "knex" || options.orm === "kysely") {
    const kysely = options.orm === "kysely";
    const input = kysely ? "db" : "knex";
    code = kysely
      ? `${esm ? 'import { sql } from "kysely";' : 'const { sql } = require("kysely");'}\n${typed ? 'import type { Kysely } from "kysely";\n' : ""}`
      : typed
        ? 'import type { Knex } from "knex";\n'
        : "";
    for (const [method, statements] of [
      ["up", up],
      ["down", down],
    ] as const) {
      code += `\n${esm ? "export " : ""}async function ${method}(${input}${typed ? (kysely ? ": Kysely<unknown>" : ": Knex") : ""})${typed ? ": Promise<void>" : ""} {\n${statements.map((sql) => `  await ${kysely ? `sql.raw(${JSON.stringify(sql)}).execute(db)` : `knex.raw(${JSON.stringify(sql)})`};`).join("\n")}\n}\n`;
    }
    if (!esm) code += "\nmodule.exports = { up, down };\n";
    result.nextSteps.push(
      kysely
        ? `Include ${directory} in your existing Kysely FileMigrationProvider and run your application's Migrator.migrateToLatest().`
        : `${command(project, "knex")} migrate:latest --migrations-directory ${shellQuote(directory)}${options.config ? ` --knexfile ${shellQuote(options.config)}` : ""}`,
    );
    if (kysely)
      result.prerequisites.push(
        "Use your application's Kysely migration runner with the generated directory; Kysely does not include a universal migration CLI.",
      );
  } else {
    throw new Error(
      `SQL migration generation for ${options.orm} belongs to its dedicated generator.`,
    );
  }
  if (code)
    result.files.push({
      path: outputPath(directory, name),
      content: generatedHeader + code,
      purpose: `${options.orm} xp storage migration`,
    });
  if (options.database === "mysql")
    result.warnings.push(
      "MySQL DDL is not transactional. Review the migration and recover partial DDL explicitly if applying it fails.",
    );
  if (options.userStorage === "create")
    result.warnings.push(
      "Rollback preserves the scaffolded users table to protect application user records.",
    );
  if (typed && options.orm !== "sequelize" && options.orm !== "none")
    result.nextSteps.push(
      "Use the project's configured TypeScript migration loader, or compile the migration before deployment.",
    );
  result.nextSteps.push(nativeGuidance(options));
  return result;
}
