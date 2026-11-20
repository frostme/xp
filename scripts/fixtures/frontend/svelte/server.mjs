import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

import { bootstrap } from "./fixture-shared/svelte/server-cases.js";
import { renderApp } from "./ssr/entry-server.js";

const template = await readFile("./dist/index.html", "utf8");
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (/^\/assets\/[\w.-]+\.js$/.test(url.pathname)) {
      res.setHeader("content-type", "application/javascript");
      return res.end(await readFile("." + "/dist" + url.pathname));
    }
    if (url.pathname === "/favicon.ico") {
      res.statusCode = 204;
      return res.end();
    }
    const journey = url.pathname === "/journey";
    const props = journey
      ? { xp: { sessionKey: "live" }, slug: url.searchParams.get("slug") || "delivery-copy" }
      : { xp: await bootstrap(req.headers.cookie) };
    if (!journey && url.searchParams.has("graphql"))
      Object.assign(props.xp, { loader: "graphql", endpoint: "/graphql" });
    const { body } = renderApp(props);
    res.setHeader("content-type", "text/html");
    res.setHeader("cache-control", "private, no-store");
    return res.end(
      template
        .replace("<!--APP-->", () => body)
        .replace(
          "<!--DATA-->",
          () =>
            '<script type="application/json" id="bootstrap">' +
            JSON.stringify(props).replaceAll("<", "\\u003c") +
            "</script>",
        ),
    );
  } catch (error) {
    res.statusCode = 500;
    res.end(String(error));
  }
});
server.listen(0, "127.0.0.1", () =>
  console.log("XP_ORIGIN=http://127.0.0.1:" + server.address().port),
);
