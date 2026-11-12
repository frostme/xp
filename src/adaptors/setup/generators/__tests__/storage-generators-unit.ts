import { parseSync } from "@swc/core";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

import type { ProjectDetection, ResolvedSetup, SetupDatabase, SetupOrm } from "~/interfaces/setup";

import { MONGO_INDEXES, renderSql } from "../../storage";
import { generateStandard } from "../standard";

function options(database: SetupDatabase = "postgres", orm: SetupOrm = "none"): ResolvedSetup {
  return {
    cwd: "/application",
    orm,
    database,
    migrationsDir: "migrations",
    models: false,
    modelsDir: "models",
    language: "javascript",
    moduleFormat: "commonjs",
    userStorage: "reuse",
    userIdType:
      database === "postgres"
        ? "text"
        : database === "mysql"
          ? "varchar(191)"
          : database === "mssql"
            ? "nvarchar(255)"
            : "string",
    tableName: "experiments",
  };
}
const project: ProjectDetection = {
  cwd: "/application",
  options: {},
  ormCandidates: [],
  databaseCandidates: [],
  versions: {
    mongodb: "7.8.0",
    "sequelize-cli": "6.6.5",
    "@mikro-orm/migrations": "7.2.9",
    "@mikro-orm/migrations-mongodb": "7.2.9",
  },
  packageManager: "bun",
  sources: [],
  warnings: [],
  missing: [],
  inputs: {},
};

function loadCjs(code: string, dependencies: Record<string, unknown> = {}): Record<string, any> {
  const module = { exports: {} };
  runInNewContext(code, {
    module,
    exports: module.exports,
    require: (name: string) => dependencies[name],
    process: { env: {}, argv: [] },
    console,
  });
  return module.exports;
}

describe("canonical storage generation", () => {
  it.each(["postgres", "mysql", "mssql"] as const)(
    "preserves required constraints and existing users for %s",
    (database) => {
      const sql = renderSql(options(database));
      expect(sql.up.join("\n")).not.toMatch(/CREATE TABLE users/);
      expect(sql.up.join("\n")).toContain(
        "FOREIGN KEY (cohort_id, experiment_id) REFERENCES cohorts(id, experiment_id)",
      );
      expect(sql.up.join("\n")).toContain("UNIQUE (user_id, experiment_id)");
      expect(sql.up.join("\n")).toContain("UNIQUE (id, experiment_id)");
      expect(sql.up.join("\n")).toContain("CHECK (percentage >= 0 AND percentage <= 100)");
      expect(sql.down).toEqual([
        "DROP TABLE user_cohorts;",
        "DROP TABLE cohorts;",
        "DROP TABLE experiments;",
      ]);
      expect(sql.up.join("\n")).not.toContain("CASCADE");
    },
  );
  it("scaffolds users only explicitly and retains the exact MySQL key contract", () => {
    const sql = renderSql({
      ...options("mysql"),
      userStorage: "create",
      userIdType: "varchar(64)",
      userIdCharset: "ascii",
      userIdCollation: "ascii_bin",
    });
    expect(sql.up[0]).toContain("id varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL");
    expect(sql.up.join("\n")).toContain(
      "user_id varchar(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL",
    );
    expect(sql.down.join("\n")).not.toContain("DROP TABLE users");
  });
  it("uses scalar-capable SQL Server JSON validation and PostgreSQL JSON null", () => {
    expect(renderSql(options("mssql")).up.join("\n")).toContain("ISJSON(value, VALUE) = 1");
    expect(renderSql(options()).up.join("\n")).toContain("JSONB NOT NULL DEFAULT 'null'::jsonb");
    expect(renderSql(options("mysql")).up.join("\n")).toContain("value JSON NOT NULL,");
  });
  it.each(["text); DROP TABLE users;--", "varchar(0)", "int default 0", "binary(16)"])(
    "rejects unsupported or executable user type %s",
    (userIdType) => {
      expect(() => renderSql({ ...options("mysql"), userIdType })).toThrow(/Unsupported/);
    },
  );
  it("rejects charset/collation on non-character user keys", () => {
    expect(() =>
      renderSql({ ...options("mysql"), userIdType: "int unsigned", userIdCollation: "ascii_bin" }),
    ).toThrow(/character/);
  });
});

for (const database of ["postgres", "mysql", "mssql"] as const) {
  describe(`${database} migration wrappers`, () => {
    it.each(["sequelize", "typeorm", "mikroorm", "kysely", "knex"] as const)(
      "executes complete ordered up/down SQL through %s",
      async (orm) => {
        const setting = options(database, orm);
        const result = await generateStandard(setting, project);
        const file = result.files.find((entry) => entry.path.startsWith("migrations/"))!;
        const seen: string[] = [];
        class Migration {
          addSql(sql: string) {
            seen.push(sql);
          }
        }
        const dependencies = {
          "@mikro-orm/migrations": { Migration },
          kysely: {
            sql: {
              raw: (sql: string) => ({
                execute: async () => {
                  seen.push(sql);
                },
              }),
            },
          },
        };
        const loaded = loadCjs(file.content, dependencies);
        const migration =
          orm === "typeorm" || orm === "mikroorm" ? new (Object.values(loaded)[0])() : loaded;
        const runner =
          orm === "sequelize"
            ? {
                sequelize: {
                  query: async (sql: string) => {
                    seen.push(sql);
                  },
                },
              }
            : {
                query: async (sql: string) => {
                  seen.push(sql);
                },
                raw: async (sql: string) => {
                  seen.push(sql);
                },
              };
        await migration.up(runner);
        expect(seen).toEqual(renderSql(setting).up);
        seen.length = 0;
        await migration.down(runner);
        expect(seen).toEqual(renderSql(setting).down);
      },
    );
  });
}

describe("document provisioning", () => {
  it("runs Mongo bootstrap only when explicitly called, validates users, and creates required indexes", async () => {
    const { files } = await generateStandard(options("mongodb"), project);
    const calls: unknown[] = [];
    const findOne = vi.fn().mockResolvedValue(null);
    const up = loadCjs(files[0]!.content, {
      mongodb: {
        MongoClient: vi.fn(() => {
          throw new Error("must not connect on import");
        }),
      },
    })["up"];
    const db = {
      admin: () => ({ command: async () => ({ setName: "rs0" }) }),
      listCollections: () => ({ toArray: async () => [{ name: "users" }] }),
      collection: (name: string) => ({
        findOne,
        createIndex: async (key: unknown, opts: unknown) => {
          calls.push([name, key, opts]);
        },
      }),
      createCollection: async (name: string) => {
        calls.push([name]);
      },
    };
    expect(calls).toEqual([]);
    await up(db);
    expect(calls.slice(0, 3)).toEqual([["experiments"], ["cohorts"], ["user_cohorts"]]);
    expect(calls.slice(3)).toEqual(
      MONGO_INDEXES.map((index) => [index.collection, index.key, { unique: index.unique }]),
    );
    findOne.mockResolvedValue({ _id: "incompatible" });
    calls.length = 0;
    await expect(up(db)).rejects.toThrow(/physical users.id/);
    expect(calls).toEqual([]);
  });
  it("refuses Mongo standalone deployments before changing collections", async () => {
    const { files } = await generateStandard(options("mongodb"), project);
    const up = loadCjs(files[0]!.content, { mongodb: {} })["up"];
    await expect(up({ admin: () => ({ command: async () => ({}) }) })).rejects.toThrow(
      /replica set/,
    );
  });
  it("generates only the required DynamoDB keys and billing configuration", async () => {
    const { files } = await generateStandard(options("dynamodb"), project);
    expect(JSON.parse(files[0]!.content)).toEqual({
      TableName: "experiments",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      BillingMode: "PAY_PER_REQUEST",
    });
  });
});

describe("supporting output", () => {
  it.each(["sequelize", "typeorm", "mikroorm", "kysely", "knex"] as const)(
    "produces parseable typed %s files only when enabled",
    async (orm) => {
      const plain = await generateStandard(options("postgres", orm), project);
      expect(plain.files).toHaveLength(orm === "mikroorm" ? 2 : 1);
      const result = await generateStandard(
        { ...options("postgres", orm), models: true, language: "typescript", moduleFormat: "esm" },
        project,
      );
      expect(result.files).toHaveLength(orm === "mikroorm" ? 3 : 2);
      for (const file of result.files.filter((entry) => !entry.path.endsWith(".json")))
        expect(() =>
          parseSync(file.content, {
            syntax: file.path.endsWith(".cjs") ? "ecmascript" : "typescript",
          }),
        ).not.toThrow();
    },
  );
  it.each(["mongoose", "typeorm", "mikroorm"] as const)(
    "keeps Mongo physical identities and version in %s output",
    async (orm) => {
      const result = await generateStandard(
        { ...options("mongodb", orm), language: "typescript", models: true },
        project,
      );
      const model = result.files[1]!;
      expect(() => parseSync(model.content, { syntax: "typescript" })).not.toThrow();
      expect(model.content).toContain("version");
      expect(model.content).toContain("user_cohorts");
      if (orm === "mongoose") {
        expect(model.content).toContain("id: false");
        expect(model.content).toContain("autoCreate: false");
        expect(model.content).toContain("autoIndex: false");
      }
    },
  );
});
