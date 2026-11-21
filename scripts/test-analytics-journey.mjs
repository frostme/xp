import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const stage = await mkdtemp(join(tmpdir(), "xp-analytics-"));
const app = join(stage, "consumer");
const run = (command, args, cwd = app) => execFileSync(command, args, { cwd, stdio: "inherit" });

try {
  run("bun", ["pm", "pack", "--ignore-scripts", "--destination", stage], root);
  const archives = (await readdir(stage)).filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 1);
  await cp(join(root, "scripts/fixtures/analytics-journey"), join(app, "analytics-journey"), {
    recursive: true,
  });
  for (const file of ["database.mjs", "hosts.mjs"]) {
    await cp(join(root, "scripts/fixtures/xp-journey", file), join(app, "xp-journey", file));
  }
  await cp(join(root, "scripts/fixtures/xp-journey/xp.config.json"), join(app, "xp.config.json"));
  const dependencies = { "@frostme/xp": `file:${join(stage, archives[0])}` };
  for (const name of [
    "pg",
    "@types/pg",
    "@types/node",
    "express",
    "graphql",
    "graphql-yoga",
    "@apollo/server",
  ]) {
    dependencies[name] = JSON.parse(
      await readFile(join(root, "node_modules", name, "package.json"), "utf8"),
    ).version;
  }
  await writeFile(
    join(app, "package.json"),
    JSON.stringify({ private: true, type: "module", dependencies }),
  );
  run("bun", ["install", "--ignore-scripts", "--production"]);
  run(join(root, "node_modules/.bin/tsc"), [
    "--strict",
    "--target",
    "esnext",
    "--module",
    "nodenext",
    "--types",
    "node",
    "--noEmit",
    "analytics-journey/consumer.ts",
  ]);
  const setup = [
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
  ];
  run("node", setup);
  await cp(join(app, "migrations"), join(app, "base", "migrations"), { recursive: true });
  run("node", [...setup, "--analytics"]);
  run("node", [
    "--test",
    "analytics-journey/imports.test.mjs",
    "analytics-journey/capture.test.mjs",
    "analytics-journey/delivery.test.mjs",
  ]);
} finally {
  await rm(stage, { recursive: true, force: true });
}
