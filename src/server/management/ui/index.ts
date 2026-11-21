import type { ServerResponse } from "node:http";

import { readFile } from "node:fs/promises";

import type { ManagementAccess } from "~/interfaces/management";

const assets = new Map([
  ["app.css", "text/css"],
  ["app.js", "text/javascript"],
  ["common.js", "text/javascript"],
  ["directory.js", "text/javascript"],
  ["serving.js", "text/javascript"],
  ["editors.js", "text/javascript"],
  ["reviews.js", "text/javascript"],
]);
const pageRoute = /^\/(?:create|experiments\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/split)?)\/?$/;

export async function serveManagementUi(
  response: ServerResponse,
  base: string,
  path: string,
  access: ManagementAccess,
): Promise<boolean> {
  if (path.startsWith("/assets/")) {
    const name = path.slice(8);
    const type = assets.get(name);
    if (!type || access === "deny") return false;
    const data = await readFile(new URL("./assets/" + name, import.meta.url));
    response.writeHead(200, { "Content-Type": type + "; charset=utf-8" });
    response.end(data);
    return true;
  }
  if (path !== "" && path !== "/" && !pageRoute.test(path)) return false;
  if (!response.hasHeader("Content-Security-Policy")) {
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
    );
  }
  response.writeHead(access === "deny" ? 403 : 200, { "Content-Type": "text/html; charset=utf-8" });
  if (access === "deny") {
    response.end(
      '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Access denied · xp</title><main><h1>Access denied</h1><p>Your host account needs experiment view access.</p></main></html>',
    );
    return true;
  }
  // The mount factory validates base as a root-relative path of URL-safe segments.
  response.end(`<!doctype html>
<html lang="en" data-base="${base}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Experiments · xp</title><link rel="stylesheet" href="${base}/assets/app.css"><script type="module" src="${base}/assets/app.js"></script></head>
<body><a class="skip" href="#content">Skip to content</a><nav aria-label="Breadcrumb"><a href="${base || "/"}" aria-label="Experiment directory"><strong>xp</strong> Experiments</a><span id="crumb"></span><span id="access"></span></nav>
<main id="content" tabindex="-1"><p role="status">Loading experiments…</p><noscript>Enable JavaScript to use experiment management.</noscript></main>
<p id="status" role="status" aria-live="polite" aria-atomic="true"></p>
<dialog aria-labelledby="review-title"><form method="dialog"><div id="review"></div><div id="problem" role="alert"></div><div class="actions"><button id="back" value="cancel">Back</button><button type="button" class="primary" id="commit"></button></div></form></dialog>
</body></html>`);
  return true;
}
