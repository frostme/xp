import "reflect-metadata";
import { FastifyAdapter } from "@nestjs/platform-fastify";

import { mountManagement } from "./management-fastify.js";
import { exerciseNest } from "./nestjs.js";

await exerciseNest(() => {
  const adapter = new FastifyAdapter();
  mountManagement(adapter.getInstance());
  return adapter;
});
