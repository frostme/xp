import type { CohortLoader } from "@frostme/xp/client";

import { createGrpcWebLoader } from "@frostme/xp/client/grpc-web";
import { createXpGrpcWebHandler } from "@frostme/xp/server/grpc-web";
import { createServer } from "node:http";

const load: CohortLoader = createGrpcWebLoader({ experimentHost: "/api", credentials: "include" });
export { load };
createServer(
  createXpGrpcWebHandler({
    runtime: { driverKind: "postgres", resolveCohort: async () => ({ slug: null }) },
    requestPathPrefix: "/api",
    userId: async (request) => request.headers["x-verified-user"],
    fallback: (_request, response) => {
      response.writeHead(404);
      response.end();
    },
  }),
);
