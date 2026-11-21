import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod } from "node:fs/promises";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { envoyOrigin, pageOrigin, rpcPath } from "./hosts.mjs";

export async function checkPreflight(origin) {
  const headers = ["authorization", "content-type", "x-grpc-web", "x-user-agent"];
  const result = await globalThis.fetch(origin + rpcPath, {
    method: "OPTIONS",
    headers: {
      origin: pageOrigin,
      "access-control-request-method": "POST",
      "access-control-request-headers": headers.join(","),
    },
    signal: globalThis.AbortSignal.timeout(2000),
  });
  assert.ok(result.ok, `Preflight failed with ${result.status}`);
  assert.equal(result.headers.get("access-control-allow-origin"), pageOrigin);
  assert.equal(result.headers.get("access-control-allow-credentials"), "true");
  assert.match(result.headers.get("access-control-allow-methods"), /POST/i);
  const allowed = result.headers.get("access-control-allow-headers").toLowerCase().split(/,\s*/);
  for (const header of headers) assert.ok(allowed.includes(header), header);
}

export async function startEnvoy() {
  // The container reads the disposable consumer's bind mount under its own UID.
  await chmod(new globalThis.URL("./envoy.yaml", import.meta.url), 0o644);
  const compose = (...args) =>
    execFileSync(
      "docker",
      [
        "compose",
        "-p",
        `xp-protocol-${process.pid}`,
        "-f",
        fileURLToPath(new globalThis.URL("./compose.yml", import.meta.url)),
        ...args,
      ],
      { stdio: "inherit" },
    );
  const close = () => compose("down", "--timeout", "1");
  try {
    compose("up", "-d");
    for (let attempt = 0; ; attempt++) {
      try {
        await checkPreflight(envoyOrigin);
        return close;
      } catch (error) {
        if (attempt === 80) throw error;
        await delay(100);
      }
    }
  } catch (error) {
    try {
      compose("logs", "--tail", "20");
    } finally {
      close();
    }
    throw error;
  }
}
