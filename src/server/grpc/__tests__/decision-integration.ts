import { status } from "@grpc/grpc-js";
import { expect, it, vi } from "vitest";

import { decisionRuntime, decisionVectors } from "../../__tests__/decisionVectors";
import { resolveRpcDecision } from "../decision";

for (const vector of decisionVectors) {
  if (vector.code === "UNAUTHENTICATED" || vector.code === "PERMISSION_DENIED") continue;
  it("maps the RPC decision for " + vector.name, async () => {
    const identity = vi.fn(async () => vector.id);
    const result = resolveRpcDecision(vector.slug, decisionRuntime, identity, {});
    if (vector.code === "OK") {
      await expect(result).resolves.toEqual(vector.result === null ? {} : { slug: vector.result });
    } else {
      await expect(result).rejects.toMatchObject({ code: status[vector.code] });
    }
    if (vector.code === "INVALID_ARGUMENT") expect(identity).not.toHaveBeenCalled();
  });
}

it("sanitizes resolver failures", async () => {
  await expect(
    resolveRpcDecision(
      "delivery-copy",
      decisionRuntime,
      async () => {
        throw new Error("private authentication service details");
      },
      {},
    ),
  ).rejects.toMatchObject({ code: status.INTERNAL, message: "Internal server error" });
});
