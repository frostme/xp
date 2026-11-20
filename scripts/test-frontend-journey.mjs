import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { URL, fileURLToPath, pathToFileURL } from "node:url";

import { authenticatedApi, runLiveBrowser } from "./frontend-live-browser.mjs";
import { loadProfiles, runProfile, withTarball } from "./test-frontend.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const profiles = (await loadProfiles()).filter(
  (p) => p.journey && (!process.env.XP_PROFILE || p.id === process.env.XP_PROFILE),
);
assert.ok(
  profiles.length,
  "No PostgreSQL frontend cases for " + (process.env.XP_PROFILE ?? "manifest"),
);
await withTarball(async (tarball) => {
  const stage = await mkdtemp(join(tmpdir(), "xp-frontend-host-"));
  const run = (program, args) =>
    execFileSync(program, args, { cwd: stage, stdio: "inherit", timeout: 300000 });
  const local = (path) => import(pathToFileURL(join(stage, path)).href);
  try {
    await cp(join(root, "scripts/fixtures/xp-journey"), stage, { recursive: true });
    const dependencies = { "@frostme/xp": "file:" + tarball };
    for (const name of ["pg", "express", "graphql", "graphql-yoga", "@apollo/server", "react"]) {
      dependencies[name] = JSON.parse(
        await readFile(join(root, "node_modules", name, "package.json"), "utf8"),
      ).version;
    }
    await writeFile(
      join(stage, "package.json"),
      JSON.stringify({ private: true, type: "module", dependencies }),
    );
    run("bun", ["install", "--ignore-scripts"]);
    run("node", [
      "node_modules/@frostme/xp/dist/cli/bin.js",
      "setup",
      "--orm",
      "none",
      "--database",
      "postgres",
      "--user-storage",
      "reuse",
      "--user-id-type",
      "TEXT",
      "--migrations-dir",
      "migrations",
      "--yes",
    ]);
    const { setupDatabase, assignedSlugs } = await local("database.mjs");
    const { startHosts } = await local("hosts.mjs");
    const { initializeXp } = await local("node_modules/@frostme/xp/dist/server/index.js");
    for (const profile of profiles) {
      const database = await setupDatabase(stage);
      try {
        const runtime = await initializeXp({ connection: database.pool, cwd: stage });
        await runtime.joinCohort("alice", "delivery-copy", "delivery-copy_short");
        await runtime.joinCohort("bob", "delivery-copy", "delivery-copy_control");
        const hosts = await startHosts(runtime);
        try {
          const transport = hosts.transports.find(
            (t) => t.name.split(" ")[0].toLowerCase() === profile.journey,
          );
          assert.ok(transport, "Unknown transport " + profile.journey);
          const api = await authenticatedApi(transport);
          const previous = process.env.XP_JOURNEY_ENDPOINT;
          try {
            process.env.XP_JOURNEY_ENDPOINT = api.origin;
            let executed = 0;
            await runProfile(profile, {
              tarball,
              journeyCases: [profile.id + "-" + profile.journey],
              transport: transport.protocol,
              endpoint: transport.protocol === "rest" ? "/xp" : "/graphql",
              journey: async (app, chromium) => {
                await runLiveBrowser({
                  profile,
                  chromium,
                  app,
                  api,
                  transport,
                  database,
                  assignedSlugs,
                });
                executed++;
              },
            });
            assert.equal(executed, 1, "Browser journey did not run for " + profile.id);
          } finally {
            if (previous === undefined) delete process.env.XP_JOURNEY_ENDPOINT;
            else process.env.XP_JOURNEY_ENDPOINT = previous;
            api.release();
            await api.close();
          }
        } finally {
          await hosts.close();
        }
      } finally {
        await database.close();
      }
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});
