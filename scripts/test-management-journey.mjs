import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stage = await mkdtemp(join(tmpdir(), "xp-management-journey-"));
const app = join(stage, "consumer");
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: "inherit" });
try {
  run("bun", ["pm", "pack", "--ignore-scripts", "--destination", stage], root);
  const tarballs = (await readdir(stage)).filter((file) => file.endsWith(".tgz"));
  assert.equal(tarballs.length, 1);
  await cp(join(root, "scripts/fixtures/management-journey"), app, { recursive: true });
  await cp(join(root, "scripts/fixtures/xp-journey/database.mjs"), join(app, "database.mjs"));
  const dependencies = { "@frostme/xp": `file:${join(stage, tarballs[0])}` };
  for (const name of ["pg", "express", "playwright"]) {
    const installed = JSON.parse(
      await readFile(join(root, "node_modules", name, "package.json"), "utf8"),
    );
    dependencies[name] = installed.version;
  }
  await writeFile(
    join(app, "package.json"),
    JSON.stringify({ type: "module", private: true, dependencies }),
  );
  run("bun", ["install", "--ignore-scripts"], app);
  const installedRoot = join(app, "node_modules/@frostme/xp");
  for (const path of ["review", "docs/management-design"]) {
    await assert.rejects(access(join(installedRoot, path)), { code: "ENOENT" });
  }
  for (const path of ["index.js", "index.d.ts", "ui/assets/app.js", "ui/assets/app.css"]) {
    assert.ok((await readFile(join(installedRoot, "dist/server/management", path))).length > 0);
  }
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
  if (process.env.XP_MANAGEMENT_EVIDENCE)
    process.env.XP_MANAGEMENT_EVIDENCE = resolve(process.env.XP_MANAGEMENT_EVIDENCE);
  run("node", ["--test", "journey.test.mjs"], app);
} finally {
  await rm(stage, { recursive: true, force: true });
}
