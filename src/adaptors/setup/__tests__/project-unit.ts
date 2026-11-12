import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as filesystem from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GeneratedArtifacts, ISetupGenerator, SetupOptions } from "~/interfaces/setup";

import { detectProject } from "../discovery";
import { fingerprint } from "../filesystem";
import ProjectManager from "../projectManager";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const directories: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(files: Record<string, string> = {}): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "xp-project-test-"));
  directories.push(directory);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), content);
  }
  return directory;
}
const native: SetupOptions = { orm: "none", database: "postgres", userStorage: "create" };
function generator(
  files = [
    {
      path: "migrations/20261112000000_xp.sql",
      content: "CREATE TABLE experiments (id INTEGER);\n",
      purpose: "Migration",
    },
  ],
): ISetupGenerator {
  return {
    generate: vi.fn(async (): Promise<GeneratedArtifacts> => ({
      files,
      prerequisites: [],
      warnings: [],
      nextSteps: ["Apply with your migration runner."],
    })),
  };
}
const pkg = (dependencies: Record<string, string> = {}, extra: object = {}) =>
  JSON.stringify({ name: "app", dependencies, ...extra });

describe("project detection", () => {
  it("resolves nested Prisma configuration paths relative to its configuration file", async () => {
    const cwd = await fixture({
      "package.json": pkg({ prisma: "7.10.1" }),
      "config/database/prisma.ts":
        'export default {schema: "../../db/schema.prisma", migrations: {path: "../../db/migrations"}};',
      "db/schema.prisma":
        'datasource db {\n provider = "postgresql"\n}\nmodel User {\n id String @id @db.Uuid\n @@map("users")\n}\n',
    });
    const detected = await detectProject({ cwd, config: "config/database/prisma.ts" });
    expect(detected.options.schema).toBe("db/schema.prisma");
    expect(detected.options.migrationsDir).toBe("db/migrations");
    expect(detected.options.database).toBe("postgres");
    expect(detected.options.userIdType).toBe("UUID");
    expect(detected.missing).toEqual([]);
  });

  it("detects Sequelize config paths, TypeScript, and exact users identity without executing config", async () => {
    const cwd = await fixture({
      "package.json": pkg(
        { sequelize: "6.37.8", pg: "8.0.0" },
        { type: "module", packageManager: "bun@1.4.4" },
      ),
      "node_modules/sequelize/package.json": JSON.stringify({
        name: "sequelize",
        version: "6.37.8",
      }),
      "tsconfig.json": "{}",
      ".sequelizerc":
        "const path = require('node:path'); globalThis.sideEffect = true; module.exports = { 'config': path.resolve('db/config.json'), 'migrations-path': path.resolve('db/migrations'), 'models-path': path.resolve('db/models') };",
      "db/config.json": JSON.stringify({
        development: { dialect: "postgres", password: "never-persist-this" },
      }),
      "db/models/user.ts":
        "export const user = { tableName: 'users', id: { type: DataTypes.UUID, primaryKey: true } };",
    });
    const result = await detectProject({ cwd });
    expect(result.options).toMatchObject({
      orm: "sequelize",
      database: "postgres",
      migrationsDir: "db/migrations",
      modelsDir: "db/models",
      language: "typescript",
      moduleFormat: "esm",
      userIdType: "UUID",
    });
    expect(result.missing).toEqual([]);
    expect(result.versions["sequelize"]).toBe("6.37.8");
    expect(result.packageManager).toBe("bun");
    expect(JSON.stringify(result.options)).not.toContain("never-persist-this");
    expect((globalThis as Record<string, unknown>)["sideEffect"]).toBeUndefined();
  });

  it("does not choose between multiple installed ORMs or database drivers", async () => {
    const cwd = await fixture({
      "package.json": pkg({ sequelize: "6", knex: "3", pg: "8", mysql2: "3" }),
    });
    const result = await detectProject({ cwd });
    expect(result.ormCandidates).toEqual(["sequelize", "knex"]);
    expect(result.missing).toEqual(expect.arrayContaining(["orm", "database", "userIdType"]));
  });

  it("supports literal TypeORM data sources without importing application startup", async () => {
    const cwd = await fixture({
      "package.json": pkg({ typeorm: "1.1.3" }),
      "src/data-source.ts":
        "import './start-server'; export default new DataSource({type:'postgres', migrations:['src/db/migrations/*.ts'], entities:['src/db/entities/*.ts']});",
    });
    const result = await detectProject({ cwd, userIdType: "UUID" });
    expect(result.options).toMatchObject({
      orm: "typeorm",
      database: "postgres",
      migrationsDir: "src/db/migrations",
      modelsDir: "src/db/entities",
    });
  });

  it("asks about environment-specific database and migration choices", async () => {
    const cwd = await fixture({
      "package.json": pkg({ knex: "3.3.0" }),
      "knexfile.js":
        "module.exports = { development: {client:'pg', migrations:{directory:'dev/migrations'}}, production: {client:'mysql2', migrations:{directory:'prod/migrations'}} };",
    });
    const result = await detectProject({ cwd, userIdType: "INTEGER" });
    expect(result.missing).toEqual(expect.arrayContaining(["database", "migrationsDir"]));
    const selected = await detectProject({
      cwd,
      database: "postgres",
      migrationsDir: "dev/migrations",
      userIdType: "INTEGER",
    });
    expect(selected.missing).toEqual([]);
  });

  it("handles literal MikroORM and Drizzle configuration", async () => {
    const mikro = await fixture({
      "package.json": pkg({ "@mikro-orm/core": "7.2.9", "@mikro-orm/mysql": "7.2.9" }),
      "mikro-orm.config.ts":
        "export default defineConfig({ migrations: {path:'db/migrations'}, entities: ['db/entities/*.js'] });",
    });
    expect((await detectProject({ cwd: mikro })).options).toMatchObject({
      orm: "mikroorm",
      database: "mysql",
      migrationsDir: "db/migrations",
      modelsDir: "db/entities",
    });
    const drizzle = await fixture({
      "package.json": pkg({ "drizzle-orm": "0.45.4" }),
      "drizzle.config.ts":
        "export default defineConfig({dialect:'postgresql', schema:'src/db/schema.ts', out:'db/history'});",
    });
    expect((await detectProject({ cwd: drizzle })).options).toMatchObject({
      orm: "drizzle",
      database: "postgres",
      schema: "src/db/schema.ts",
      migrationsDir: "db/history",
    });
  });

  it("detects Prisma physical users.id and ignores Mongo _id mappings", async () => {
    const cwd = await fixture({
      "package.json": pkg({ prisma: "7.10.1" }),
      "prisma/schema.prisma":
        'datasource db { provider = "postgresql" }\nmodel User {\n id String @id @db.Uuid\n @@map("users")\n}',
    });
    expect((await detectProject({ cwd })).options).toMatchObject({
      database: "postgres",
      userIdType: "UUID",
    });
    await writeFile(
      path.join(cwd, "prisma/schema.prisma"),
      'datasource db { provider = "mongodb" }\nmodel User {\n id String @id @map("_id") @db.ObjectId\n @@map("users")\n}',
    );
    expect((await detectProject({ cwd })).warnings.join(" ")).toContain("physical users.id");
  });

  it("uses explicit values before saved choices before detected values", async () => {
    const cwd = await fixture({
      "package.json": pkg({ sequelize: "6", mysql2: "3" }),
      ".xp/setup.json": JSON.stringify({
        options: {
          orm: "knex",
          database: "postgres",
          models: true,
          migrationsDir: "saved",
          password: "secret",
        },
      }),
    });
    const detected = await detectProject({
      cwd,
      orm: "none",
      migrationsDir: "explicit",
      models: false,
      userIdType: "TEXT",
    });
    expect(detected.options).toMatchObject({
      orm: "none",
      database: "postgres",
      models: false,
      migrationsDir: "explicit",
    });
    expect(JSON.stringify(detected.options)).not.toContain("secret");
  });

  it("never guesses existing SQL user types or their required character collation", async () => {
    const cwd = await fixture();
    expect((await detectProject({ cwd, orm: "none", database: "postgres" })).missing).toContain(
      "userIdType",
    );
    expect(
      (await detectProject({ cwd, orm: "none", database: "mysql", userIdType: "VARCHAR(191)" }))
        .missing,
    ).toEqual(expect.arrayContaining(["userIdCollation", "userIdCharset"]));
    expect(
      (
        await detectProject({
          cwd,
          orm: "none",
          database: "mysql",
          userIdType: "VARCHAR(191)",
          userIdCollation: "utf8mb4_0900_bin",
        })
      ).options.userIdCharset,
    ).toBe("utf8mb4");
    expect(
      (await detectProject({ cwd, orm: "none", database: "mssql", userStorage: "create" })).missing,
    ).toEqual([]);
  });

  it("recognizes a workspace-local package and hoisted installed dependencies", async () => {
    const workspace = await fixture({
      "package.json": pkg(),
      "node_modules/knex/package.json": JSON.stringify({ name: "knex", version: "3.3.0" }),
      "packages/app/package.json": pkg({ knex: "3.3.0", pg: "8" }),
    });
    const result = await detectProject({
      cwd: path.join(workspace, "packages/app"),
      userIdType: "TEXT",
    });
    expect(result.cwd).toBe(await realpath(path.join(workspace, "packages/app")));
    expect(result.versions["knex"]).toBe("3.3.0");
    expect(Object.keys(result.inputs)).toContain("../../node_modules/knex/package.json");
  });
});

describe("setup planning and writes", () => {
  it("plans without creating directories, then applies and replays without regenerating", async () => {
    const cwd = await fixture();
    const adaptor = generator();
    const manager = new ProjectManager(adaptor);
    const plan = await manager.planSetup({ cwd, ...native });
    expect(await readdir(cwd)).toEqual([]);
    expect(plan.files.map((file) => file.action)).toEqual(["create", "create"]);
    expect((await manager.applySetup(plan)).status).toBe("complete");
    expect(await readFile(path.join(cwd, "migrations/20261112000000_xp.sql"), "utf8")).toContain(
      "CREATE TABLE",
    );
    const replay = await manager.planSetup({ cwd });
    expect(replay.files.every((file) => file.action === "unchanged")).toBe(true);
    expect((await manager.applySetup(replay)).status).toBe("unchanged");
    expect(adaptor.generate).toHaveBeenCalledTimes(1);
  });

  it("stores only approved choices, file hashes, and guidance", async () => {
    const cwd = await fixture({
      "package.json": pkg({ sequelize: "6", pg: "8" }),
      "config/config.json": JSON.stringify({ dialect: "postgres", password: "secret-password" }),
    });
    const manager = new ProjectManager(generator());
    const plan = await manager.planSetup({ cwd, userStorage: "create" });
    expect(plan.status).toBe("manual-steps-required");
    await manager.applySetup(plan);
    const state = await readFile(path.join(cwd, ".xp/setup.json"), "utf8");
    expect(state).not.toContain("secret-password");
    expect(state).not.toContain("CREATE TABLE");
    expect(JSON.parse(state).files[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await manager.applySetup(await manager.planSetup({ cwd }))).status).toBe("unchanged");
  });

  it("requires missing selections and rejects unsupported stable profiles", async () => {
    const cwd = await fixture();
    const manager = new ProjectManager(generator());
    await expect(manager.planSetup({ cwd, orm: "none" })).rejects.toThrow("--database");
    await expect(
      manager.planSetup({ cwd, ...native, orm: "drizzle", database: "mssql" }),
    ).rejects.toThrow("does not support");
    await expect(
      manager.planSetup({ cwd, ...native, orm: "prisma", ormVersion: "8.0.0-rc.33" }),
    ).rejects.toThrow("Unsupported prisma version");
  });

  it("rejects unsupported installed versions even with a supported explicit template version", async () => {
    const cwd = await fixture({
      "package.json": pkg({ sequelize: "7" }),
      "node_modules/sequelize/package.json": JSON.stringify({
        name: "sequelize",
        version: "7.0.0",
      }),
    });
    await expect(
      new ProjectManager(generator()).planSetup({
        cwd,
        ...native,
        orm: "sequelize",
        ormVersion: "6.37.8",
      }),
    ).rejects.toThrow("Unsupported sequelize version 7.0.0");
  });

  it("protects existing files unless the generator declares a precise merge", async () => {
    const cwd = await fixture({ "schema.ts": "existing\n" });
    await expect(
      new ProjectManager(
        generator([{ path: "schema.ts", content: "changed", purpose: "Schema" }]),
      ).planSetup({ cwd, ...native }),
    ).rejects.toThrow("File conflict");
    const merged: ISetupGenerator = {
      generate: async () => ({
        files: [
          { path: "schema.ts", content: "existing\n// xp\n", purpose: "Schema", merge: true },
        ],
        warnings: [],
        prerequisites: [],
        nextSteps: [],
      }),
    };
    const manager = new ProjectManager(merged);
    const plan = await manager.planSetup({ cwd, ...native });
    expect(plan.files[0]).toMatchObject({ action: "update", before: "existing\n" });
    await manager.applySetup(plan);
    expect(await readFile(path.join(cwd, "schema.ts"), "utf8")).toBe("existing\n// xp\n");
  });

  it("never rewrites historical migration files even with merge requested", async () => {
    const cwd = await fixture({ "migrations/existing.sql": "old" });
    const adaptor: ISetupGenerator = {
      generate: async () => ({
        files: [
          { path: "migrations/existing.sql", content: "new", purpose: "Migration", merge: true },
        ],
        warnings: [],
        prerequisites: [],
        nextSteps: [],
      }),
    };
    await expect(new ProjectManager(adaptor).planSetup({ cwd, ...native })).rejects.toThrow(
      "historical migrations",
    );
  });

  it("rechecks preview source fingerprints and writes nothing on concurrent source edits", async () => {
    const cwd = await fixture({ "package.json": pkg() });
    const manager = new ProjectManager(generator());
    const plan = await manager.planSetup({ cwd, ...native });
    await writeFile(path.join(cwd, "package.json"), pkg({}, { type: "module" }));
    await expect(manager.applySetup(plan)).rejects.toThrow("Project changed since preview");
    expect(await readdir(cwd)).toEqual(["package.json"]);
  });

  it("rejects files created after preview", async () => {
    const cwd = await fixture();
    const manager = new ProjectManager(generator());
    const plan = await manager.planSetup({ cwd, ...native });
    await mkdir(path.join(cwd, "migrations"));
    await writeFile(path.join(cwd, "migrations/20261112000000_xp.sql"), "user-written");
    await expect(manager.applySetup(plan)).rejects.toThrow("Project changed since preview");
    expect(await readFile(path.join(cwd, "migrations/20261112000000_xp.sql"), "utf8")).toBe(
      "user-written",
    );
  });

  it("detects files read by a generator that change during generation", async () => {
    const cwd = await fixture({ "extra-schema.ts": "original" });
    const adaptor: ISetupGenerator = {
      generate: async (_options, project) => {
        project.inputs["extra-schema.ts"] = fingerprint("original");
        await writeFile(path.join(cwd, "extra-schema.ts"), "changed externally");
        return {
          files: [{ path: "extra-schema.ts", content: "proposed", purpose: "Schema", merge: true }],
          warnings: [],
          prerequisites: [],
          nextSteps: [],
        };
      },
    };
    await expect(new ProjectManager(adaptor).planSetup({ cwd, ...native })).rejects.toThrow(
      "Project changed during generation",
    );
  });

  it("rejects path escapes and symlink outputs", async () => {
    const cwd = await fixture();
    const outside = await fixture();
    await expect(
      new ProjectManager(
        generator([{ path: "../outside.sql", content: "bad", purpose: "bad" }]),
      ).planSetup({ cwd, ...native }),
    ).rejects.toThrow("must stay inside");
    await symlink(outside, path.join(cwd, "migrations"));
    await expect(new ProjectManager(generator()).planSetup({ cwd, ...native })).rejects.toThrow(
      "symlink",
    );
    expect(await readdir(outside)).toEqual([]);
  });

  it("does not silently regenerate when settings or approved artifacts have changed", async () => {
    const cwd = await fixture();
    const manager = new ProjectManager(generator());
    await manager.applySetup(await manager.planSetup({ cwd, ...native }));
    await expect(manager.planSetup({ cwd, models: true })).rejects.toThrow("different options");
    await writeFile(path.join(cwd, "migrations/20261112000000_xp.sql"), "user edit");
    await expect(manager.planSetup({ cwd })).rejects.toThrow("Previously generated file changed");
  });

  it("rolls back already-written files if a later replacement fails", async () => {
    const cwd = await fixture({ "schema-a.ts": "original A", "schema-b.ts": "original B" });
    const adaptor: ISetupGenerator = {
      generate: async () => ({
        files: [
          { path: "schema-a.ts", content: "updated A", purpose: "Schema", merge: true },
          { path: "schema-b.ts", content: "updated B", purpose: "Schema", merge: true },
        ],
        warnings: [],
        prerequisites: [],
        nextSteps: [],
      }),
    };
    const manager = new ProjectManager(adaptor);
    const plan = await manager.planSetup({ cwd, ...native });
    const actualRename = (
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
    ).rename;
    vi.mocked(filesystem.rename).mockImplementation(async (source, target) => {
      if (String(target).endsWith("schema-b.ts")) throw new Error("simulated filesystem failure");
      return actualRename(source, target);
    });
    await expect(manager.applySetup(plan)).rejects.toThrow("simulated filesystem failure");
    expect(await readFile(path.join(cwd, "schema-a.ts"), "utf8")).toBe("original A");
    expect(await readFile(path.join(cwd, "schema-b.ts"), "utf8")).toBe("original B");
    expect((await readdir(cwd)).sort()).toEqual(["schema-a.ts", "schema-b.ts"]);
  });

  it("honors a setup lock and leaves user data unchanged", async () => {
    const cwd = await fixture({ ".xp/.setup-lock": "locked" });
    const manager = new ProjectManager(generator());
    const plan = await manager.planSetup({ cwd, ...native });
    await expect(manager.applySetup(plan)).rejects.toThrow("Another xp setup");
    expect(await readFile(path.join(cwd, ".xp/.setup-lock"), "utf8")).toBe("locked");
  });
});

describe("setup review regressions", () => {
  it("treats the .sequelizerc config path as authoritative over leftover defaults", async () => {
    const cwd = await fixture({
      "package.json": pkg({ sequelize: "6", pg: "8" }),
      ".sequelizerc":
        "module.exports = {config:'db/actual.json', 'migrations-path':'db/migrations'};",
      "db/actual.json": JSON.stringify({ dialect: "postgres" }),
      "config/config.json": JSON.stringify({ dialect: "mysql" }),
    });
    const detected = await detectProject({ cwd, userIdType: "TEXT" });
    expect(detected.options.config).toBe("db/actual.json");
    expect(detected.options.database).toBe("postgres");
    expect(detected.options.migrationsDir).toBe("db/migrations");
    expect(detected.sources).not.toContain("config/config.json");
  });

  it("does not mistake the Sequelize rc file for a database connection config", async () => {
    const cwd = await fixture({
      "package.json": pkg({ sequelize: "6", pg: "8" }),
      ".sequelizerc": "module.exports={'migrations-path':'db/migrations'};",
    });
    const detected = await detectProject({ cwd, userIdType: "TEXT" });
    expect(detected.options.config).toBeUndefined();
    expect(detected.options.migrationsDir).toBe("db/migrations");
  });

  it("does not treat an unparseable configuration as resolved defaults", async () => {
    const cwd = await fixture({
      "package.json": pkg({ knex: "3", pg: "8" }),
      "knexfile.js": "module.exports = {client: 'pg', migrations: INVALID SYNTAX};",
    });
    expect((await detectProject({ cwd, userIdType: "TEXT" })).missing).toEqual(
      expect.arrayContaining(["database", "migrationsDir"]),
    );
  });

  it("requires explicit choices for dynamic recognized values but not credentials", async () => {
    const cwd = await fixture({
      "package.json": pkg({ knex: "3", pg: "8" }),
      "knexfile.js":
        "module.exports={client:process.env.DB_KIND,migrations:{directory:process.env.MIGRATIONS_DIR},connection:{password:process.env.PASSWORD}};",
    });
    expect((await detectProject({ cwd, userIdType: "TEXT" })).missing).toEqual(
      expect.arrayContaining(["database", "migrationsDir"]),
    );
    const selected = await detectProject({
      cwd,
      database: "postgres",
      migrationsDir: "db/history",
      userIdType: "TEXT",
    });
    expect(selected.missing).toEqual([]);
    await writeFile(
      path.join(cwd, "knexfile.js"),
      "module.exports={client:'pg',migrations:{directory:'db/history'},connection:{password:process.env.PASSWORD}};",
    );
    expect((await detectProject({ cwd, userIdType: "TEXT" })).missing).toEqual([]);
  });

  it("does not let dynamic spreads silently override detected setup choices", async () => {
    const cwd = await fixture({
      "package.json": pkg({ knex: "3", pg: "8" }),
      "knexfile.js":
        "module.exports={client:'pg',migrations:{directory:'db/history'},...loadRuntimeConfig()};",
    });
    expect((await detectProject({ cwd, userIdType: "TEXT" })).missing).toEqual(
      expect.arrayContaining(["database", "migrationsDir"]),
    );
    expect(
      (
        await detectProject({
          cwd,
          database: "postgres",
          migrationsDir: "chosen",
          userIdType: "TEXT",
        })
      ).missing,
    ).toEqual([]);
    await writeFile(
      path.join(cwd, "knexfile.js"),
      "module.exports={client:'pg',migrations:{directory:'db/history',...loadMigrationConfig()}};",
    );
    expect((await detectProject({ cwd, userIdType: "TEXT" })).missing).toEqual(["migrationsDir"]);
  });

  it("detects providers and physical user types in a Prisma schema directory", async () => {
    const cwd = await fixture({
      "package.json": pkg({ prisma: "7" }),
      "prisma/schema/base.prisma": 'datasource db { provider = "postgresql" }',
      "prisma/schema/users.prisma": 'model User {\n id String @id @db.Uuid\n @@map("users")\n}',
    });
    const detected = await detectProject({ cwd, schema: "prisma/schema" });
    expect(detected.options).toMatchObject({
      database: "postgres",
      userIdType: "UUID",
      schema: "prisma/schema",
    });
    expect(detected.missing).toEqual([]);
    expect(detected.inputs).toHaveProperty("prisma/schema/users.prisma");
  });

  it("warns when an explicit database differs from the migration configuration", async () => {
    const cwd = await fixture({
      "package.json": pkg({ knex: "3" }),
      "knexfile.js": "module.exports={client:'mysql2'};",
    });
    const detected = await detectProject({ cwd, database: "postgres", userIdType: "TEXT" });
    expect(detected.options.database).toBe("postgres");
    expect(detected.warnings.join(" ")).toContain("correct the configuration before running");
  });

  it("refreshes install requirements on rerun without discarding remaining manual work", async () => {
    const cwd = await fixture({
      "package.json": pkg({ sequelize: "6.37.8", "sequelize-cli": "6.6.5" }),
    });
    const base = generator();
    const adaptor: ISetupGenerator = {
      generate: async (...args) => ({
        ...(await base.generate(...args)),
        prerequisites: [
          "Install sequelize-cli v6 to run the generated migration.",
          "Register the generated models in your application.",
        ],
      }),
    };
    const manager = new ProjectManager(adaptor);
    const first = await manager.planSetup({ cwd, database: "postgres", userStorage: "create" });
    expect(first.prerequisites.join(" ")).toContain("Install");
    await manager.applySetup(first);
    for (const [name, version] of [
      ["sequelize", "6.37.8"],
      ["sequelize-cli", "6.6.5"],
    ]) {
      await mkdir(path.join(cwd, "node_modules", name!), { recursive: true });
      await writeFile(
        path.join(cwd, "node_modules", name!, "package.json"),
        JSON.stringify({ name, version }),
      );
    }
    const replay = await manager.planSetup({ cwd });
    expect(replay.prerequisites).toEqual(["Register the generated models in your application."]);
    expect(base.generate).toHaveBeenCalledTimes(1);
  });

  it("recognizes installed MikroORM migration packages", async () => {
    const cwd = await fixture({
      "package.json": pkg({
        "@mikro-orm/core": "7.2.9",
        "@mikro-orm/migrations": "7.2.9",
        "@mikro-orm/migrations-mongodb": "7.2.9",
      }),
      "node_modules/@mikro-orm/migrations/package.json": JSON.stringify({
        name: "@mikro-orm/migrations",
        version: "7.2.9",
      }),
      "node_modules/@mikro-orm/migrations-mongodb/package.json": JSON.stringify({
        name: "@mikro-orm/migrations-mongodb",
        version: "7.2.9",
      }),
    });
    const detected = await detectProject({ cwd, database: "postgres", userIdType: "TEXT" });
    expect(detected.versions["@mikro-orm/migrations"]).toBe("7.2.9");
    expect(detected.versions["@mikro-orm/migrations-mongodb"]).toBe("7.2.9");
  });
});
