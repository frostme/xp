import { execFileSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";

const cwd = fileURLToPath(new URL(".", import.meta.url));
const root = fileURLToPath(new URL("../../", import.meta.url));
const stage = join(cwd, ".stage");
const exec = (bin, args) => execFileSync(bin, args, { cwd, stdio: "inherit" });
exec("bun", ["install", "--frozen-lockfile", "--ignore-scripts"]);
await rm(stage, { force: true, recursive: true });
try {
  await mkdir(stage);
  // The isolated TS 6 compiler resolves the emitted client declarations in the same layout as consumers.
  await cp(join(root, "dist/client"), join(stage, "client"), {
    recursive: true,
    filter: (path) => !path.endsWith("/svelte"),
  });
  await cp(join(root, "src/client/svelte"), join(stage, "client/svelte"), { recursive: true });
  exec("node_modules/.bin/svelte-check", ["--tsconfig", "./tsconfig.json"]);
  exec("node_modules/.bin/svelte-package", [
    "--input",
    ".stage/client/svelte",
    "--output",
    ".stage/pkg",
    "--tsconfig",
    "./tsconfig.json",
  ]);
  await cp(join(stage, "pkg"), join(root, "dist/client/svelte"), { recursive: true });
} finally {
  await rm(stage, { recursive: true, force: true });
}
