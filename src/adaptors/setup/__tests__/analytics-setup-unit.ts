import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { SetupDatabase, SetupOptions } from "~/interfaces/setup";

import { fingerprint } from "../filesystem";
import SetupGenerators from "../generators";
import ProjectManager from "../projectManager";
import { renderSql } from "../storage";

const dirs: string[] = [];
const manager = new ProjectManager(new SetupGenerators());

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function fixture(database: SetupDatabase, extra: SetupOptions = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), "xp-analytics-setup-"));
  dirs.push(cwd);
  await writeFile(path.join(cwd, "package.json"), '{"name":"analytics-host","type":"module"}');
  return {
    cwd,
    database,
    tableName: "xp-host",
    orm: "none",
    userStorage: "create",
    ...extra,
  } as const;
}

describe("additive analytics v1 storage setup", () => {
  it.each(["postgres", "mysql", "mssql", "mongodb", "dynamodb"] as const)(
    "installs on fresh and existing v3 %s and retains the base fingerprints",
    async (database) => {
      const options = await fixture(database);
      const base = await manager.planSetup(options);
      const fresh = await manager.planSetup({ ...options, analytics: true });
      expect(await readdir(options.cwd)).toEqual(["package.json"]);
      expect(base.files.some((file) => file.path.includes("analytics"))).toBe(false);
      const extension = fresh.files.filter((file) => file.path.includes("analytics"));
      expect(extension.length).toBeGreaterThan(0);
      if (database === "dynamodb") {
        const gsi = JSON.parse(extension[0]!.content);
        expect(gsi.GlobalSecondaryIndexUpdates[0].Create).toMatchObject({
          IndexName: "xp_analytics_due",
          Projection: { ProjectionType: "ALL" },
        });
      } else {
        const content = extension.map((file) => file.content).join("\n");
        expect(content).toContain("xp_analytics_deliveries");
        expect(content).toContain("xp_analytics_due_idx");
        expect(content).not.toMatch(/FOREIGN KEY|expireAfterSeconds|user_id/);
      }
      await manager.applySetup(base);
      const upgraded = await manager.planSetup({ cwd: options.cwd, analytics: true });
      for (const old of base.files.filter((file) => file.path !== ".xp/setup.json"))
        expect(upgraded.files.find((file) => file.path === old.path)).toMatchObject({
          content: old.content,
          action: "unchanged",
        });
      await manager.applySetup(upgraded);
      expect(
        JSON.parse(await readFile(path.join(options.cwd, ".xp/setup.json"), "utf8")),
      ).toMatchObject({ schemaVersion: 3, extensions: { analytics: 1 } });
      expect((await manager.applySetup(await manager.planSetup({ cwd: options.cwd }))).status).toBe(
        "unchanged",
      );
      const migration = upgraded.files.find((file) => file.path.includes("analytics"))!;
      await writeFile(path.join(options.cwd, migration.path), migration.content + "\n");
      await expect(manager.planSetup({ cwd: options.cwd, analytics: true })).rejects.toThrow(
        "Previously generated file changed",
      );
    },
  );

  it.each([1, 2])(
    "upgrades v%i before enabling capture and preserves other extension versions",
    async (version) => {
      const options = await fixture("postgres");
      const plan = await manager.planSetup(options);
      await manager.applySetup(plan);
      const file = path.join(options.cwd, ".xp/setup.json");
      const manifest = JSON.parse(await readFile(file, "utf8"));
      manifest.schemaVersion = version;
      const historical = renderSql(plan.options, { version });
      for (const entry of manifest.files) {
        const statements = entry.path.endsWith(".up.sql") ? historical.up : historical.down;
        const content = statements.join("\n\n") + "\n";
        await writeFile(path.join(options.cwd, entry.path), content);
        entry.hash = fingerprint(content);
      }
      manifest.extensions = { other: 2 };
      await writeFile(file, JSON.stringify(manifest));
      const upgraded = await manager.planSetup({ cwd: options.cwd, analytics: true });
      expect(upgraded.files.map((output) => output.path)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/_xp_storage_v3\.up\.sql$/),
          expect.stringMatching(/_xp_analytics_v1.up.sql$/),
        ]),
      );
      await manager.applySetup(upgraded);
      expect(JSON.parse(await readFile(file, "utf8")).extensions).toEqual({
        other: 2,
        analytics: 1,
      });
    },
  );
});
