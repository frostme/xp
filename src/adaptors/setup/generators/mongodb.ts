import type { GeneratedArtifacts, ProjectDetection, ResolvedSetup } from "~/interfaces/setup";

import { MONGO_INDEXES, STORAGE } from "../storage";
import {
  codeExtension,
  command,
  generatedHeader,
  migrationStamp,
  nativeGuidance,
  outputPath,
  shellQuote,
} from "./common";

function provisionBody(options: ResolvedSetup): string {
  if (!["string", "number"].includes(options.userIdType))
    throw new Error(
      "MongoDB users.id must be a primitive string or number; use --user-id-type string or number.",
    );
  return `  const topology = await db.admin().command({ hello: 1 });\n  if (!topology.setName && topology.msg !== "isdbgrid") {\n    throw new Error("xp requires a MongoDB replica set or sharded cluster supporting transactions.");\n  }\n  const collections = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((entry${options.language === "typescript" && options.orm === "mikroorm" ? ": { name: string }" : ""}) => entry.name));\n${options.userStorage === "reuse" ? '  if (!collections.has("users")) throw new Error("Create the application users collection before provisioning xp, or explicitly choose user-storage=create.");\n' : ""}  if (collections.has("users")) {\n    const incompatible = await db.collection("users").findOne({ $or: [{ id: { $type: "array" } }, { id: { $not: { $type: ${JSON.stringify(options.userIdType)} } } }] });\n    if (incompatible) throw new Error("Every participating user needs a compatible physical users.id; ObjectId _id alone is insufficient. Map identities explicitly before provisioning.");\n  }\n  for (const name of ${JSON.stringify([...STORAGE.ownedTables, ...(options.userStorage === "create" ? ["users"] : [])])}) {\n    if (!collections.has(name)) await db.createCollection(name);\n  }\n  const indexes${options.language === "typescript" && options.orm === "mikroorm" ? ": { collection: string; key: Record<string, 1>; unique: boolean }[]" : ""} = ${JSON.stringify(MONGO_INDEXES, null, 2)};\n  for (const index of indexes) {\n    await db.collection(index.collection).createIndex(index.key, { unique: index.unique });\n  }`;
}

export function generateMongoBootstrap(
  options: ResolvedSetup,
  project: ProjectDetection,
): GeneratedArtifacts {
  const esm = options.moduleFormat === "esm";
  const filename = outputPath(options.migrationsDir, `xp-bootstrap.${esm ? "mjs" : "cjs"}`);
  const body = provisionBody({ ...options, language: "javascript" });
  const content =
    generatedHeader +
    `${esm ? 'import { MongoClient } from "mongodb";\nimport { pathToFileURL } from "node:url";\nimport process from "node:process";' : 'const { MongoClient } = require("mongodb");'}\n\n${esm ? "export " : ""}async function up(db) {\n${body}\n}\n\nasync function main() {\n  const uri = process.env.XP_MONGODB_URL;\n  const database = process.env.XP_MONGODB_DATABASE;\n  if (!uri || !database) throw new Error("Set XP_MONGODB_URL and XP_MONGODB_DATABASE explicitly.");\n  const client = new MongoClient(uri);\n  try {\n    await client.connect();\n    await up(client.db(database));\n    console.log("xp collections and indexes provisioned.");\n  } finally {\n    await client.close();\n  }\n}\n\n${esm ? "if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)" : "module.exports = { up };\nif (require.main === module)"} {\n  main().catch(() => {\n    // Do not print driver errors: connection strings may contain credentials.\n    console.error("xp provisioning failed. Verify topology, users.id, permissions, and existing indexes in your database tooling.");\n    process.exitCode = 1;\n  });\n}\n`;
  return {
    files: [
      { path: filename, content, purpose: "Explicit MongoDB collection and index bootstrap" },
    ],
    warnings: [
      "MongoDB requires a replica set or sharded cluster. Provisioning never backfills or converts application identities.",
    ],
    prerequisites: project.versions["mongodb"]
      ? []
      : ["Install the mongodb native driver before running the bootstrap or using xp/server."],
    nextSteps: [
      `Set XP_MONGODB_URL and XP_MONGODB_DATABASE, then run node ${shellQuote(filename)} to provision the collections and indexes.`,
      nativeGuidance(options),
    ],
  };
}

export function generateMongoMigration(
  options: ResolvedSetup,
  project: ProjectDetection,
): GeneratedArtifacts {
  if (options.orm !== "mikroorm") return generateMongoBootstrap(options, project);
  const typed = options.language === "typescript";
  const esm = typed || options.moduleFormat === "esm";
  const name = `Migration${migrationStamp()}_xp_setup`;
  const path = outputPath(options.migrationsDir, `${name}.${codeExtension(options)}`);
  const content =
    generatedHeader +
    `${esm ? 'import { Migration } from "@mikro-orm/migrations-mongodb";' : 'const { Migration } = require("@mikro-orm/migrations-mongodb");'}\n\n${esm ? "export " : ""}class ${name} extends Migration {\n  ${typed ? "override " : ""}isTransactional()${typed ? ": boolean" : ""} { return false; }\n  ${typed ? "override " : ""}async up()${typed ? ": Promise<void>" : ""} {\n    const db = this.getDb();\n${provisionBody(options)}\n  }\n  ${typed ? "override " : ""}async down()${typed ? ": Promise<void>" : ""} {\n    // Application users are deliberately preserved.\n    for (const name of ${JSON.stringify([...STORAGE.ownedTables].reverse())}) {\n      await this.getDb().collection(name).drop();\n    }\n  }\n}\n${esm ? "" : `module.exports = { ${name} };\n`}`;
  return {
    files: [{ path, content, purpose: "MikroORM MongoDB collection and index migration" }],
    warnings: [
      "Collection/index provisioning runs outside a transaction. MongoDB still requires a replica set for xp runtime operations.",
    ],
    prerequisites: project.versions["@mikro-orm/migrations-mongodb"]
      ? []
      : ["Install @mikro-orm/migrations-mongodb v7 and register its Migrator extension."],
    nextSteps: [
      `Configure MikroORM migrations.path${typed ? "Ts" : ""} for ${options.migrationsDir}, then run ${command(project, "mikro-orm")} migration:up${options.config ? ` --config ${shellQuote(options.config)}` : ""}.`,
      nativeGuidance(options),
    ],
  };
}
