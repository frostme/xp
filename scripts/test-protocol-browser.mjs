import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const stage = await mkdtemp(join(tmpdir(), "xp-grpc-web-"));
function run(command, args, cwd = stage) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

try {
  run("bun", ["pm", "pack", "--ignore-scripts", "--destination", stage], root);
  const [archive] = (await readdir(stage)).filter((file) => file.endsWith(".tgz"));
  const dependencies = { "@frostme/xp": `file:./${archive}` };
  for (const name of [
    "@grpc/grpc-js",
    "@grpc/proto-loader",
    "@connectrpc/connect-node",
    "@types/node",
    "playwright",
  ]) {
    dependencies[name] = JSON.parse(
      await readFile(join(root, "node_modules", name, "package.json")),
    ).version;
  }
  await writeFile(
    join(stage, "package.json"),
    JSON.stringify({ private: true, type: "module", dependencies }),
  );
  await cp(join(root, "scripts/fixtures/protocol-browser"), stage, { recursive: true });
  run("bun", ["install", "--production", "--ignore-scripts"]);
  run(join(root, "node_modules/.bin/tsc"), [
    "--strict",
    "--target",
    "esnext",
    "--types",
    "node",
    "--module",
    "nodenext",
    "--noEmit",
    "types.ts",
  ]);
  run("bun", ["build", "page.ts", "--outdir=web", "--target=browser", "--minify"]);
  run("node", ["journey.mjs"]);
} finally {
  await rm(stage, { recursive: true, force: true });
}
