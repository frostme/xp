import node from "@astrojs/node";
import renderer from "@astrojs/vue";
import { defineConfig } from "astro/config";

import { browserInputs } from "./browser-inputs.mjs";

export default defineConfig({
  integrations: [renderer()],
  output: "server",
  adapter: node({ mode: "standalone" }),
  vite: { plugins: [browserInputs()] },
});
