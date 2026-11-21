import type { FastifyInstance } from "fastify";

import { managementHandler, managementPath } from "./management.js";

export function mountManagement(host: FastifyInstance) {
  // Run before Fastify consumes the body. The host establishes the operator session first.
  host.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?", 1)[0]!;
    if (path === managementPath || path.startsWith(managementPath + "/")) {
      reply.hijack();
      await managementHandler(request.raw, reply.raw);
    }
  });
}
