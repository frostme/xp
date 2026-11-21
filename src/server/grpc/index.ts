import type { Server, ServerUnaryCall, sendUnaryData, ServiceDefinition } from "@grpc/grpc-js";

import { Metadata } from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";

import type { CohortRuntime } from "~/interfaces/runtime";
import type { ResolveCohortRequest, ResolveCohortResponse } from "~/proto/xp/v1/cohort_pb";

import { CohortService } from "~/proto/xp/v1/cohort_pb";

import { readIdentity, type IdentityOptions } from "../request";
import { resolveRpcDecision, type RpcDecisionError } from "./decision";

type Request = Pick<ResolveCohortRequest, "slug">;
type Response = Pick<ResolveCohortResponse, "slug">;
type Call = ServerUnaryCall<Request, Response> & { userId?: unknown };

interface GrpcOptions extends IdentityOptions<Call> {
  runtime: CohortRuntime;
}

/** Register the v1 unary method on a host-owned grpc-js server. */
export function registerXpGrpc(server: Server, options: GrpcOptions): void {
  const path = fileURLToPath(new URL("../../proto/xp/v1/cohort.proto", import.meta.url));
  const definition = loadSync(path)[CohortService.typeName] as ServiceDefinition;
  server.addService(definition, {
    resolveCohort(call: Call, callback: sendUnaryData<Response>) {
      const metadata = new Metadata();
      metadata.set("cache-control", "private, no-store");
      call.sendMetadata(metadata);
      const identity = () =>
        readIdentity(
          call,
          options,
          (name) => call.metadata.get(name)[0],
          () => call.userId,
        );
      void resolveRpcDecision(call.request.slug, options.runtime, identity, call).then(
        (result) => callback(null, result),
        (error: RpcDecisionError) => callback({ code: error.code, details: error.message }),
      );
    },
  });
}
