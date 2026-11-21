import type { AddressInfo } from "node:net";

import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createSoapLoader } from "~/client/soap";
import { envelope, readSlug, soapAction, soapBody } from "~/protocols/soap/xml";
import { decisionRuntime, decisionVectors } from "~/server/__tests__/decisionVectors";
import { createXpSoapHandler } from "~/server/soap";

const xml = (slug: string) =>
  envelope(`<xp:ResolveCohort><xp:slug>${slug}</xp:slug></xp:ResolveCohort>`);
const headers = { "content-type": "text/xml", soapaction: '"' + soapAction + '"' };

describe("SOAP 1.1 HTTP binding", () => {
  const resolveCohort = vi.fn(decisionRuntime.resolveCohort);
  let endpoint: string;
  let handle: Awaited<ReturnType<typeof createXpSoapHandler>>;
  const server = createServer(async (req: IncomingMessage & { userId?: string | number }, res) => {
    const id = req.headers["x-id"];
    if (id === "rejected" || id === "denied") {
      res.writeHead(id === "rejected" ? 401 : 403).end("host denial");
      return;
    }
    if (typeof id === "string") req.userId = id === "zero" ? 0 : id;
    if (!(await handle(req, res))) res.writeHead(204).end();
  });
  beforeAll(async () => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/xp/soap`;
    handle = await createXpSoapHandler({
      runtime: { ...decisionRuntime, resolveCohort },
      publicEndpoint: endpoint,
    });
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  it.each(decisionVectors)("maps $name", async (vector) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { ...headers, ...(vector.id ? { "x-id": vector.id } : {}) },
      body: xml(vector.slug),
    });
    const body = await response.text();
    if (vector.status === 401 || vector.status === 403) {
      expect([response.status, body]).toEqual([vector.status, "host denial"]);
      return;
    }
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    if ("result" in vector) {
      expect(response.status).toBe(200);
      expect(readSlug(soapBody(body), "ResolveCohortResponse")).toBe(vector.result);
    } else {
      expect(response.status).toBe(500);
      expect(body).toContain(vector.code === "INTERNAL" ? "soap:Server" : "soap:Client");
      expect(body).not.toContain("private driver");
      const load = createSoapLoader({ fetch: async () => new Response(body, { status: 500 }) });
      await expect(load("delivery-copy")).rejects.toMatchObject({ code: vector.code, status: 500 });
    }
  });
  it("reads the verified numeric zero attached by the host", async () => {
    await createSoapLoader({ endpoint, headers: { "x-id": "zero" } })("delivery-copy");
    expect(resolveCohort).toHaveBeenCalledWith(0, "delivery-copy");
  });
  it("rejects malformed XML, DTDs, wrong names and extra body fields before resolution", async () => {
    const valid = xml("delivery-copy");
    for (const body of [
      "",
      "<broken",
      "<!DOCTYPE x>" + valid,
      valid.replace("urn:frostme:xp:v1", "wrong"),
      valid.replace("</xp:slug>", "</xp:slug><xp:id>me</xp:id>"),
      valid.replace("</soap:Body>", "<xp:Extra/></soap:Body>"),
    ]) {
      resolveCohort.mockClear();
      const response = await fetch(endpoint, { method: "POST", headers, body });
      expect(response.status).toBe(500);
      expect(await response.text()).toContain("<xp:code>INVALID_ARGUMENT</xp:code>");
      expect(resolveCohort).not.toHaveBeenCalled();
    }
  });
  it("rejects an oversized streaming request while the writer is still open", async () => {
    const { request } = await import("node:http");
    const req = request(endpoint, { method: "POST", headers });
    const reply = once(req, "response");
    try {
      req.write(" ".repeat(17 * 1024));
      const [response] = await reply;
      expect(response.statusCode).toBe(413);
      response.resume();
    } finally {
      req.end();
    }
  });
});
