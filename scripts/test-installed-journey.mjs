import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stage = await mkdtemp(join(tmpdir(), "xp-installed-journey-"));
const app = join(stage, "consumer");
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: "inherit" });
try {
  run("bun", ["pm", "pack", "--ignore-scripts", "--destination", stage], root);
  const tarballs = (await readdir(stage)).filter((file) => file.endsWith(".tgz"));
  assert.equal(tarballs.length, 1);
  await cp(join(root, "scripts/fixtures/xp-journey"), app, { recursive: true });
  const dependencies = { "@frostme/xp": `file:${join(stage, tarballs[0])}` };
  // Test the same host versions installed by the repository's frozen lockfile.
  for (const name of [
    "react",
    "react-dom",
    "jsdom",
    "express",
    "graphql",
    "graphql-yoga",
    "@apollo/server",
    "pg",
  ]) {
    const installed = JSON.parse(
      await readFile(join(root, "node_modules", name, "package.json"), "utf8"),
    );
    dependencies[name] = installed.version;
  }
  await writeFile(
    join(app, "package.json"),
    JSON.stringify({ private: true, type: "module", dependencies }),
  );
  run("bun", ["install", "--ignore-scripts"], app);
  run(
    "node",
    [
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
    ],
    app,
  );
  run("node", ["--test", "journey.test.mjs"], app);
} finally {
  await rm(stage, { recursive: true, force: true });
}
