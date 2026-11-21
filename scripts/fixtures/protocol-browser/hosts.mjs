import { registerXpGrpc } from "@frostme/xp/server/grpc";
import { createXpGrpcWebHandler } from "@frostme/xp/server/grpc-web";
import { Server, ServerCredentials, ServerInterceptingCall, status } from "@grpc/grpc-js";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

export const pageOrigin = "http://127.0.0.1:18180";
export const directOrigin = "http://127.0.0.1:18181";
export const envoyOrigin = "http://127.0.0.1:18182";
export const rpcPath = "/api/xp.v1.CohortService/ResolveCohort";
const allowedHeaders = "content-type,authorization,x-grpc-web,x-user-agent,grpc-timeout,soapaction";

// Stand-in for the host session store. Only credentials in this table authenticate.
const sessions = new Set(["alice", "bob", "shopper", "unregistered"]);
function authenticate(cookie, authorization) {
  const session =
    authorization !== undefined
      ? (/^Bearer ([^ ]+)$/.exec(String(authorization))?.[1] ?? "")
      : /(?:^|;\s*)session=([^;]*)/.exec(String(cookie))?.[1];
  if (session === undefined) return {};
  if (sessions.has(session)) return { session };
  return session === "forbidden"
    ? { code: status.PERMISSION_DENIED, details: "Access denied" }
    : { code: status.UNAUTHENTICATED, details: "Invalid session" };
}

export async function startNativeHost(runtime, { identity = (session) => session } = {}) {
  const server = new Server({
    interceptors: [
      (_method, call) =>
        new ServerInterceptingCall(call, {
          start(next) {
            next({
              onReceiveMetadata(metadata, forward) {
                const auth = authenticate(
                  metadata.get("cookie")[0],
                  metadata.get("authorization")[0],
                );
                if (auth.code) call.sendStatus(auth);
                else forward(metadata);
              },
            });
          },
        }),
    ],
  });
  registerXpGrpc(server, {
    runtime,
    userId: ({ metadata }) => {
      const { session } = authenticate(metadata.get("cookie")[0], metadata.get("authorization")[0]);
      return session === undefined ? null : identity(session);
    },
  });
  await new Promise((resolve, reject) => {
    server.bindAsync("127.0.0.1:18183", ServerCredentials.createInsecure(), (error) =>
      error ? reject(error) : resolve(),
    );
  });
  return () => server.forceShutdown();
}

async function listen(handler, port) {
  const server = createServer(handler);
  await new Promise((resolve, reject) =>
    server.once("error", reject).listen(port, "127.0.0.1", resolve),
  );
  return () => new Promise((resolve) => server.close(resolve));
}

export async function startDirectHosts(
  runtime,
  { assets = "./web", routes = {}, identity = (session) => session } = {},
) {
  const handleRpc = createXpGrpcWebHandler({
    runtime,
    requestPathPrefix: "/api",
    fallback(request, response) {
      if (request.url === "/sibling") response.writeHead(200).end("host-owned");
      else response.writeHead(404).end();
    },
  });
  async function serve(request, response) {
    const path = request.url.split("?", 1)[0];
    if (request.headers.origin === pageOrigin) {
      response.setHeader("access-control-allow-origin", pageOrigin);
      response.setHeader("access-control-allow-credentials", "true");
      response.setHeader(
        "access-control-expose-headers",
        "grpc-status,grpc-message,grpc-status-details-bin",
      );
      response.setHeader("vary", "Origin");
      if (request.method === "OPTIONS") {
        response
          .writeHead(204, {
            "access-control-allow-headers": allowedHeaders,
            "access-control-allow-methods": "POST,OPTIONS",
          })
          .end();
        return;
      }
    }
    if (request.method === "GET" && path === "/") {
      response
        .writeHead(200, { "content-type": "text/html" })
        .end('<!doctype html><script type="module" src="/page.js"></script><div id="root"></div>');
      return;
    }
    if (request.method === "GET" && /^\/[a-zA-Z0-9._-]+\.js$/.test(path)) {
      try {
        const body = await readFile(join(assets, path.slice(1)));
        response.writeHead(200, { "content-type": "text/javascript" }).end(body);
      } catch {
        response.writeHead(404).end();
      }
      return;
    }
    const auth = authenticate(request.headers.cookie, request.headers.authorization);
    if (auth.code) {
      if (path === rpcPath) {
        response
          .writeHead(200, {
            "content-type": "application/grpc-web+proto",
            "cache-control": "private, no-store",
            "grpc-status": String(auth.code),
            "grpc-message": encodeURIComponent(auth.details),
          })
          .end();
      } else response.writeHead(auth.code === status.UNAUTHENTICATED ? 401 : 403).end();
      return;
    }
    request.userId = auth.session === undefined ? null : identity(auth.session);
    if (Object.hasOwn(routes, path)) {
      await routes[path](request, response);
      return;
    }
    handleRpc(request, response);
  }
  const closePage = await listen(serve, 18180);
  try {
    const closeDirect = await listen(serve, 18181);
    return () => Promise.all([closePage(), closeDirect()]);
  } catch (error) {
    await closePage();
    throw error;
  }
}
