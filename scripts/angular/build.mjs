import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

const tools = import.meta.dirname;
const output = resolve(tools, "../../dist/client/angular");
execFileSync("bun", ["install", "--frozen-lockfile", "--ignore-scripts"], {
  cwd: tools,
  stdio: "inherit",
});
const temp = await mkdtemp(join(tools, "node_modules/.xp-angular-"));
try {
  execFileSync(
    process.execPath,
    [
      join(tools, "node_modules/@angular/compiler-cli/bundles/src/bin/ngc.js"),
      "-p",
      join(tools, "tsconfig.json"),
      "--outDir",
      temp,
    ],
    { stdio: "inherit" },
  );
  // This entry has one source module. Its ESM is already flat and references the shared client.
  await mkdir(join(output, "fesm2022"), { recursive: true });
  await copyFile(join(temp, "index.js"), join(output, "fesm2022/xp-angular.mjs"));
  await copyFile(join(temp, "index.d.ts"), join(output, "index.d.ts"));
} finally {
  await rm(temp, { recursive: true, force: true });
}
