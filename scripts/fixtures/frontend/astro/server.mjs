import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import process from "node:process";
import { setTimeout } from "node:timers/promises";

export async function withAstro({ cwd, run }, check) {
  run("bun", ["run", "build"]);
  const reservation = createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["dist/server/entry.mjs"], {
    cwd,
    env: { ...process.env, XP_ASTRO_TEST_ORIGIN: origin, HOST: "127.0.0.1", PORT: String(port) },
    stdio: "inherit",
  });
  const stopped = once(child, "exit");
  try {
    const until = Date.now() + 30000;
    for (;;) {
      if (child.exitCode !== null || Date.now() >= until) throw new Error("Astro failed to start");
      if (
        await globalThis
          .fetch(origin + "/static/", { signal: globalThis.AbortSignal.timeout(1500) })
          .then((r) => r.ok)
          .catch(() => false)
      )
        break;
      await setTimeout(100);
    }
    return await check(origin);
  } finally {
    if (child.exitCode === null) child.kill();
    if (
      !(await Promise.race([stopped.then(() => true), setTimeout(5000, false, { ref: false })]))
    ) {
      child.kill("SIGKILL");
      await stopped;
    }
  }
}
