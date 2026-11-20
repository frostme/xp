import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from "@angular/ssr/node";
import { createXpRequest } from "@frostme/xp/client";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, join } from "node:path";
import process from "node:process";

const engine = new AngularNodeAppEngine();
async function serve(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/favicon.ico") {
    res.writeHead(204).end();
    return;
  }
  if (url.pathname.endsWith(".js")) {
    res.setHeader("Content-Type", "text/javascript");
    res.end(await readFile(join(import.meta.dirname, "../browser", basename(url.pathname))));
    return;
  }
  // The verified fixture session represents the application's request-owned authentication.
  const other = req.headers.cookie?.split("; ").includes("shop_session=opposite");
  const decisions = createXpRequest(async (slug) => {
    if (slug === "failed") throw new Error("private-diagnostic");
    if (slug === "guest") return null;
    return slug + (other ? "_off" : "_on");
  });
  const preload = await decisions.preload(
    url.pathname === "/journey" ? [] : ["banner", "guest", "failed"],
  );
  const response = await engine.handle(req, { ...preload, sessionKey: other ? "b" : "a" });
  if (!response) {
    res.writeHead(404).end();
    return;
  }
  response.headers.set("cache-control", "private, no-store");
  await writeResponseToNodeResponse(response, res);
}
export const reqHandler = createNodeRequestHandler((req, res) => {
  void serve(req, res).catch((error) => {
    console.error(error);
    res.writeHead(500).end();
  });
});
if (isMainModule(import.meta.url)) {
  const server = createServer(reqHandler);
  server.listen(Number(process.env["PORT"] ?? 0), "127.0.0.1", () => {
    const address = server.address();
    if (address && typeof address === "object") console.log("ANGULAR_PORT=" + address.port);
  });
}
