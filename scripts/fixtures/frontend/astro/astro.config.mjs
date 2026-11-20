import node from "@astrojs/node";
import { defineConfig } from "astro/config";

import { browserInputs } from "./browser-inputs.mjs";

export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  vite: { plugins: [browserInputs()] },
});
