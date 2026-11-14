import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stage = await mkdtemp(path.join(tmpdir(), "xp-schema-toolchains-"));
try {
  const profiles = {
    sql: {
      prisma: "7.10.1",
      "@prisma/client": "7.10.1",
      "drizzle-orm": "0.45.4",
      "drizzle-kit": "0.31.11",
    },
    mongo: { prisma: "6.19.3", "@prisma/client": "6.19.3" },
  };
  for (const [name, dependencies] of Object.entries(profiles)) {
    const directory = path.join(stage, name);
    await mkdir(directory);
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ private: true, type: "module", dependencies }),
    );
    execFileSync("bun", ["install", "--ignore-scripts"], { cwd: directory, stdio: "inherit" });
  }
  execFileSync(
    path.join(root, "node_modules/.bin/vitest"),
    [
      "run",
      "--config",
      "vitest.unit.config.ts",
      "src/adaptors/setup/generators/__tests__/schema-generators-unit.ts",
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        XP_SCHEMA_TOOLS_NODE_MODULES: path.join(stage, "sql/node_modules"),
        XP_PRISMA_MONGO_NODE_MODULES: path.join(stage, "mongo/node_modules"),
      },
    },
  );
} finally {
  await rm(stage, { recursive: true, force: true });
}
