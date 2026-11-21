import process from "node:process";
import { URL } from "node:url";
import pg from "pg";

import { startWorker } from "./consumer.ts";

// The parent hands this process the search_path of its disposable database schema.
const { connection, origins, only, action, crashAfterAcceptance } = await new Promise((resolve) =>
  process.once("message", resolve),
);
const pool = new pg.Pool(connection);
const shutdown = new globalThis.AbortController();
process.once("SIGTERM", () => shutdown.abort());
try {
  const worker = startWorker(
    pool,
    (provider) => async (input, options) => {
      const request = new globalThis.Request(input, options);
      const url = new URL(request.url);
      const headers = new globalThis.Headers(request.headers);
      headers.set("x-fixture-original-origin", url.origin);
      const response = await globalThis.fetch(origins[provider] + url.pathname + url.search, {
        method: request.method,
        headers,
        body: await request.arrayBuffer(),
        signal: request.signal,
      });
      if (crashAfterAcceptance && response.ok) {
        // The remote response arrived, but the adaptor has not returned to the worker's fenced ack.
        process.kill(process.pid, "SIGKILL");
        await new Promise(() => {});
      }
      return response;
    },
    only,
  );
  process.send({ type: "ready" });
  if (action === "run") await worker.run({ signal: shutdown.signal });
  else await worker.drainOnce();
} finally {
  await pool.end();
  process.disconnect();
}
