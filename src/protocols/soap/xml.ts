import { SaxesParser } from "saxes";

export const soapNamespace = "http://schemas.xmlsoap.org/soap/envelope/";
export const xpNamespace = "urn:frostme:xp:v1";
export const soapAction = xpNamespace + ":ResolveCohort";
const xsi = "http://www.w3.org/2001/XMLSchema-instance";

interface XmlElement {
  name: string;
  uri: string;
  children: XmlElement[];
  text: string;
  nil?: string;
  hasExtraAttributes?: boolean;
}

function malformed(): never {
  throw new TypeError("Invalid xp SOAP envelope");
}

export function isElement(node: XmlElement | undefined, uri: string, name: string): boolean {
  return node?.uri === uri && node.name === name;
}

/** Parse only a bounded, namespace-aware SOAP document. DTDs are never dispatched to node-soap. */
export function soapBody(xml: string): XmlElement {
  if (xml.length > 64 * 1024) malformed();
  const document: XmlElement = { name: "", uri: "", children: [], text: "" };
  const stack = [document];
  const parser = new SaxesParser({ xmlns: true });
  parser.on("doctype", malformed);
  parser.on("processinginstruction", malformed);
  parser.on("opentag", (tag) => {
    if (stack.length > 16) malformed();
    const node: XmlElement = { name: tag.local, uri: tag.uri, children: [], text: "" };
    for (const attribute of Object.values(tag.attributes)) {
      if (attribute.uri === xsi && attribute.local === "nil") node.nil = attribute.value;
      else if (attribute.uri !== "http://www.w3.org/2000/xmlns/") node.hasExtraAttributes = true;
    }
    stack.at(-1)!.children.push(node);
    stack.push(node);
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  const text = (value: string) => {
    stack.at(-1)!.text += value;
  };
  parser.on("text", text);
  parser.on("cdata", text);
  parser.write(xml).close();
  const envelope = onlyChild(document, soapNamespace, "Envelope");
  const parts = envelope.children;
  const body = parts.at(-1);
  if (
    envelope.text.trim() ||
    !body ||
    !isElement(body, soapNamespace, "Body") ||
    !(parts.length === 1 || (parts.length === 2 && isElement(parts[0], soapNamespace, "Header"))) ||
    body.text.trim() ||
    body.children.length !== 1
  )
    malformed();
  return body.children[0]!;
}

export function onlyChild(parent: XmlElement, uri: string, name: string): XmlElement {
  const child = parent.children[0];
  if (parent.text.trim() || parent.children.length !== 1 || !child || !isElement(child, uri, name))
    malformed();
  return child;
}

export function readSlug(
  wrapper: XmlElement,
  operation: "ResolveCohort" | "ResolveCohortResponse",
): string | null {
  if (
    !isElement(wrapper, xpNamespace, operation) ||
    wrapper.hasExtraAttributes ||
    wrapper.nil !== undefined
  )
    malformed();
  const slug = onlyChild(wrapper, xpNamespace, "slug");
  if (slug.children.length || slug.hasExtraAttributes) malformed();
  if (slug.nil === undefined || slug.nil === "false" || slug.nil === "0") return slug.text;
  if (
    operation === "ResolveCohortResponse" &&
    (slug.nil === "true" || slug.nil === "1") &&
    !slug.text
  )
    return null;
  return malformed();
}

export function envelope(body: string): string {
  return `<soap:Envelope xmlns:soap="${soapNamespace}" xmlns:xp="${xpNamespace}"><soap:Body>${body}</soap:Body></soap:Envelope>`;
}
