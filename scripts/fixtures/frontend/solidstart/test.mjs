import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";

import { checkBrowser } from "./fixture-shared/solid/check.mjs";

export default async function test({ cwd, chromium, run }) {
  const source = await readFile(path.join(cwd, "src/app.tsx"), "utf8");
  assert.match(source, /<XpRouterRoot>\{props\.children\}<\/XpRouterRoot>/);
  run("bun", ["run", "tsc", "--noEmit"]);
  run("bun", ["run", "vite", "build"]);
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = String(socket.address().port);
  await new Promise((resolve) => socket.close(resolve));
  const server = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd,
    stdio: "inherit",
    env: { ...process.env, PORT: port, HOST: "127.0.0.1" },
  });
  const finished = once(server, "exit");
  const origin = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 30000;
    while (!(await globalThis.fetch(origin).catch(() => null))?.ok) {
      assert.ok(
        server.exitCode === null && Date.now() < deadline,
        "SolidStart failed to become ready",
      );
      await delay(150);
    }
    const browser = await chromium.launch();
    try {
      await checkBrowser({ browser, origin, start: true });
    } finally {
      await browser.close();
    }
    return [
      "nested-scopes",
      "transports",
      "mixed-preload",
      "isolated-hydration",
      "retry",
      "reactive-slug",
      "client-navigation",
    ];
  } finally {
    if (server.exitCode === null) server.kill();
    const kill = setTimeout(() => server.kill("SIGKILL"), 3000);
    try {
      await finished;
    } finally {
      clearTimeout(kill);
    }
  }
}
