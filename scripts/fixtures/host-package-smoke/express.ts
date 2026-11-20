import type { AddressInfo } from "node:net";

import { xpMiddleware } from "@frostme/xp";
import { createRestLoader } from "@frostme/xp/client";
import { xpMiddleware as configureXp } from "@frostme/xp/server/express";
import express from "express";
import assert from "node:assert/strict";
import { once } from "node:events";

const app = express();
app.locals.xp = {
  driverKind: "postgres",
  async resolveCohort(id: unknown, slug: string) {
    assert.equal(id, 0);
    return { slug: slug + "_on" };
  },
};
app.use((request, _response, next) => {
  Object.assign(request, { userId: 0 });
  next();
});
app.use("/api", xpMiddleware);
app.use("/custom", configureXp({ route: "/decide", connection: app.locals.xp }));
const http = app.listen(0, "127.0.0.1");
try {
  await once(http, "listening");
  const origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  for (const route of ["/api/xp", "/custom/decide"]) {
    assert.equal(await createRestLoader({ endpoint: origin + route })("checkout"), "checkout_on");
  }
} finally {
  await new Promise<void>((resolve, reject) =>
    http.close((error) => (error ? reject(error) : resolve())),
  );
}
