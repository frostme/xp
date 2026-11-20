import type { CohortLoader } from "@frostme/xp/client";
import type { IncomingMessage } from "node:http";

import { createSoapLoader } from "@frostme/xp/client/soap";
import { createXpSoapHandler } from "@frostme/xp/server/soap";

interface AuthenticatedRequest extends IncomingMessage {
  account: { id: number } | null;
}

export const browserLoad: CohortLoader = createSoapLoader({ experimentHost: "/api" });
export const handler = await createXpSoapHandler<AuthenticatedRequest>({
  publicEndpoint: "https://example.com/api/xp/soap",
  runtime: {
    driverKind: "postgres",
    async resolveCohort() {
      return { slug: null };
    },
  },
  async userId(request) {
    return request.account?.id;
  },
});
