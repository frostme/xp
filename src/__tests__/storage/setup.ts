import type { Db } from "mongodb";

import { createRequire } from "node:module";

import type { ProjectDetection, ResolvedSetup, SetupDatabase } from "~/interfaces/setup";

import { generateDynamo } from "~/adaptors/setup/generators/dynamodb";
import { generateMongoBootstrap } from "~/adaptors/setup/generators/mongodb";
import { renderAvailabilityUpgrade, renderSql } from "~/adaptors/setup/storage";

export function setupOptions(database: SetupDatabase): ResolvedSetup {
  return {
    cwd: ".",
    orm: "none",
    database,
    migrationsDir: "migrations",
    models: false,
    modelsDir: "models",
    language: "javascript",
    moduleFormat: "commonjs",
    userStorage: "create",
    tableName: "xp",
    userIdType:
      database === "postgres"
        ? "TEXT"
        : database === "mysql"
          ? "VARCHAR(191)"
          : database === "mssql"
            ? "NVARCHAR(255)"
            : "string",
    ...(database === "mysql"
      ? { userIdCharset: "utf8mb4", userIdCollation: "utf8mb4_0900_bin" }
      : {}),
    ...(database === "mssql" ? { userIdCollation: "Latin1_General_100_BIN2" } : {}),
  };
}

/** Integration fixtures consume the same storage output shipped by xp setup. */
export function generatedSql(database: SetupDatabase, version: 1 | 2 = 2): string {
  return renderSql(setupOptions(database), { version }).up.join("\n");
}

export function generatedUpgrade(database: SetupDatabase): string[] {
  return renderAvailabilityUpgrade(setupOptions(database)).up;
}

export async function generatedMongo(db: Db, analytics = false): Promise<void> {
  const options = setupOptions("mongodb");
  const project: ProjectDetection = {
    cwd: ".",
    options,
    ormCandidates: [],
    databaseCandidates: ["mongodb"],
    versions: { mongodb: "7.8.0" },
    packageManager: "bun",
    sources: [],
    warnings: [],
    missing: [],
    inputs: {},
  };
  const artifact = generateMongoBootstrap(options, project, analytics).files[0]!;
  const module = { exports: {} as { up(db: Db): Promise<void> } };
  // Exercise the generated executable's exported function without running its command entry point.
  const load = new Function("require", "module", artifact.content);
  load(createRequire(import.meta.url), module);
  await module.exports.up(db);
}

export function generatedDynamo(tableName: string) {
  const artifact = generateDynamo({ ...setupOptions("dynamodb"), tableName }).files[0]!;
  return JSON.parse(artifact.content);
}
