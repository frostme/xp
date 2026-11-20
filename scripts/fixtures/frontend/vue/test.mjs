import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";

import { checkBrowser } from "./fixture-shared/vue/check.mjs";

export default async function ({ cwd, run, chromium, profile, setup, journey }) {
  const wrapped = await readFile(cwd + "/src/App.vue", "utf8");
  assert.match(wrapped, /<XpAppProvider>/);
  setup(["--dry-run"]);
  assert.equal(await readFile(cwd + "/src/App.vue", "utf8"), wrapped);
  run("bun", ["x", "--no-install", "vue-tsc", "--noEmit"]);
  run("bun", ["x", "--no-install", "vite", "build", "--outDir", "dist/client"]);
  run("bun", [
    "x",
    "--no-install",
    "vite",
    "build",
    "--ssr",
    "src/server.ts",
    "--outDir",
    "dist/server",
  ]);
  const { start } = await import("./server.mjs");
  const server = await start(cwd);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = "http://127.0.0.1:" + server.address().port;
  try {
    if (journey) await journey(origin);
    else await checkBrowser({ chromium, origin, nuxt: false });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  return journey ? [profile.id + "-" + profile.journey] : profile.cases;
}
