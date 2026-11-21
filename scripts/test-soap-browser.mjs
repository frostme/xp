import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stage = await mkdtemp(join(tmpdir(), "xp-soap-"));
const run = (command, args, cwd = stage) => execFileSync(command, args, { cwd, stdio: "inherit" });
try {
  run("bun", ["pm", "pack", "--ignore-scripts", "--destination", stage], root);
  const archive = (await readdir(stage)).find((file) => file.endsWith(".tgz"));
  const dependencies = { "@frostme/xp": "file:./" + archive };
  for (const name of ["soap", "playwright", "@types/node"]) {
    dependencies[name] = JSON.parse(
      await readFile(join(root, "node_modules", name, "package.json"), "utf8"),
    ).version;
  }
  await writeFile(
    join(stage, "package.json"),
    JSON.stringify({ private: true, type: "module", dependencies }),
  );
  await cp(join(root, "scripts/fixtures/soap"), stage, { recursive: true });
  run("bun", ["install", "--production", "--ignore-scripts"]);
  run(join(root, "node_modules/.bin/tsc"), [
    "--strict",
    "--noEmit",
    "--types",
    "node",
    "--module",
    "NodeNext",
    "--target",
    "esnext",
    "consumer.ts",
  ]);
  run("bun", ["build", "browser.js", "--target=browser", "--outfile=bundle.js"]);
  run("node", ["journey.mjs"]);
} finally {
  await rm(stage, { recursive: true, force: true });
}
