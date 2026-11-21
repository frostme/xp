import { createRestLoader } from "@frostme/xp/client";
import { xpFastifyPlugin } from "@frostme/xp/server/fastify";
import Fastify from "fastify";
import assert from "node:assert/strict";

const runtime = {
  driverKind: "postgres" as const,
  async resolveCohort(id: unknown, slug: string) {
    assert.equal(id, 0);
    return { slug: slug + "_short" };
  },
};
const host = Fastify();
host.addHook("preHandler", async (req, reply) => {
  if (req.headers.authorization !== "Bearer session") return reply.code(401).send();
  Object.assign(req, { userId: 0 });
});
host.register(xpFastifyPlugin, { runtime, prefix: "/api" });
host.register(xpFastifyPlugin, {
  runtime,
  prefix: "/api",
  route: "/variant",
  resolveBody: ({ slug }) => ({ variant: slug }),
});
try {
  const origin = await host.listen({ host: "127.0.0.1", port: 0 });
  const headers = { authorization: "Bearer session" };
  const load = createRestLoader({ experimentHost: origin + "/api", headers });
  assert.equal(await load("delivery-copy"), "delivery-copy_short");
  const custom = createRestLoader({
    endpoint: origin + "/api/variant",
    headers,
    decode: (value) => {
      assert.ok(value && typeof value === "object" && "variant" in value);
      return value.variant;
    },
  });
  assert.equal(await custom("delivery-copy"), "delivery-copy_short");
  await assert.rejects(
    createRestLoader({ experimentHost: origin + "/api" })("delivery-copy"),
    /401/,
  );
} finally {
  await host.close();
}
