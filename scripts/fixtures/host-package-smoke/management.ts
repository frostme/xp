import type { IncomingMessage } from "node:http";

import { createXpManagementHandler, type ManagementOptions } from "@frostme/xp/server/management";
import assert from "node:assert/strict";

export const managementPath = "/shop/internal/experiments";
const runtime: ManagementOptions["runtime"] = {
  management: {
    allowCreate: false,
    list: async () => ({ items: [], nextCursor: null }),
    async detail() {
      throw new Error("No experiments");
    },
    async create() {
      throw new Error("Creation disabled");
    },
    async apply() {
      throw new Error("No experiments");
    },
  },
};
export const managementHandler = createXpManagementHandler({
  runtime,
  basePath: managementPath,
  access(request: IncomingMessage) {
    return request.headers.authorization === "Bearer operator" ? "view" : "deny";
  },
});

export async function verifyManagementMount(origin: string) {
  const url = origin + managementPath + "/api/capabilities";
  const denied = await fetch(url);
  assert.equal(denied.status, 403);
  const capabilities = await fetch(url, { headers: { authorization: "Bearer operator" } });
  assert.equal(capabilities.status, 200);
  assert.deepEqual(await capabilities.json(), { access: "view", allowCreate: false });
}
