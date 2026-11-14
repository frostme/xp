// Compile and load generated integrations against their pinned supported toolchains.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import console from "node:console";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL, URL } from "node:url";

import { generateStandard } from "../dist/adaptors/setup/generators/standard.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary =
  process.env.XP_GENERATOR_FIXTURE ?? (await mkdtemp(join(tmpdir(), "xp-generators-")));
const versions = {
  sequelize: "6.37.8",
  "sequelize-cli": "6.6.5",
  typeorm: "1.1.3",
  "@mikro-orm/core": "7.2.9",
  "@mikro-orm/migrations": "7.2.9",
  "@mikro-orm/migrations-mongodb": "7.2.9",
  "@mikro-orm/postgresql": "7.2.9",
  "@mikro-orm/mysql": "7.2.9",
  "@mikro-orm/mssql": "7.2.9",
  "@mikro-orm/mongodb": "7.2.9",
  kysely: "0.29.9",
  knex: "3.3.0",
  mongoose: "9.12.1",
  mongodb: "7.8.0",
  pg: "8.23.1",
  mysql2: "3.24.6",
  mssql: "12.7.14",
  "@types/node": "26.6.5",
  "@types/pg": "8.23.1",
};
const project = {
  cwd: temporary,
  options: {},
  ormCandidates: [],
  databaseCandidates: [],
  versions,
  packageManager: "bun",
  sources: [],
  warnings: [],
  missing: [],
  inputs: {},
};
let count = 0;
try {
  await writeFile(
    join(temporary, "package.json"),
    JSON.stringify({ private: true, type: "module", dependencies: versions }),
  );
  execFileSync("bun", ["install", "--ignore-scripts"], { cwd: temporary, stdio: "pipe" });
  const req = createRequire(join(temporary, "package.json"));
  const combinations = [
    ...["postgres", "mysql", "mssql"].flatMap((database) =>
      ["sequelize", "typeorm", "mikroorm", "kysely", "knex", "none"].map((orm) => ({
        database,
        orm,
      })),
    ),
    ...["mongoose", "typeorm", "mikroorm", "none"].map((orm) => ({ database: "mongodb", orm })),
    { database: "dynamodb", orm: "none" },
  ];
  for (const { database, orm } of combinations) {
    for (const [language, moduleFormat] of [
      ["typescript", "esm"],
      ["typescript", "commonjs"],
      ["javascript", "esm"],
      ["javascript", "commonjs"],
    ]) {
      const directory = `${database}-${orm}-${language}-${moduleFormat}`;
      await mkdir(join(temporary, directory), { recursive: true });
      await writeFile(
        join(temporary, directory, "package.json"),
        JSON.stringify({ type: moduleFormat === "esm" ? "module" : "commonjs" }),
      );
      const options = {
        cwd: temporary,
        database,
        orm,
        models: true,
        modelsDir: `${directory}/models`,
        migrationsDir: `${directory}/migrations`,
        language,
        moduleFormat,
        userStorage: "reuse",
        userIdType:
          database === "postgres"
            ? "text"
            : database === "mysql"
              ? "varchar(191)"
              : database === "mssql"
                ? "nvarchar(255)"
                : "string",
        tableName: "xp-smoke",
      };
      const artifacts = await generateStandard(options, project);
      const typeFiles = [];
      for (const file of artifacts.files) {
        const path = join(temporary, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.content);
        if (path.endsWith(".ts")) typeFiles.push(path);
        else if (/\.(cjs|mjs|js)$/.test(path)) {
          const loaded = await import(pathToFileURL(path).href);
          assert.ok(Object.keys(loaded).length > 0, `No exports in ${file.path}`);
          if (file.path.includes("models") && orm === "sequelize") {
            const { Sequelize } = req("sequelize");
            const sequelize = new Sequelize("postgres://unused:unused@localhost/unused", {
              dialect: database === "postgres" ? "postgres" : database,
              logging: false,
            });
            const models = (loaded.defineXpModels ?? loaded.default.defineXpModels)(sequelize);
            assert.equal(models.XpExperiment.getTableName(), "experiments");
            await sequelize.close();
          }
          if (file.path.includes("models") && orm === "typeorm") {
            const { DataSource } = req("typeorm");
            const entities = Object.values(loaded.default ?? loaded);
            const source = new DataSource({
              type: database,
              host: "localhost",
              database: "unused",
              entities,
              synchronize: false,
            });
            await source.buildMetadatas();
            assert.equal(source.entityMetadatas.length, 3);
            const experiment = source.getMetadata("XpExperiment");
            assert.equal(experiment.tableName, "experiments");
            if (database === "mongodb") {
              assert.equal(experiment.objectIdColumn.databaseName, "_id");
              assert.equal(
                experiment.columns.find((column) => column.propertyName === "id").databaseName,
                "id",
              );
            }
          }
          if (file.path.includes("models") && orm === "mikroorm") {
            const driverPackage = database === "postgres" ? "postgresql" : database;
            const { MikroORM } = req(`@mikro-orm/${driverPackage}`);
            const ormInstance = await MikroORM.init({
              dbName: "unused",
              entities: Object.values(loaded.default ?? loaded),
              connect: false,
            });
            assert.equal(ormInstance.getMetadata().get("XpExperiment").tableName, "experiments");
            if (database === "mongodb") {
              const metadata = ormInstance.getMetadata().get("XpExperiment");
              assert.equal(metadata.properties.id.fieldNames[0], "id");
              assert.equal(metadata.serializedPrimaryKey, undefined);
            }
            await ormInstance.close(true);
          }
          if (file.path.includes("models") && orm === "mongoose") {
            const mongoose = req("mongoose");
            const connection = mongoose.createConnection();
            const models = (loaded.defineXpModels ?? loaded.default.defineXpModels)(connection);
            assert.equal(models.XpExperiment.collection.name, "experiments");
            assert.equal(models.XpExperiment.schema.options.autoCreate, false);
            await connection.close();
          }
        }
      }
      if (typeFiles.length) {
        execFileSync(
          join(root, "node_modules/.bin/tsc"),
          [
            "--noEmit",
            "--strict",
            "--skipLibCheck",
            "--target",
            "es2022",
            "--module",
            "nodenext",
            "--moduleResolution",
            "nodenext",
            "--types",
            "node",
            ...typeFiles,
          ],
          { cwd: temporary, stdio: "pipe" },
        );
      }
      count += 1;
    }
  }
  console.log(`Generated artifact smoke passed: ${count} provider/tool/language combinations.`);
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout);
  if (error.stderr) process.stderr.write(error.stderr);
  console.error(`Generator validation fixture retained at ${temporary}`);
  process.exitCode = 1;
  console.error(error.message?.split("\n")[0] ?? "Generator validation failed.");
} finally {
  if (!process.exitCode && !process.env.XP_GENERATOR_FIXTURE)
    await rm(temporary, { recursive: true, force: true });
}
