import "reflect-metadata";
import { ExpressAdapter } from "@nestjs/platform-express";

import { managementHandler, managementPath } from "./management.js";
import { exerciseNest } from "./nestjs.js";

await exerciseNest(() => {
  const adapter = new ExpressAdapter();
  adapter.getInstance().use(managementPath, managementHandler);
  return adapter;
});
