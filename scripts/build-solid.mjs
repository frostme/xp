import { execFileSync } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
for (const major of [1, 2]) {
  const project = path.join(root, "scripts/toolchains", `solid-v${major}`);
  const stage = path.join(project, ".cache/src");
  const src = path.join(root, "src/client/solid");
  const output = path.join(root, "dist/client/solid");
  execFileSync("bun", ["install", "--frozen-lockfile"], { cwd: project, stdio: "inherit" });
  await rm(path.dirname(stage), { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  await mkdir(output, { recursive: true });
  await copyFile(path.join(src, "index.tsx"), path.join(stage, "index.tsx"));
  await copyFile(
    path.join(src, major === 1 ? "v1/lifecycle.ts" : "lifecycle.ts"),
    path.join(stage, "lifecycle.ts"),
  );
  await copyFile(path.join(root, "dist/client/gates.d.ts"), path.join(stage, "../gates.d.ts"));
  execFileSync("bun", ["run", "tsc", "-p", "tsconfig.json"], { cwd: project, stdio: "inherit" });
  await copyFile(
    path.join(project, ".cache/types/index.d.ts"),
    path.join(output, `v${major}.d.ts`),
  );
  for (const target of ["browser", "server"]) {
    execFileSync("bun", ["run", "vite", "build"], {
      cwd: project,
      stdio: "inherit",
      env: { ...process.env, XP_SOLID_TARGET: target },
    });
  }
}
