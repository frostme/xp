import { ExperimentNotFoundError } from "@frostme/xp/server";
import { registerXpGrpc } from "@frostme/xp/server/grpc";
import * as grpc from "@grpc/grpc-js";
import { loadSync, type ServiceDefinition } from "@grpc/proto-loader";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

// The consumer resolves the published schema without importing xp's descriptor.
const path = fileURLToPath(import.meta.resolve("@frostme/xp/proto/xp/v1/cohort.proto"));
const api = loadSync(path)["xp.v1.CohortService"] as ServiceDefinition;
const method = api["ResolveCohort"]!;
assert.equal(method.path, "/xp.v1.CohortService/ResolveCohort");
const sibling = { ...method, path: "/host.v1.Health/Check" };

const authenticate: grpc.ServerInterceptor = (_descriptor, call) =>
  new grpc.ServerInterceptingCall(call, {
    start(next) {
      next({
        onReceiveMetadata(metadata, accept) {
          const session = metadata.get("authorization")[0];
          if (session === "expired" || session === "forbidden") {
            call.sendStatus({
              code:
                session === "expired" ? grpc.status.UNAUTHENTICATED : grpc.status.PERMISSION_DENIED,
              details: "Host rejected session",
            });
            return;
          }
          metadata.remove("verified-user");
          if (session === "valid") metadata.set("verified-user", "zero-account");
          accept(metadata);
        },
      });
    },
  });

const server = new grpc.Server({ interceptors: [authenticate] });
const health: grpc.handleUnaryCall<unknown, { slug: string }> = (_call, done) =>
  done(null, { slug: "healthy" });
server.addService({ Check: sibling }, { Check: health });
registerXpGrpc(server, {
  header: "untrusted",
  async userId(call) {
    return call.metadata.get("verified-user")[0] === "zero-account" ? 0 : null;
  },
  runtime: {
    driverKind: "postgres",
    async resolveCohort(id, slug) {
      if (id != null && slug === "missing") throw new ExperimentNotFoundError(slug);
      if (slug === "broken") throw new Error("private driver detail");
      if (slug === "malformed") return { slug: "" };
      return { slug: id === 0 ? slug + "_short" : null };
    },
  },
});
const port = await new Promise<number>((resolve, reject) =>
  server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (error, port) =>
    error ? reject(error) : resolve(port),
  ),
);
const client = new grpc.Client("127.0.0.1:" + port, grpc.credentials.createInsecure());
function unary(slug: string, session?: string, route = method.path) {
  const metadata = new grpc.Metadata();
  metadata.set("untrusted", "spoofed");
  metadata.set("verified-user", "client-controlled");
  if (session) metadata.set("authorization", session);
  return new Promise<object>((resolve, reject) =>
    client.makeUnaryRequest(
      route,
      method.requestSerialize,
      method.responseDeserialize,
      { slug },
      metadata,
      { deadline: Date.now() + 5000 },
      (error, response) => (error ? reject(error) : resolve(response!)),
    ),
  );
}
try {
  assert.deepEqual(await unary("delivery-copy", "valid"), { slug: "delivery-copy_short" });
  assert.deepEqual(await unary("delivery-copy"), {});
  assert.deepEqual(await unary("missing"), {});
  await assert.rejects(unary("missing", "valid"), { code: grpc.status.NOT_FOUND });
  assert.deepEqual(await unary("ignored", undefined, sibling.path), { slug: "healthy" });
  await assert.rejects(unary("bad slug"), { code: grpc.status.INVALID_ARGUMENT });
  await assert.rejects(unary("broken", "valid"), {
    code: grpc.status.INTERNAL,
    details: "Internal server error",
  });
  await assert.rejects(unary("malformed", "valid"), {
    code: grpc.status.INTERNAL,
    details: "Internal server error",
  });
  await assert.rejects(unary("delivery-copy", "expired"), { code: grpc.status.UNAUTHENTICATED });
  await assert.rejects(unary("delivery-copy", "forbidden"), {
    code: grpc.status.PERMISSION_DENIED,
  });
  // Proto3 optional presence survives both serialization and the client's decode.
  assert.deepEqual(method.responseDeserialize(method.responseSerialize({ slug: "" })), {
    slug: "",
  });
} finally {
  client.close();
  await new Promise<void>((resolve) => server.tryShutdown(() => resolve()));
}
