import { glob, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { GeneratedArtifacts, ProjectDetection, ResolvedSetup } from "~/interfaces/setup";

import { renderSql, STORAGE_VERSION } from "../storage";
import { shellQuote } from "./common";
import { generateMongoBootstrap } from "./mongodb";
import { patchPrismaConfig } from "./prisma-config";
import {
  command,
  localPackage,
  maskComments,
  prismaBlocks,
  readInput,
  runLocal,
  type SchemaBlock,
} from "./schema-utils";

interface UserModel {
  file: string;
  block: SchemaBlock;
  field: string;
  type: string;
  native: string;
}

function scalar(options: ResolvedSetup): { type: string; native: string } {
  if (options.database === "mongodb")
    return { type: options.userIdType === "number" ? "Float" : "String", native: "" };
  const declaration = options.userIdType.toLowerCase().replace(/\s+/g, " ").trim();
  const size = /\(([^)]+)\)/.exec(declaration)?.[1]?.replace(/\s/g, "");
  const name = declaration.replace(/\s*\(.*/, "").replace(/ unsigned$/, "");
  const unsigned = /unsigned$/.test(declaration);
  const types: Record<string, { type: string; native: string }> = {
    text: { type: "String", native: "@db.Text" },
    uuid: { type: "String", native: "@db.Uuid" },
    uniqueidentifier: { type: "String", native: "@db.UniqueIdentifier" },
    integer: {
      type: "Int",
      native:
        options.database === "postgres"
          ? "@db.Integer"
          : unsigned && options.database === "mysql"
            ? "@db.UnsignedInt"
            : "@db.Int",
    },
    int: {
      type: "Int",
      native:
        options.database === "postgres"
          ? "@db.Integer"
          : unsigned && options.database === "mysql"
            ? "@db.UnsignedInt"
            : "@db.Int",
    },
    smallint: { type: "Int", native: unsigned ? "@db.UnsignedSmallInt" : "@db.SmallInt" },
    tinyint: { type: "Int", native: unsigned ? "@db.UnsignedTinyInt" : "@db.TinyInt" },
    mediumint: { type: "Int", native: unsigned ? "@db.UnsignedMediumInt" : "@db.MediumInt" },
    bigint: { type: "BigInt", native: unsigned ? "@db.UnsignedBigInt" : "@db.BigInt" },
    varchar: { type: "String", native: `@db.VarChar(${size})` },
    "character varying": { type: "String", native: `@db.VarChar(${size})` },
    char: { type: "String", native: `@db.Char(${size})` },
    character: { type: "String", native: `@db.Char(${size})` },
    nvarchar: { type: "String", native: `@db.NVarChar(${size})` },
    nchar: { type: "String", native: `@db.NChar(${size})` },
    decimal: { type: "Decimal", native: `@db.Decimal(${size})` },
    numeric: { type: "Decimal", native: `@db.Decimal(${size})` },
  };
  const result = types[name];
  if (!result || /undefined/.test(result.native))
    throw new Error(
      `Prisma cannot represent the selected users.id type: ${options.userIdType}. Use native SQL output or a supported scalar key.`,
    );
  return result;
}

function existingUser(files: Map<string, string>, options: ResolvedSetup): UserModel | null {
  const found: UserModel[] = [];
  for (const [file, source] of files) {
    for (const block of prismaBlocks(source).filter((item) => item.kind === "model")) {
      const body = maskComments(block.body);
      const mapped = /@@map\(\s*"([^"]+)"\s*\)/.exec(body)?.[1] ?? block.name;
      if (
        ["experiments", "cohorts", "user_cohorts"].includes(mapped) ||
        /^Xp(?:Experiment|Cohort|UserCohort)$/.test(block.name)
      ) {
        throw new Error(
          `Prisma model ${block.name} already maps an xp table. Initial setup will not rewrite an existing xp schema.`,
        );
      }
      if (mapped !== "users") continue;
      for (const line of body.split("\n")) {
        const field = /^\s*(\w+)\s+(\w+)([?[\]]*)\s*(.*)$/.exec(line);
        if (!field) continue;
        const physical = /(?<!@)@map\(\s*"([^"]+)"\s*\)/.exec(field[4]!)?.[1] ?? field[1];
        if (physical !== "id") continue;
        if (field[3])
          throw new Error(
            `Prisma ${block.name}.${field[1]} must be a required scalar mapping to users.id.`,
          );
        const unique =
          /@(?:id|unique)\b/.test(field[4]!) ||
          new RegExp(`@@(?:id|unique)\\(\\s*\\[\\s*${field[1]}\\s*\\]`).test(body);
        if (!unique)
          throw new Error(`Prisma ${block.name}.${field[1]} must be unique to reference users.id.`);
        const native = /@\w+\.\w+(?:\([^)]*\))?/.exec(field[4]!)?.[0] ?? "";
        if (
          options.database === "mongodb" &&
          field[2] !== "String" &&
          field[2] !== "Float" &&
          field[2] !== "Int"
        ) {
          throw new Error(
            "MongoDB users.id must be a primitive string or number, separate from _id.",
          );
        }
        found.push({ file, block, field: field[1]!, type: field[2]!, native });
      }
    }
  }
  if (found.length > 1)
    throw new Error(
      "Several Prisma models map users.id; select a schema with a single application user model.",
    );
  return found[0] ?? null;
}

function sqlModels(
  options: ResolvedSetup,
  userName: string,
  userField: string,
  userType: string,
): string {
  const pg = options.database === "postgres";
  const ms = options.database === "mssql";
  const text = ms ? "@db.NVarChar(Max)" : "@db.Text";
  const slug = pg ? "@db.Text" : ms ? "@db.NVarChar(255)" : "@db.VarChar(191)";
  const enumType = pg ? "@db.Text" : ms ? "@db.NVarChar(20)" : "@db.VarChar(32)";
  const float = pg ? "@db.DoublePrecision" : ms ? "@db.Float(53)" : "@db.Double";
  const json = pg
    ? 'Json @default("null") @db.JsonB'
    : ms
      ? 'String @default("null", map: "cohorts_value_df") @db.NVarChar(Max)'
      : "Json";
  return `// xp storage schema v${STORAGE_VERSION}. Apply the accompanying SQL migration; preserve its CHECK constraints/collations.\nmodel XpExperiment {\n  id Int @id @default(autoincrement())\n  name String ${text}\n  slug String @unique ${slug}\n  type String ${enumType}\n  description String ${text}\n  winner String? ${slug}\n  cohorts XpCohort[]\n  assignments XpUserCohort[]\n  @@map("experiments")\n}\n\nmodel XpCohort {\n  id Int @id @default(autoincrement())\n  experimentId Int @map("experiment_id")\n  slug String @unique ${slug}\n  type String ${enumType}\n  description String ${text}\n  percentage Float ${float}\n  value ${json}\n  experiment XpExperiment @relation(fields: [experimentId], references: [id], onDelete: NoAction, onUpdate: NoAction)\n  assignments XpUserCohort[]\n  @@unique([id, experimentId])\n  @@index([experimentId], map: "cohorts_experiment_id_idx")\n  @@map("cohorts")\n}\n\nmodel XpUserCohort {\n  id Int @id @default(autoincrement())\n  userId ${userType} @map("user_id")\n  experimentId Int @map("experiment_id")\n  cohortId Int @map("cohort_id")\n  user ${userName} @relation(fields: [userId], references: [${userField}], onDelete: NoAction, onUpdate: NoAction)\n  experiment XpExperiment @relation(fields: [experimentId], references: [id], onDelete: NoAction, onUpdate: NoAction)\n  cohort XpCohort @relation(fields: [cohortId, experimentId], references: [id, experimentId], onDelete: NoAction, onUpdate: NoAction)\n  @@unique([userId, experimentId])\n  @@index([experimentId], map: "user_cohorts_experiment_id_idx")\n  @@index([cohortId], map: "user_cohorts_cohort_id_idx")\n  @@map("user_cohorts")\n}\n`;
}

function mongoModels(userType: string): string {
  return `// xp storage schema v${STORAGE_VERSION}. _id and the primitive xp id are separate identities.\nmodel XpExperiment {\n  mongoId String @id @default(auto()) @map("_id") @db.ObjectId\n  id String @unique(map: "id_1")\n  name String\n  slug String @unique(map: "slug_1")\n  type String\n  description String\n  winner String?\n  version Int @default(0)\n  @@map("experiments")\n}\n\nmodel XpCohort {\n  mongoId String @id @default(auto()) @map("_id") @db.ObjectId\n  id String @unique(map: "id_1")\n  experimentId String @map("experiment_id")\n  slug String @unique(map: "slug_1")\n  type String\n  description String\n  percentage Float\n  value Json?\n  @@index([experimentId], map: "experiment_id_1")\n  @@map("cohorts")\n}\n\nmodel XpUserCohort {\n  mongoId String @id @default(auto()) @map("_id") @db.ObjectId\n  id String @unique(map: "id_1")\n  userId ${userType} @map("user_id")\n  experimentId String @map("experiment_id")\n  cohortId String @map("cohort_id")\n  @@unique([userId, experimentId], map: "user_id_1_experiment_id_1")\n  @@index([experimentId], map: "experiment_id_1")\n  @@index([cohortId], map: "cohort_id_1")\n  @@map("user_cohorts")\n}\n`;
}

async function schemaFiles(
  options: ResolvedSetup,
  project: ProjectDetection,
): Promise<{ entry: string; files: Map<string, string>; directory: boolean }> {
  const target = options.schema ?? "prisma/schema.prisma";
  const files = new Map<string, string>();
  const directory = !target.endsWith(".prisma");
  if (directory) {
    for await (const file of glob(`${target.replace(/\/$/, "")}/**/*.prisma`, {
      cwd: options.cwd,
    })) {
      const source = await readInput(options, project, file);
      if (source !== null) files.set(file, source);
    }
  } else {
    const source = await readInput(options, project, target);
    if (source !== null) files.set(target, source);
  }
  return { entry: directory ? path.join(target, "xp.prisma") : target, files, directory };
}

async function validateSchema(
  options: ResolvedSetup,
  project: ProjectDetection,
  files: Map<string, string>,
  prerequisites: string[],
): Promise<void> {
  const installed = await localPackage(options, project, "prisma");
  if (!installed) {
    prerequisites.push(
      "Install the supported Prisma CLI and run prisma validate against the integrated schema before applying the migration.",
    );
    return;
  }
  const stage = await mkdtemp(path.join(tmpdir(), "xp-prisma-"));
  try {
    const schema = path.join(stage, "schema.prisma");
    await writeFile(schema, [...files.values()].join("\n\n"));
    const config = path.join(stage, "prisma.config.ts");
    await writeFile(config, `export default {schema: ${JSON.stringify(schema)}};\n`);
    const args = ["validate", "--schema", schema];
    if (installed.version.startsWith("7.")) args.push("--config", config);
    await runLocal(
      installed.bin,
      args,
      stage,
      {
        DATABASE_URL:
          options.database === "mongodb"
            ? "mongodb://127.0.0.1:27017/xp"
            : "postgresql://unused:unused@127.0.0.1:5432/xp",
      },
      project.signal,
    );
  } catch (error) {
    project.signal?.throwIfAborted();
    throw new Error(
      "The integrated Prisma schema did not pass local validation; no files were changed. Run prisma validate on the current schema and check the selected users.id type.",
      { cause: error },
    );
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function generatePrisma(
  options: ResolvedSetup,
  project: ProjectDetection,
): Promise<GeneratedArtifacts> {
  if (!["postgres", "mysql", "mssql", "mongodb"].includes(options.database))
    throw new Error("Prisma setup supports PostgreSQL, MySQL, SQL Server, or MongoDB.");
  const mongodb = options.database === "mongodb";
  const artifacts: GeneratedArtifacts = mongodb
    ? generateMongoBootstrap(options, project)
    : { files: [], warnings: [], prerequisites: [], nextSteps: [] };
  const { entry, files, directory } = await schemaFiles(options, project);
  const user = existingUser(files, options);
  const expected = scalar(options);
  let datasource = "db";
  const provider = {
    postgres: "postgresql",
    mysql: "mysql",
    mssql: "sqlserver",
    mongodb: "mongodb",
    dynamodb: "",
  }[options.database];
  for (const source of files.values()) {
    for (const block of prismaBlocks(source).filter((item) => item.kind === "datasource")) {
      datasource = block.name;
      const actual = /\bprovider\s*=\s*"([^"]+)"/.exec(maskComments(block.body))?.[1];
      if (actual !== provider)
        throw new Error(
          `Prisma datasource provider ${actual ?? "(dynamic)"} does not match ${provider}.`,
        );
      if (!mongodb && /\brelationMode\s*=\s*"prisma"/.test(block.body))
        throw new Error(
          "xp requires database foreign keys; Prisma relationMode=prisma is incompatible with this storage contract.",
        );
    }
  }
  if (user && options.userStorage === "create")
    throw new Error(
      "The Prisma schema already contains users.id. Select --user-storage reuse to preserve existing users.",
    );
  if (user && mongodb && /ObjectId/.test(user.native))
    throw new Error(
      "xp needs a separate primitive users.id; an ObjectId field is not a supported xp user identity.",
    );
  if (user && mongodb && (user.type === "String" ? "string" : "number") !== options.userIdType)
    throw new Error(
      `The selected MongoDB users.id type ${options.userIdType} disagrees with ${user.block.name}.${user.field} ${user.type}. Supply its matching primitive type.`,
    );
  if (user && !mongodb && user.type !== expected.type)
    throw new Error(
      `The selected users.id type maps to Prisma ${expected.type}, but ${user.block.name}.${user.field} is ${user.type}.`,
    );
  const defaultNative =
    user?.type === "String"
      ? options.database === "postgres"
        ? "@db.Text"
        : options.database === "mysql"
          ? "@db.VarChar(191)"
          : "@db.NVarChar(1000)"
      : user?.type === "Int" || user?.type === "BigInt"
        ? expected.native
        : "";
  if (
    user &&
    !mongodb &&
    (user.native || defaultNative)
      .replace(/^@\w+\./, "@db.")
      .replace(/\s/g, "")
      .toLowerCase() !== expected.native.toLowerCase()
  ) {
    throw new Error(
      `The selected users.id type disagrees with ${user.block.name}.${user.field} ${user.native}. Supply its exact database type.`,
    );
  }
  const keyType = user
    ? `${user.type} ${user.native}`.trim()
    : `${expected.type} ${expected.native}`.trim();
  const contribution = mongodb
    ? mongoModels(user?.type ?? expected.type)
    : sqlModels(options, user?.block.name ?? "XpUser", user?.field ?? "id", keyType).replaceAll(
        "@db.",
        `@${datasource}.`,
      );
  let integrated = user !== null || options.userStorage === "create";
  let schemaContribution = contribution;
  if (!user && options.userStorage === "create") {
    schemaContribution =
      (mongodb
        ? `model XpUser {\n  mongoId String @id @default(auto()) @map("_id") @db.ObjectId\n  id ${expected.type} @unique(map: "id_1")\n  @@map("users")\n}\n\n`
        : `model XpUser {\n  id ${keyType} @id\n  xpAssignments XpUserCohort[]\n  @@map("users")\n}\n\n`) +
      contribution;
  }
  schemaContribution = schemaContribution.replaceAll("@db.", `@${datasource}.`);
  if (!user && options.userStorage === "reuse") {
    integrated = false;
    artifacts.files.push({
      path: path.join(path.dirname(entry), "xp.prisma.snippet"),
      content: schemaContribution,
      purpose: "Prisma schema contribution requiring an existing users.id model",
    });
    artifacts.prerequisites.push(
      "Map an existing Prisma user model to the physical users.id field, replace XpUser in xp.prisma.snippet with that model, add its xpAssignments backrelation for SQL, and merge the snippet. ObjectId-only user models do not satisfy xp's identity contract.",
    );
  } else {
    if (user && !mongodb) {
      if (/^\s*xpAssignments\s/m.test(maskComments(user.block.body)))
        throw new Error(
          "The user model already has xpAssignments; resolve that field collision before setup.",
        );
      const source = files.get(user.file)!;
      files.set(
        user.file,
        source.slice(0, user.block.bodyEnd) +
          "  xpAssignments XpUserCohort[]\n" +
          source.slice(user.block.bodyEnd),
      );
    }
    if (!files.size) {
      schemaContribution =
        `generator client {\n  provider = "${mongodb ? "prisma-client-js" : "prisma-client"}"\n${mongodb ? "" : '  output = "./generated/xp-client"\n'}}\n\ndatasource db {\n  provider = "${provider}"\n${mongodb ? '  url = env("DATABASE_URL")\n' : ""}}\n\n` +
        schemaContribution;
    }
    const existing = files.get(entry) ?? "";
    files.set(
      entry,
      existing + (existing.endsWith("\n") || !existing ? "\n" : "\n\n") + schemaContribution,
    );
    for (const [file, content] of files) {
      const before = await readInput(options, project, file);
      if (content !== before)
        artifacts.files.push({
          path: file,
          content,
          purpose: "Integrated Prisma xp schema",
          merge: true,
        });
    }
  }
  if (!mongodb) {
    const migration = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}_xp_setup`;
    artifacts.files.push({
      path: path.join(options.migrationsDir, migration, "migration.sql"),
      content: `-- xp storage schema v${STORAGE_VERSION}\n${renderSql(options).up.join("\n\n")}\n`,
      purpose: "Prisma SQL migration",
    });
    const lockPath = path.join(options.migrationsDir, "migration_lock.toml");
    const lock = await readInput(options, project, lockPath);
    if (lock === null)
      artifacts.files.push({
        path: lockPath,
        content: `provider = "${provider}"\n`,
        purpose: "Prisma migration provider lock",
      });
    else if (!new RegExp(`provider\\s*=\\s*"${provider}"`).test(lock))
      throw new Error("The Prisma migration lock uses a different database provider.");
    artifacts.warnings.push(
      "Preserve the SQL migration's CHECK constraints and collations. Use Prisma migrations; schema push cannot reproduce the complete xp storage contract.",
    );
    artifacts.nextSteps.push(
      command(
        project,
        "prisma",
        `migrate deploy${options.config ? ` --config ${shellQuote(options.config)}` : ""}`,
      ),
      command(
        project,
        "prisma",
        `generate${options.config ? ` --config ${shellQuote(options.config)}` : ""}`,
      ),
    );
  }
  if (integrated && !mongodb) {
    const configPath = options.config ?? "prisma.config.ts";
    const config = await readInput(options, project, configPath);
    const schemaPath = options.schema ?? "prisma/schema.prisma";
    const configDirectory = path.dirname(path.resolve(options.cwd, configPath));
    const schemaLiteral =
      path
        .relative(configDirectory, path.resolve(options.cwd, schemaPath))
        .split(path.sep)
        .join("/") || ".";
    const migrationsLiteral =
      path
        .relative(configDirectory, path.resolve(options.cwd, options.migrationsDir))
        .split(path.sep)
        .join("/") || ".";
    if (config === null) {
      artifacts.files.push({
        path: configPath,
        content: `import { defineConfig, env } from "prisma/config";\n\nexport default defineConfig({\n  schema: ${JSON.stringify(schemaLiteral)},\n  migrations: { path: ${JSON.stringify(migrationsLiteral)} },\n  datasource: { url: env("DATABASE_URL") },\n});\n`,
        purpose: "Prisma schema/migration paths and environment-based connection",
      });
      artifacts.nextSteps.unshift(
        "Set DATABASE_URL in your application's environment before running Prisma migrations.",
      );
    } else {
      const updated = patchPrismaConfig(config, schemaLiteral, migrationsLiteral);
      if (updated === null)
        artifacts.prerequisites.push(
          `Update ${configPath} to use config-relative schema ${schemaLiteral} and migrations.path ${migrationsLiteral}; its dynamic configuration was preserved.`,
        );
      else if (updated !== config)
        artifacts.files.push({
          path: configPath,
          content: updated,
          purpose: "Align Prisma schema and migration paths",
          merge: true,
        });
    }
  }
  if (integrated) await validateSchema(options, project, files, artifacts.prerequisites);
  if (directory && !files.size)
    artifacts.prerequisites.push(
      `Configure Prisma to load the schema directory ${options.schema}.`,
    );
  artifacts.nextSteps.push(
    "Pass a supported native database client to xp/server; generated Prisma models do not enable server(prismaClient).",
  );
  return artifacts;
}
