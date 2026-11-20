import type { IncomingMessage, ServerResponse } from "node:http";

import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import { readFile } from "node:fs/promises";
import { createServerless } from "soap";

import type { CohortRuntime } from "~/interfaces/runtime";

import { ExperimentNotFoundError } from "~/errors/experimentNotFoundError";
import { envelope, readSlug, soapAction, soapBody } from "~/protocols/soap/xml";

import { readIdentity, validateExperimentSlug, type IdentityOptions } from "../request";

type HostRequest = IncomingMessage & { userId?: unknown };
export interface XpSoapOptions<
  Request extends IncomingMessage = HostRequest,
> extends IdentityOptions<Request> {
  runtime: CohortRuntime;
  publicEndpoint: string;
  path?: string;
}

const failures = channel("xp.request.error");
const byteLimit = 16 * 1024;

const messages = {
  INVALID_ARGUMENT: "Invalid ResolveCohort request",
  NOT_FOUND: "Experiment not found",
  INTERNAL: "Internal server error",
} as const;
type FaultCode = keyof typeof messages;

interface SoapCall<Request> {
  request: Request;
  slug: string;
  fault?: FaultCode;
}

function fault(code: FaultCode): string {
  const type = code === "INTERNAL" ? "soap:Server" : "soap:Client";
  return envelope(
    `<soap:Fault><faultcode>${type}</faultcode><faultstring>${messages[code]}</faultstring><detail><xp:XpFault><xp:code>${code}</xp:code></xp:XpFault></detail></soap:Fault>`,
  );
}

/** Stop buffering at 16 KiB, including for requests without Content-Length. */
async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > byteLimit) {
      request.resume();
      return null;
    }
    chunks.push(buffer);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
}

/** Construct once at startup. Returns false for routes and methods owned by the host. */
export async function createXpSoapHandler<Request extends IncomingMessage = HostRequest>(
  options: XpSoapOptions<Request>,
) {
  const path = options.path ?? "/xp/soap";
  const endpoint = new URL(options.publicEndpoint);
  if (!["http:", "https:"].includes(endpoint.protocol))
    throw new TypeError("Expected an HTTP(S) SOAP endpoint");
  const wsdl = (
    await readFile(new URL("../../wsdl/xp/v1/cohort.wsdl", import.meta.url), "utf8")
  ).replace("http://localhost/xp/soap", () =>
    endpoint.href.replaceAll("&", "&amp;").replaceAll('"', "&quot;"),
  );

  // processRequest creates a synthetic IncomingMessage. Keep the authenticated original per call.
  const active = new AsyncLocalStorage<SoapCall<Request>>();
  async function ResolveCohort() {
    const call = active.getStore()!;
    try {
      const id = await readIdentity(
        call.request,
        options,
        (key) => call.request.headers[key.toLowerCase()],
        () => (call.request as HostRequest).userId,
      );
      try {
        const decision = await options.runtime.resolveCohort(id, call.slug);
        // node-soap's null output needs an explicit namespace binding on the wire.
        return decision.slug === null
          ? {
              slug: {
                attributes: {
                  "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
                  "xsi:nil": "true",
                },
              },
            }
          : decision;
      } catch (error) {
        if (!(error instanceof ExperimentNotFoundError)) throw error;
        call.fault = "NOT_FOUND";
      }
    } catch (error) {
      failures.publish({ error, request: call.request });
      call.fault = "INTERNAL";
    }
    // End dispatch through node-soap's error path. The HTTP boundary writes the WSDL fault.
    throw new Error(messages[call.fault]);
  }
  const server = await createServerless({
    path,
    xml: wsdl,
    suppressStack: true,
    services: { CohortService: { CohortPort: { ResolveCohort } } },
  });

  return async (request: Request, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== path) return false;
    if (request.method === "GET" && url.searchParams.has("wsdl")) {
      response.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" }).end(wsdl);
      return true;
    }
    if (request.method !== "POST") return false;
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Content-Type", "text/xml; charset=utf-8");
    let xml;
    let slug: string;
    try {
      xml = await readBody(request);
      if (xml === null) {
        response.writeHead(413).end();
        return true;
      }
      const action = request.headers["soapaction"];
      if (
        (action !== soapAction && action !== '"' + soapAction + '"') ||
        request.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "text/xml"
      ) {
        throw new TypeError("Invalid SOAP request headers");
      }
      slug = validateExperimentSlug(readSlug(soapBody(xml), "ResolveCohort"));
    } catch {
      response.writeHead(500).end(fault("INVALID_ARGUMENT"));
      return true;
    }

    const call: SoapCall<Request> = { request, slug };
    try {
      const result = await active.run(call, () =>
        server.processRequest(xml, {
          url: path,
          headers: { soapaction: '"' + soapAction + '"', "content-type": "text/xml" },
        }),
      );
      if (call.fault) response.writeHead(500).end(fault(call.fault));
      else if (result.statusCode !== 200)
        throw new Error("SOAP dispatch failed", { cause: result.body });
      else response.writeHead(200).end(result.body);
    } catch (error) {
      failures.publish({ error, request });
      response.writeHead(500).end(fault("INTERNAL"));
    }
    return true;
  };
}
