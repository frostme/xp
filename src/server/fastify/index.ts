import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import type { RestDecisionOptions } from "../restDecision";

import { resolveRestDecision } from "../restDecision";

export interface XpFastifyOptions extends RestDecisionOptions<FastifyRequest> {
  route?: string;
}

/** Register within the scope that owns authentication and the route prefix. */
export const xpFastifyPlugin: FastifyPluginAsync<XpFastifyOptions> = async (app, options) => {
  const route = options.route ?? "/xp";
  app.post(
    route.startsWith("/") ? route : "/" + route,
    {
      onRequest: async (_request, reply) => {
        reply.header("Cache-Control", "private, no-store");
      },
    },
    async (request, reply) => {
      try {
        const result = await resolveRestDecision(
          request,
          request.body,
          options,
          (name) => request.headers[name.toLowerCase()],
          () => (request as FastifyRequest & { userId?: unknown }).userId,
        );
        return reply.code(result.status).send(result.body);
      } catch (error) {
        request.log.error({ err: error }, "Could not resolve the experiment cohort");
        return reply.code(500).send({ error: "Internal server error" });
      }
    },
  );
};
