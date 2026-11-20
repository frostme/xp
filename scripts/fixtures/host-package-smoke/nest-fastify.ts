import "reflect-metadata";
import { FastifyAdapter } from "@nestjs/platform-fastify";

import { exerciseNest } from "./nestjs.js";

await exerciseNest(() => new FastifyAdapter());
