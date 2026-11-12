import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it } from "vitest";

import type { GeneratedArtifacts, ProjectDetection, ResolvedSetup } from "~/interfaces/setup";

import { generateDrizzle } from "../drizzle";
import { generatePrisma } from "../prisma";
import { patchPrismaConfig } from "../prisma-config";
import { runLocal } from "../schema-utils";

const directories: string[] = [];
async function fixture(overrides: Partial<ResolvedSetup> = {}, modules?: string) {
  const cwd = await mkdtemp(path.join(tmpdir(), "xp-schema-test-"));
  directories.push(cwd);
  await writeFile(path.join(cwd, "package.json"), '{"type":"module"}\n');
  if (modules) await symlink(modules, path.join(cwd, "node_modules"), "dir");
  const options: ResolvedSetup = {
    cwd,
    orm: "prisma",
    database: "postgres",
    migrationsDir: "prisma/migrations",
    models: false,
    modelsDir: "models",
    language: "typescript",
    moduleFormat: "esm",
    userStorage: "create",
    userIdType: "text",
    tableName: "xp",
    ...overrides,
  };
  const project: ProjectDetection = {
    cwd,
    options,
    ormCandidates: [options.orm],
    databaseCandidates: [options.database],
    versions: {},
    packageManager: "bun",
    sources: [],
    warnings: [],
    missing: [],
    inputs: {},
  };
  return { options, project };
}
async function put(cwd: string, name: string, content: string) {
  await mkdir(path.dirname(path.join(cwd, name)), { recursive: true });
  await writeFile(path.join(cwd, name), content);
}
async function apply(cwd: string, artifacts: GeneratedArtifacts) {
  for (const file of artifacts.files) await put(cwd, file.path, file.content);
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Prisma schema generation", () => {
  it("updates path literals in Prisma configuration while retaining connection and seed code", () => {
    const source =
      'import {defineConfig} from "prisma/config";\nexport default defineConfig({schema:"old.prisma",migrations:{path:"old",seed:"bun seed.ts"},datasource:{url:process.env.DATABASE_URL}});\n';
    const updated = patchPrismaConfig(source, "prisma/schema.prisma", "prisma/migrations");
    expect(updated).toContain('schema:"prisma/schema.prisma"');
    expect(updated).toContain('seed:"bun seed.ts"');
    expect(updated).toContain("datasource:{url:process.env.DATABASE_URL}");
    expect(
      patchPrismaConfig("export default loadConfiguration();", "schema.prisma", "migrations"),
    ).toBeNull();
  });
  it("uses the selected Prisma config and resolves its paths from the config directory", async () => {
    const { options, project } = await fixture({
      config: "config/database/prisma.ts",
      schema: "db/schema.prisma",
      migrationsDir: "db/migrations",
    });
    await put(
      options.cwd,
      options.config!,
      'export default { schema: "old.prisma", migrations: { path: "old" }, datasource: { url: process.env.DATABASE_URL } };\n',
    );
    const artifacts = await generatePrisma(options, project);
    const config = artifacts.files.find((file) => file.path === options.config)!;
    expect(config.content).toContain('schema: "../../db/schema.prisma"');
    expect(config.content).toContain('path: "../../db/migrations"');
    expect(config.content).toContain("url: process.env.DATABASE_URL");
    expect(artifacts.nextSteps).toContain(
      "bun run prisma migrate deploy --config 'config/database/prisma.ts'",
    );
    expect(artifacts.nextSteps).toContain(
      "bun run prisma generate --config 'config/database/prisma.ts'",
    );
  });

  it("accepts explicit Prisma relation emulation for Mongo and validates its physical user ID type", async () => {
    const { options, project } = await fixture({
      database: "mongodb",
      userStorage: "reuse",
      userIdType: "number",
    });
    await put(
      options.cwd,
      "prisma/schema.prisma",
      'datasource db {\n provider = "mongodb"\n url = env("DATABASE_URL")\n relationMode = "prisma"\n}\nmodel User {\n mongoId String @id @default(auto()) @map("_id") @db.ObjectId\n id Int @unique\n @@map("users")\n}\n',
    );
    const artifacts = await generatePrisma(options, project);
    expect(artifacts.files.find((file) => file.path.endsWith("schema.prisma"))?.content).toContain(
      'userId Int @map("user_id")',
    );
    await expect(generatePrisma({ ...options, userIdType: "string" }, project)).rejects.toThrow(
      "matching primitive type",
    );
  });

  it("merges only the user backrelation and xp contribution, preserving unrelated content", async () => {
    const { options, project } = await fixture({ userStorage: "reuse", userIdType: "uuid" });
    const source =
      '// application-owned header\ndatasource db {\n  provider = "postgresql"\n}\nmodel Customer {\n  key String @id @map("id") @db.Uuid\n  email String @unique\n  @@map("users")\n}\n';
    await put(options.cwd, "prisma/schema.prisma", source);
    const artifacts = await generatePrisma(options, project);
    const schema = artifacts.files.find((file) => file.path === "prisma/schema.prisma")!;
    expect(schema.merge).toBe(true);
    expect(schema.content).toContain('  email String @unique\n  @@map("users")');
    expect(schema.content).toContain("user Customer @relation(fields: [userId], references: [key]");
    expect(schema.content).toContain('userId String @db.Uuid @map("user_id")');
    expect(await readFile(path.join(options.cwd, "prisma/schema.prisma"), "utf8")).toBe(source);
    expect(
      artifacts.files.find((file) => file.path.endsWith("migration.sql"))?.content,
    ).not.toContain("CREATE TABLE users");
    expect(artifacts.prerequisites.join(" ")).toContain("Prisma CLI");
    expect(project.inputs["prisma/schema.prisma"]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not invent a partial application user model when its schema is missing", async () => {
    const { options, project } = await fixture({ userStorage: "reuse" });
    const artifacts = await generatePrisma(options, project);
    expect(artifacts.files.some((file) => file.path.endsWith(".snippet"))).toBe(true);
    expect(artifacts.files.some((file) => file.path.endsWith("schema.prisma"))).toBe(false);
    expect(artifacts.prerequisites.join(" ")).toContain("physical users.id");
  });

  it("rejects physical user type mismatches and existing xp tables", async () => {
    const { options, project } = await fixture({ userStorage: "reuse", userIdType: "uuid" });
    await put(
      options.cwd,
      "prisma/schema.prisma",
      'model User {\n  id String @id\n  @@map("users")\n}\n',
    );
    await expect(generatePrisma(options, project)).rejects.toThrow("exact database type");
    await put(
      options.cwd,
      "prisma/schema.prisma",
      'model Experiment {\n  id Int @id\n  @@map("experiments")\n}\n',
    );
    await expect(generatePrisma(options, project)).rejects.toThrow("already maps an xp table");
  });

  it("does not treat Prisma's Mongo ObjectId field as the physical xp user id", async () => {
    const { options, project } = await fixture({
      database: "mongodb",
      userStorage: "reuse",
      userIdType: "string",
    });
    await put(
      options.cwd,
      "prisma/schema.prisma",
      'datasource db {\n  provider = "mongodb"\n  url = env("DATABASE_URL")\n}\nmodel User {\n  id String @id @default(auto()) @map("_id") @db.ObjectId\n  @@map("users")\n}\n',
    );
    const artifacts = await generatePrisma(options, project);
    expect(artifacts.prerequisites.join(" ")).toContain("ObjectId-only");
    expect(artifacts.files.find((file) => file.path.endsWith(".snippet"))?.content).toContain(
      'id String @unique(map: "id_1")',
    );
  });
});

describe("Drizzle source-only planning", () => {
  it("does not execute configuration or dynamic schema code", async () => {
    const { options, project } = await fixture({
      orm: "drizzle",
      schema: "src/schema.ts",
      migrationsDir: "drizzle",
    });
    await put(
      options.cwd,
      "src/schema.ts",
      'import fs from "node:fs"; fs.writeFileSync("should-not-exist", "bad");\n',
    );
    const artifacts = await generateDrizzle(options, project);
    expect(artifacts.prerequisites.join(" ")).toContain("application startup");
    expect(await readdir(options.cwd)).not.toContain("should-not-exist");
    expect(artifacts.files.some((file) => file.path.endsWith(".sql"))).toBe(false);
  });

  it("uses a custom Drizzle configuration in manual generator instructions", async () => {
    const { options, project } = await fixture({
      orm: "drizzle",
      config: "config/drizzle-prod.ts",
      schema: "src/schema.ts",
      migrationsDir: "drizzle",
    });
    const artifacts = await generateDrizzle(options, project);
    expect(artifacts.prerequisites.join(" ")).toContain(
      "generate --name=xp_setup --config 'config/drizzle-prod.ts'",
    );
  });

  it("reports missing tools without manufacturing migration metadata", async () => {
    const { options, project } = await fixture({
      orm: "drizzle",
      schema: "src/schema.ts",
      migrationsDir: "drizzle",
    });
    const artifacts = await generateDrizzle(options, project);
    expect(artifacts.files.some((file) => file.path.endsWith("schema.ts"))).toBe(true);
    expect(artifacts.prerequisites.join(" ")).toContain("No migration metadata was fabricated");
    expect(artifacts.files.some((file) => file.path.endsWith("_journal.json"))).toBe(false);
  });
});

const sqlModules = process.env["XP_SCHEMA_TOOLS_NODE_MODULES"];
const mongoModules = process.env["XP_PRISMA_MONGO_NODE_MODULES"];
describe.skipIf(!sqlModules)("pinned schema toolchain compatibility", () => {
  it("loads the generated nested Prisma configuration with its actual CLI", async () => {
    const { options, project } = await fixture(
      {
        config: "config/prisma-custom.ts",
        schema: "database/schema.prisma",
        migrationsDir: "database/migrations",
      },
      sqlModules,
    );
    const artifacts = await generatePrisma(options, project);
    expect(artifacts.prerequisites).toEqual([]);
    await apply(options.cwd, artifacts);
    const output = await runLocal(
      path.join(sqlModules!, "prisma/build/index.js"),
      ["validate", "--config", options.config!],
      options.cwd,
      { DATABASE_URL: "postgresql://unused:unused@127.0.0.1:5432/xp" },
    );
    expect(output).toContain("valid");
  });

  it("runs the selected custom Drizzle configuration after generation", async () => {
    const { options, project } = await fixture(
      {
        orm: "drizzle",
        config: "config/drizzle-custom.ts",
        schema: "src/schema.ts",
        migrationsDir: "database/migrations",
      },
      sqlModules,
    );
    const artifacts = await generateDrizzle(options, project);
    expect(artifacts.prerequisites).toEqual([]);
    expect(artifacts.nextSteps).toContain(
      "bun run drizzle-kit migrate --config 'config/drizzle-custom.ts'",
    );
    await apply(options.cwd, artifacts);
    const output = await runLocal(
      path.join(sqlModules!, "drizzle-kit/bin.cjs"),
      ["generate", "--config", options.config!, "--name=verify"],
      options.cwd,
    );
    expect(output).toContain("No schema changes");
  });

  it.each(["postgres", "mysql", "mssql"] as const)(
    "validates generated Prisma SQL schema for %s",
    async (database) => {
      const userIdType =
        database === "postgres" ? "text" : database === "mysql" ? "varchar(191)" : "nvarchar(255)";
      const { options, project } = await fixture({ database, userIdType }, sqlModules);
      const artifacts = await generatePrisma(options, project);
      expect(artifacts.prerequisites).toEqual([]);
      expect(artifacts.files.some((file) => file.path.endsWith("migration.sql"))).toBe(true);
      await apply(options.cwd, artifacts);
      const datasourceUrl =
        database === "postgres"
          ? "postgresql://unused:unused@127.0.0.1:5432/xp"
          : database === "mysql"
            ? "mysql://unused:unused@127.0.0.1:3306/xp"
            : "sqlserver://localhost:1433;database=xp;user=unused;password=unused;trustServerCertificate=true";
      const sql = await runLocal(
        path.join(sqlModules!, "prisma/build/index.js"),
        ["migrate", "diff", "--from-empty", "--to-schema", "prisma/schema.prisma", "--script"],
        options.cwd,
        { DATABASE_URL: datasourceUrl },
      );
      const canonical = artifacts.files.find((file) =>
        file.path.endsWith("migration.sql"),
      )!.content;
      for (const name of [
        "experiments_slug_key",
        "cohorts_slug_key",
        "cohorts_id_experiment_id_key",
        "user_cohorts_user_id_experiment_id_key",
        "cohorts_experiment_id_fkey",
        "user_cohorts_user_id_fkey",
        "user_cohorts_experiment_id_fkey",
        "user_cohorts_cohort_id_experiment_id_fkey",
      ]) {
        expect(sql).toContain(name);
        expect(canonical).toContain(name);
      }
      if (database === "mssql") {
        expect(sql).toContain("cohorts_value_df");
        expect(canonical).toContain("cohorts_value_df");
      }
    },
    30000,
  );

  it.each(["postgres", "mysql"] as const)(
    "Drizzle %s produces real history and a subsequent generation is empty",
    async (database) => {
      const { options, project } = await fixture(
        {
          orm: "drizzle",
          database,
          schema: "src/schema.ts",
          migrationsDir: "drizzle",
          userIdType: database === "postgres" ? "text" : "varchar(191)",
        },
        sqlModules,
      );
      const artifacts = await generateDrizzle(options, project);
      expect(artifacts.prerequisites).toEqual([]);
      expect(artifacts.files.some((file) => file.path.endsWith("_snapshot.json"))).toBe(true);
      expect(artifacts.files.some((file) => file.path.endsWith("_journal.json"))).toBe(true);
      const snapshot = artifacts.files.find((file) =>
        file.path.endsWith("_snapshot.json"),
      )!.content;
      const canonical = artifacts.files.find((file) => file.path.endsWith(".sql"))!.content;
      for (const name of [
        "experiments_slug_key",
        "cohorts_slug_key",
        "cohorts_id_experiment_id_key",
        "user_cohorts_user_id_experiment_id_key",
        "cohorts_experiment_id_fkey",
        "user_cohorts_user_id_fkey",
        "user_cohorts_experiment_id_fkey",
        "user_cohorts_cohort_id_experiment_id_fkey",
        "experiments_type_check",
        "cohorts_type_check",
        "cohorts_percentage_check",
      ]) {
        expect(snapshot).toContain(name);
        expect(canonical).toContain(name);
      }
      await apply(options.cwd, artifacts);
      const before = await readdir(path.join(options.cwd, "drizzle"));
      const stdout = await runLocal(
        path.join(sqlModules!, "drizzle-kit/bin.cjs"),
        ["generate", "--name=verify"],
        options.cwd,
      );
      expect(stdout).toContain("No schema changes");
      expect(await readdir(path.join(options.cwd, "drizzle"))).toEqual(before);
    },
  );

  it.each(["esm", "commonjs"] as const)(
    "loads generated JavaScript Drizzle schema in %s format",
    async (moduleFormat) => {
      const extension = moduleFormat === "esm" ? "mjs" : "cjs";
      const { options, project } = await fixture(
        {
          orm: "drizzle",
          language: "javascript",
          moduleFormat,
          schema: `src/schema.${extension}`,
          migrationsDir: "drizzle",
        },
        sqlModules,
      );
      const artifacts = await generateDrizzle(options, project);
      expect(artifacts.prerequisites).toEqual([]);
      expect(artifacts.files.some((file) => file.path.endsWith("_snapshot.json"))).toBe(true);
    },
  );

  it("preserves existing application history and integrates a mapped user key", async () => {
    const { options, project } = await fixture(
      {
        orm: "drizzle",
        schema: "src/schema.ts",
        migrationsDir: "drizzle",
        userStorage: "reuse",
        userIdType: "integer",
      },
      sqlModules,
    );
    await put(
      options.cwd,
      "src/schema.ts",
      'import {pgTable, serial, text} from "drizzle-orm/pg-core";\nexport const appUsers = pgTable("users", {key: serial("id").primaryKey(), email: text("email")});\n',
    );
    await put(
      options.cwd,
      "drizzle.config.ts",
      'export default {dialect:"postgresql",schema:"src/schema.ts",out:"drizzle"};\n',
    );
    await runLocal(
      path.join(sqlModules!, "drizzle-kit/bin.cjs"),
      ["generate", "--name=application"],
      options.cwd,
    );
    const initial = await readFile(
      path.join(options.cwd, "drizzle", "0000_application.sql"),
      "utf8",
    );
    const artifacts = await generateDrizzle(options, project);
    expect(artifacts.prerequisites).toEqual([]);
    expect(artifacts.files.some((file) => file.path.endsWith("0000_application.sql"))).toBe(false);
    expect(artifacts.files.find((file) => file.path.endsWith("xp-schema.ts"))?.content).toContain(
      "xpApplicationUsers.key",
    );
    const mismatch = await generateDrizzle({ ...options, userIdType: "text" }, project);
    expect(mismatch.prerequisites.join(" ")).toContain("selected user ID type differs");
    expect(mismatch.files.some((file) => file.path.endsWith(".sql"))).toBe(false);
    await apply(options.cwd, artifacts);
    expect(await readFile(path.join(options.cwd, "drizzle", "0000_application.sql"), "utf8")).toBe(
      initial,
    );
    const stdout = await runLocal(
      path.join(sqlModules!, "drizzle-kit/bin.cjs"),
      ["generate", "--name=verify"],
      options.cwd,
    );
    expect(stdout).toContain("No schema changes");
  });

  it("rejects unrelated pending Drizzle changes rather than incorporating them", async () => {
    const { options, project } = await fixture(
      {
        orm: "drizzle",
        schema: "src/schema.ts",
        migrationsDir: "drizzle",
        userStorage: "reuse",
        userIdType: "integer",
      },
      sqlModules,
    );
    await put(
      options.cwd,
      "src/schema.ts",
      'import {pgTable, serial} from "drizzle-orm/pg-core";\nexport const users = pgTable("users", {id: serial("id").primaryKey()});\n',
    );
    const artifacts = await generateDrizzle(options, project);
    expect(artifacts.prerequisites.join(" ")).toContain("baseline migration history");
    expect(artifacts.files.some((file) => file.path.endsWith(".sql"))).toBe(false);
    expect(await readdir(options.cwd)).not.toContain("drizzle");
  });
});

describe.skipIf(!mongoModules)("Prisma 6 Mongo compatibility", () => {
  it("validates separate Mongo and xp identities without a database", async () => {
    const { options, project } = await fixture(
      { database: "mongodb", userIdType: "string" },
      mongoModules,
    );
    const artifacts = await generatePrisma(options, project);
    expect(artifacts.prerequisites.join(" ")).not.toContain("Prisma");
    const schema = artifacts.files.find((file) => file.path.endsWith("schema.prisma"))!.content;
    expect(schema).toContain('mongoId String @id @default(auto()) @map("_id") @db.ObjectId');
    expect(schema).toContain('id String @unique(map: "id_1")');
    expect(artifacts.files.some((file) => file.path.endsWith("migration.sql"))).toBe(false);
  });
});
