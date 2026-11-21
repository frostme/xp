import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const protocols = process.argv.includes("--protocols");
const stage = await mkdtemp(join(tmpdir(), "xp-installed-journey-"));
const app = join(stage, "consumer");
const fixture = join(app, "xp-journey");
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: "inherit" });
try {
  run("bun", ["pm", "pack", "--ignore-scripts", "--destination", stage], root);
  const tarballs = (await readdir(stage)).filter((file) => file.endsWith(".tgz"));
  assert.equal(tarballs.length, 1);
  await cp(join(root, "scripts/fixtures/xp-journey"), fixture, { recursive: true });
  await rename(join(fixture, "xp.config.json"), join(app, "xp.config.json"));
  if (protocols) {
    await cp(join(root, "scripts/fixtures/protocol-browser"), join(app, "protocol-browser"), {
      recursive: true,
    });
  }
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
    ...(protocols
      ? [
          "fastify",
          "@nestjs/common",
          "@nestjs/core",
          "@nestjs/platform-express",
          "@nestjs/platform-fastify",
          "reflect-metadata",
          "rxjs",
          "@grpc/grpc-js",
          "@grpc/proto-loader",
          "@connectrpc/connect-node",
          "soap",
          "playwright",
        ]
      : []),
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
      join(app, "node_modules/@frostme/xp/dist/cli/bin.js"),
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
  if (protocols) {
    run(
      "bun",
      [
        "build",
        "xp-journey/protocol-page.mjs",
        "--target=browser",
        "--minify",
        "--outfile=web/page.js",
      ],
      app,
    );
    run(
      "bun",
      [
        "build",
        "protocol-browser/react.tsx",
        "--target=browser",
        "--splitting",
        "--minify",
        "--outdir=web",
      ],
      app,
    );
  }
  run(
    "node",
    ["--test", join(fixture, protocols ? "protocol-journey.test.mjs" : "journey.test.mjs")],
    app,
  );
} finally {
  await rm(stage, { recursive: true, force: true });
}
