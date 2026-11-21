export const { document, location, history } = globalThis;
export const base = document.documentElement.dataset.base;
export const $ = (selector, root = document) => root.querySelector(selector);
export const main = $("#content");
export const directoryUrl = base || "/";
export const detailUrl = (slug) => base + "/experiments/" + encodeURIComponent(slug);
export const apiDetail = (slug) => "/api/experiments/" + encodeURIComponent(slug);
const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const text = (value) => String(value).replace(/[&<>"']/g, (char) => entities[char]);
export const localName = (record, slug) =>
  slug.startsWith(record.slug + "_") ? slug.slice(record.slug.length + 1) : slug;
export const announce = (message) => {
  $("#status").textContent = message;
};
export const focusHeading = () => $("h1", main)?.focus();
export const button = (label, command, primary = false) =>
  `<button type="button" data-command="${text(command)}"${primary ? ' class="primary"' : ""}>${text(label)}</button>`;
export const actionLink = (label, href, primary = false) =>
  `<a class="button${primary ? " primary" : ""}" href="${text(href)}">${text(label)}</a>`;
export const cell = (label, html, className = "") =>
  `<td class="${className}"><span class="cell-label" aria-hidden="true">${text(label)}</span>${html}</td>`;
export function heading(title, slug, aside = "") {
  document.title = title + " · xp";
  return `<header class="meta"><div><h1 tabindex="-1">${text(title)}</h1>${slug ? "<code>" + text(slug) + "</code>" : ""}</div>${aside}</header>`;
}
export class RequestFailure extends Error {
  constructor(status, message, fields = []) {
    super(message);
    this.status = status;
    this.fields = fields;
  }
}
export async function request(path, options = {}) {
  const headers = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.etag) headers["If-Match"] = options.etag;
  const response = await globalThis.fetch(base + path, {
    method: options.body === undefined ? "GET" : "POST",
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: "same-origin",
    headers,
    signal: options.signal,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data === null)
    throw new RequestFailure(
      response.status,
      data?.error || "The host could not complete this request.",
      data?.fields,
    );
  return { data, etag: response.headers.get("ETag") };
}
export function errorText(error) {
  return error instanceof RequestFailure
    ? error.message
    : "The host could not be reached. Try again.";
}
