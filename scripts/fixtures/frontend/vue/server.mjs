import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { URL } from "node:url";

import { render } from "./dist/server/server.js";
import { preload } from "./fixture-shared/vue/preload.mjs";

export async function start(cwd) {
  const template = await readFile(cwd + "/dist/client/index.html", "utf8");
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/assets/")) {
        res.setHeader("Content-Type", "text/javascript");
        return res.end(await readFile(cwd + "/dist/client" + url.pathname));
      }
      const data =
        url.pathname === "/journey" ? {} : await preload(req.headers.cookie?.includes("variant=b"));
      const markup = await render(url, data);
      res.setHeader("Content-Type", "text/html");
      res.setHeader("Cache-Control", "private, no-store");
      res.end(
        template
          .replace("<!--app-->", markup)
          .replace(
            "<!--preload-->",
            `<script type="application/json" id="preload">${JSON.stringify(data).replaceAll("<", "\\u003c")}</script>`,
          ),
      );
    } catch (error) {
      res.statusCode = 500;
      res.end(String(error));
    }
  });
}
