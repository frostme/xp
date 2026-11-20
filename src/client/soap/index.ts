import { isSlugPart } from "~/entities/slug";
import {
  envelope,
  isElement,
  onlyChild,
  readSlug,
  soapAction,
  soapBody,
  soapNamespace,
  xpNamespace,
} from "~/protocols/soap/xml";

import { decodeAssignment, type CohortLoader, type LoaderOptions } from "../loaders/shared";

export class XpSoapFault extends Error {
  override name = "XpSoapFault";
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function createSoapLoader(options: LoaderOptions = {}): CohortLoader {
  const base = (options.experimentHost ?? "").replace(/\/+$/, "");
  const endpoint = options.endpoint ?? (base.endsWith("/xp/soap") ? base : base + "/xp/soap");
  return async (slug, { signal } = {}) => {
    if (!isSlugPart(slug)) throw new TypeError("Expected a nonempty kebab-case experiment slug");
    const headers = new Headers(options.headers);
    headers.set("content-type", "text/xml; charset=utf-8");
    headers.set("soapaction", '"' + soapAction + '"');
    const response = await (options.fetch ?? globalThis.fetch)(endpoint, {
      method: "POST",
      headers,
      credentials: options.credentials ?? "same-origin",
      ...(signal ? { signal } : {}),
      body: envelope(`<xp:ResolveCohort><xp:slug>${slug}</xp:slug></xp:ResolveCohort>`),
    });
    const xml = await response.text();
    const httpError = new Error(`xp request failed with HTTP ${response.status}`);
    let wrapper;
    try {
      wrapper = soapBody(xml);
    } catch (error) {
      throw response.ok ? error : httpError;
    }
    if (isElement(wrapper, soapNamespace, "Fault")) {
      const part = (name: string) => wrapper.children.find((node) => isElement(node, "", name));
      const detail = part("detail");
      const message = part("faultstring");
      if (!part("faultcode")?.text || !message?.text || !detail)
        throw new Error("Invalid SOAP fault");
      const code = onlyChild(onlyChild(detail, xpNamespace, "XpFault"), xpNamespace, "code");
      if (!code.text || code.children.length) throw new Error("Invalid SOAP fault code");
      throw new XpSoapFault(code.text, message.text, response.status);
    }
    if (!response.ok) throw httpError;
    return decodeAssignment(readSlug(wrapper, "ResolveCohortResponse"), slug);
  };
}
