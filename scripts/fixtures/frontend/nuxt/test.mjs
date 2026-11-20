import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import process from "node:process";
import { setTimeout } from "node:timers/promises";

import { checkBrowser } from "./fixture-shared/vue/check.mjs";

export default async function ({ cwd, run, chromium, profile }) {
  assert.match(await readFile(cwd + "/app/app.vue", "utf8"), /<XpAppProvider>\s*<NuxtLayout>/);
  run("bun", ["x", "--no-install", "nuxt", "typecheck"]);
  run("bun", ["x", "--no-install", "nuxt", "build"]);
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const origin = "http://127.0.0.1:" + port;
  const child = spawn("node", [".output/server/index.mjs"], {
    cwd,
    stdio: "inherit",
    env: { ...process.env, NITRO_HOST: "127.0.0.1", NITRO_PORT: String(port) },
  });
  const done = once(child, "exit");
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("Nitro exited " + child.exitCode);
      if (
        await globalThis.fetch(origin).then(
          (res) => res.ok,
          () => false,
        )
      )
        break;
      await setTimeout(100);
    }
    await checkBrowser({ chromium, origin, nuxt: true });
  } finally {
    child.kill();
    const timer = globalThis.setTimeout(() => child.kill("SIGKILL"), 3000);
    try {
      await done;
    } finally {
      globalThis.clearTimeout(timer);
    }
  }
  return profile.cases;
}
