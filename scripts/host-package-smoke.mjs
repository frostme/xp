import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import console from "node:console";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(root, "scripts", "fixtures", "host-package-smoke");
const compiler = join(root, "node_modules", ".bin", "tsc");
const stage = await mkdtemp(join(tmpdir(), "xp-packed-hosts-"));
function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

const hosts = [
  {
    name: "headless",
    peers: ["@types/react"],
    sources: ["headless.ts"],
    execute: "compiled/headless.js",
  },
  { name: "root", peers: [], sources: ["root.ts"], execute: "compiled/root.js" },
  {
    name: "express",
    peers: ["express", "@types/express"],
    sources: ["express.ts"],
    execute: "compiled/express.js",
  },
  {
    name: "fastify",
    peers: ["fastify"],
    sources: ["fastify.ts"],
    execute: "compiled/fastify.js",
  },
  ...["express", "fastify"].map((platform) => ({
    name: `nest-${platform}`,
    peers: [
      "@nestjs/common",
      "@nestjs/core",
      `@nestjs/platform-${platform}`,
      "reflect-metadata",
      "rxjs",
      ...(platform === "express" ? ["express", "@types/express"] : ["fastify"]),
    ],
    sources: ["nestjs.ts", `nest-${platform}.ts`],
    execute: `compiled/nest-${platform}.js`,
  })),
  // Compile the xp contract strictly. Yoga's own lru-cache v10 declarations are
  // incompatible with TypeScript 7's Map iterators, so run its host fixture as JS.
  {
    name: "yoga",
    peers: ["graphql", "graphql-yoga"],
    sources: ["graphql.ts"],
    execute: "compiled/yoga.mjs",
  },
  {
    name: "apollo",
    peers: ["graphql", "@apollo/server"],
    sources: ["apollo.ts", "graphql.ts"],
    execute: "compiled/apollo.js",
  },
  {
    name: "react",
    peers: ["react", "react-dom", "@types/react", "@types/react-dom"],
    sources: ["browser.tsx"],
    execute: "compiled/render.mjs",
  },
];

function checkIsolatedPeers(directory, peers) {
  const require = createRequire(join(directory, "package.json"));
  for (const name of [
    "pg",
    "mysql2",
    "mssql",
    "mongodb",
    "@aws-sdk/lib-dynamodb",
    "sequelize",
    "express",
    "fastify",
    "graphql",
    "graphql-yoga",
    "@apollo/server",
    "react-dom",
    "vue",
    "@angular/core",
    "svelte",
    "solid-js",
    "@solidjs/web",
    "astro",
    "@nestjs/common",
    "@nestjs/core",
    "@nestjs/platform-fastify",
    "@nestjs/platform-express",
  ]) {
    if (!peers.includes(name)) {
      assert.throws(
        () => require.resolve(name),
        { code: "MODULE_NOT_FOUND" },
        `Unexpected peer ${name}`,
      );
    }
  }
  if (!peers.includes("express")) {
    assert.throws(() => require.resolve("@types/express/package.json"), {
      code: "MODULE_NOT_FOUND",
    });
  }
}

async function checkBrowserGraph(directory) {
  run(
    "bun",
    ["build", "browser.tsx", "--target=browser", "--outdir=web", "--metafile=browser-meta.json"],
    directory,
  );
  const meta = JSON.parse(await readFile(join(directory, "browser-meta.json"), "utf8"));
  const inputs = Object.keys(meta.inputs);
  for (const entry of ["dist/client/index.js", "dist/client/react/index.js"]) {
    assert.ok(
      inputs.some((input) => input.endsWith("/" + entry)),
      `Missing browser input: ${entry}`,
    );
  }
  // Inspect the complete input graph, including imports elided from the emitted JS.
  const packages =
    /(?:^|\/)(?:ink|pg|mysql2|mssql|tedious|mongodb|sequelize|express|graphql|graphql-yoga|@apollo\/server|@aws-sdk\/[^/]+)(?:\/|$)/;
  const serverFiles = /\/dist\/(?:server|cli|config|adaptors|use-cases|frameworks)(?:\/|$)/;
  const forbidden = (name) =>
    isBuiltin(name) || name.startsWith("node:") || packages.test(name) || serverFiles.test(name);
  for (const path of inputs) assert.ok(!forbidden(path), `Server module in browser graph: ${path}`);
  for (const module of [...Object.values(meta.inputs), ...Object.values(meta.outputs)]) {
    for (const imported of module.imports) {
      assert.ok(!forbidden(imported.path), `Server import in browser graph: ${imported.path}`);
      if (imported.original)
        assert.ok(!forbidden(imported.original), `Server import: ${imported.original}`);
    }
  }
}

try {
  run("bun", ["pm", "pack", "--ignore-scripts", "--destination", stage], root);
  const archives = (await readdir(stage)).filter((file) => file.endsWith(".tgz"));
  assert.equal(archives.length, 1);
  for (const host of hosts) {
    const directory = join(stage, host.name);
    await mkdir(directory);
    const dependencies = { "@frostme/xp": `file:${join(stage, archives[0])}` };
    for (const peer of ["@types/node", ...host.peers]) {
      const installed = JSON.parse(
        await readFile(join(root, "node_modules", peer, "package.json"), "utf8"),
      );
      dependencies[peer] = installed.version;
    }
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ private: true, type: "module", dependencies }),
    );
    for (const file of host.sources) await cp(join(fixtures, file), join(directory, file));
    run("bun", ["install", "--production", "--ignore-scripts"], directory);
    checkIsolatedPeers(directory, host.peers);
    run(
      compiler,
      [
        "--strict",
        "--types",
        "node",
        "--target",
        "esnext",
        "--module",
        "nodenext",
        "--moduleResolution",
        "nodenext",
        "--experimentalDecorators",
        "--jsx",
        "react-jsx",
        "--outDir",
        "compiled",
        ...host.sources,
      ],
      directory,
    );
    if (host.execute.endsWith(".mjs"))
      await cp(join(fixtures, basename(host.execute)), join(directory, host.execute));
    run("node", [host.execute], directory);
    if (host.name === "react") await checkBrowserGraph(directory);
    console.log(`Packed host smoke passed: ${host.name}`);
  }
} finally {
  await rm(stage, { recursive: true, force: true });
}
