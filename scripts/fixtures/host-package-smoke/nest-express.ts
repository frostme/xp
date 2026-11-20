import "reflect-metadata";
import { ExpressAdapter } from "@nestjs/platform-express";

import { exerciseNest } from "./nestjs.js";

await exerciseNest(() => new ExpressAdapter());
