import { createXpSoapHandler } from "@frostme/xp/server/soap";
import assert from "node:assert/strict";
import console from "node:console";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import process from "node:process";
import { URL } from "node:url";
import { chromium } from "playwright";
import { createClientAsync } from "soap";

const path = "/api/xp/soap";
const packedWsdl = await readFile(
  new URL(import.meta.resolve("@frostme/xp/wsdl/xp/v1/cohort.wsdl")),
  "utf8",
);
const bundle = await readFile("bundle.js");
const requests = [];
let handle;
let apiOrigin;
let pageOrigin;
const slow = Promise.withResolvers();
const release = Promise.withResolvers();
const runtime = {
  driverKind: "postgres",
  async resolveCohort(id, slug) {
    if (slug === "slow") {
      slow.resolve();
      await release.promise;
    }
    if (slug === "broken") throw new Error("private database detail");
    return { slug: id === null ? null : slug + (id === 0 ? "_short" : "_long") };
  },
};

function page(req, res) {
  if (req.url === "/bundle.js")
    res.writeHead(200, { "Content-Type": "text/javascript" }).end(bundle);
  else
    res
      .writeHead(200, { "Content-Type": "text/html" })
      .end(
        '<!doctype html><title>Installed SOAP client</title><script type="module">import * as soap from "/bundle.js"; globalThis.soap = soap;</script>',
      );
}
const api = createServer(async (req, res) => {
  if (req.url === "/" || req.url === "/bundle.js") return page(req, res);
  if (req.url === "/health") return res.end("healthy");
  if (req.headers.origin === pageOrigin) {
    res.setHeader("Access-Control-Allow-Origin", pageOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    requests.push({
      method: "OPTIONS",
      cookie: req.headers.cookie,
      requested: req.headers["access-control-request-headers"],
    });
    res
      .writeHead(204, {
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "content-type, soapaction, authorization",
      })
      .end();
    return;
  }
  const cookie = req.headers.cookie;
  const auth = req.headers.authorization;
  requests.push({ method: req.method, cookie });
  if (auth === "Bearer rejected" || auth === "Bearer denied") {
    res
      .writeHead(auth.endsWith("denied") ? 403 : 401, { "Content-Type": "text/plain" })
      .end("host denied");
    return;
  }
  req.account =
    cookie === "account=A" || auth === "Bearer A"
      ? { id: 0 }
      : auth === "Bearer B"
        ? { id: 1 }
        : null;
  if (!(await handle(req, res))) res.writeHead(404).end();
});
const site = createServer(page);
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return "http://127.0.0.1:" + server.address().port;
}

let browser;
try {
  apiOrigin = await listen(api);
  pageOrigin = await listen(site);
  const endpoint = apiOrigin + path;
  handle = await createXpSoapHandler({
    path,
    runtime,
    publicEndpoint: endpoint,
    header: "x-ignored",
    async userId(req) {
      await Promise.resolve();
      return req.account?.id;
    },
  });
  const wsdl = await (await globalThis.fetch(endpoint + "?wsdl")).text();
  assert.equal(wsdl, packedWsdl.replace("http://localhost/xp/soap", endpoint));
  const client = await createClientAsync(endpoint + "?wsdl", { handleNilAsNull: true });
  assert.deepEqual((await client.ResolveCohortAsync({ slug: "delivery-copy" }))[0], { slug: null });
  client.addHttpHeader("Authorization", "Bearer A");
  const [value, raw] = await client.ResolveCohortAsync({ slug: "delivery-copy" });
  assert.deepEqual(value, { slug: "delivery-copy_short" });
  assert.match(raw, /ResolveCohortResponse/);
  const alt =
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><r:ResolveCohort xmlns:r="urn:frostme:xp:v1"><r:slug>delivery-copy</r:slug></r:ResolveCohort></s:Body></s:Envelope>';
  const post = (body, Authorization) =>
    globalThis.fetch(endpoint, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "text/xml",
        SOAPAction: '"urn:frostme:xp:v1:ResolveCohort"',
        Authorization,
      },
    });
  const [a, b, guest] = await Promise.all(
    ["Bearer A", "Bearer B", ""].map(async (id) => (await post(alt, id)).text()),
  );
  assert.match(a, /delivery-copy_short/);
  assert.match(b, /delivery-copy_long/);
  assert.match(guest, /xsi:nil="true"/);
  const bad = await post(alt.replace("delivery-copy", "BAD"), "");
  assert.equal(bad.status, 500);
  assert.match(
    await bad.text(),
    /<faultcode>soap:Client<\/faultcode>.*<xp:code>INVALID_ARGUMENT<\/xp:code>/,
  );
  assert.equal((await post(alt, "Bearer denied")).status, 403);
  assert.equal(await (await globalThis.fetch(apiOrigin + "/health")).text(), "healthy");

  browser = await chromium.launch({ executablePath: process.env.XP_CHROMIUM_EXECUTABLE_PATH });
  const tab = await browser.newPage();
  await tab.goto(apiOrigin);
  assert.equal(
    await tab.evaluate(async () => {
      const { createSoapLoader } = globalThis.soap;
      return createSoapLoader({ experimentHost: "/api" })("delivery-copy");
    }),
    null,
  );
  await tab.context().addCookies([{ url: apiOrigin, name: "account", value: "A" }]);
  await tab.goto(pageOrigin);
  const results = await tab.evaluate(async (endpoint) => {
    const { createSoapLoader, XpSoapFault } = globalThis.soap;
    const call = (options, slug = "delivery-copy") =>
      createSoapLoader({ experimentHost: "/unused", endpoint, ...options })(slug);
    const assigned = await call({ credentials: "include" });
    const guest = await call({ credentials: "omit" });
    const denials = [];
    for (const state of ["rejected", "denied"]) {
      try {
        await call({ credentials: "include", headers: { Authorization: "Bearer " + state } });
      } catch (error) {
        denials.push(error.message);
      }
    }
    let fault;
    try {
      await call({ credentials: "include" }, "broken");
    } catch (error) {
      fault = {
        typed: error instanceof XpSoapFault,
        code: error.code,
        status: error.status,
        message: error.message,
      };
    }
    return { assigned, guest, denials, fault };
  }, endpoint);
  assert.deepEqual(results, {
    assigned: "delivery-copy_short",
    guest: null,
    denials: ["xp request failed with HTTP 401", "xp request failed with HTTP 403"],
    fault: { typed: true, code: "INTERNAL", status: 500, message: "Internal server error" },
  });
  assert.ok(
    requests.some(
      (req) =>
        req.method === "OPTIONS" &&
        !req.cookie &&
        req.requested.includes("soapaction") &&
        req.requested.includes("content-type"),
    ),
  );
  assert.ok(requests.some((req) => req.method === "POST" && req.cookie === "account=A"));

  const aborted = tab.evaluate(async (endpoint) => {
    const { createSoapLoader } = globalThis.soap;
    const abort = new globalThis.AbortController();
    globalThis.cancelSoap = () => abort.abort();
    try {
      await createSoapLoader({ endpoint })("slow", { signal: abort.signal });
    } catch (error) {
      return error.name;
    }
  }, endpoint);
  await Promise.race([
    slow.promise,
    aborted.then(() => {
      throw new Error("Request ended before host received it");
    }),
  ]);
  await tab.evaluate(() => globalThis.cancelSoap());
  assert.equal(await aborted, "AbortError");

  // Malformed and cross-experiment payloads exercise the production browser decoder.
  assert.equal(
    await tab.evaluate(async () => {
      const { createSoapLoader } = globalThis.soap;
      const wrap = (inner) =>
        '<e:Envelope xmlns:e="http://schemas.xmlsoap.org/soap/envelope/" xmlns:v="urn:frostme:xp:v1"><e:Body>' +
        inner +
        "</e:Body></e:Envelope>";
      const bodies = [
        "",
        wrap("<v:Wrong/>"),
        wrap("<v:ResolveCohortResponse/>"),
        wrap("<v:ResolveCohortResponse><slug>delivery-copy_short</slug></v:ResolveCohortResponse>"),
        wrap("<v:ResolveCohortResponse><v:slug>other_short</v:slug></v:ResolveCohortResponse>"),
        wrap("<v:ResolveCohortResponse><v:slug/></v:ResolveCohortResponse>"),
      ];
      for (const xml of bodies) {
        try {
          await createSoapLoader({ fetch: async () => new globalThis.Response(xml) })(
            "delivery-copy",
          );
          return false;
        } catch {
          /* the browser rejected the malformed response */
        }
      }
      return true;
    }),
    true,
  );
  console.log(
    "Installed SOAP schema, WSDL client, same-origin and credentialed cross-origin Chromium journeys passed.",
  );
} finally {
  release.resolve();
  await browser?.close();
  for (const server of [api, site]) {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}
