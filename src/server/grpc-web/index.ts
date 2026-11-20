import { Code, ConnectError, createContextKey, createContextValues } from "@connectrpc/connect";
import { connectNodeAdapter, type ConnectNodeAdapterOptions } from "@connectrpc/connect-node";

import type { CohortRuntime } from "~/interfaces/runtime";

import { CohortService } from "~/proto/xp/v1/cohort_pb";

import { resolveRpcDecision, RpcDecisionError } from "../grpc/decision";
import { readIdentity, type IdentityOptions } from "../request";

type NodeHandler = ReturnType<typeof connectNodeAdapter>;
type NodeRequest = Parameters<NodeHandler>[0];

export interface GrpcWebOptions
  extends
    IdentityOptions<NodeRequest>,
    Pick<ConnectNodeAdapterOptions, "requestPathPrefix" | "interceptors" | "fallback"> {
  runtime: CohortRuntime;
}

const originalRequest = createContextKey<NodeRequest | undefined>(undefined);

/** Mount a unary gRPC-Web service on a caller-owned Node listener. */
export function createXpGrpcWebHandler(options: GrpcWebOptions): NodeHandler {
  const { runtime, requestPathPrefix, fallback, interceptors } = options;
  const prefix = (requestPathPrefix ?? "").replace(/\/+$/, "");
  if (prefix && !prefix.startsWith("/"))
    throw new TypeError("Expected an absolute request path prefix");
  const method = CohortService.method.resolveCohort;
  const route = `${prefix}/${CohortService.typeName}/${method.name}`;
  const handle = connectNodeAdapter({
    requestPathPrefix: prefix,
    ...(fallback && { fallback }),
    ...(interceptors && { interceptors }),
    grpcWeb: true,
    grpc: false,
    connect: false,
    contextValues: (request) => createContextValues().set(originalRequest, request),
    routes(router) {
      router.rpc(method, async ({ slug }, context) => {
        const request = context.values.get(originalRequest);
        if (!request) throw new ConnectError("Internal server error", Code.Internal);
        try {
          return await resolveRpcDecision(
            slug,
            runtime,
            () =>
              readIdentity(
                request,
                options,
                (name) => context.requestHeader.get(name),
                () => ("userId" in request ? request.userId : undefined),
              ),
            request,
          );
        } catch (error) {
          if (error instanceof RpcDecisionError)
            throw new ConnectError(error.message, error.code, undefined, undefined, error);
          throw error;
        }
      });
    },
  });
  return (request, response) => {
    if (request.url?.split("?", 1)[0] === route)
      response.setHeader("Cache-Control", "private, no-store");
    handle(request, response);
  };
}
