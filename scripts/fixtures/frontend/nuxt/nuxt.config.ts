import { checkVueGraph } from "./fixture-shared/vue/graph.mjs";
export default defineNuxtConfig({
  compatibilityDate: "2026-11-20",
  devtools: { enabled: false },
  routeRules: { "/**": { headers: { "Cache-Control": "private, no-store" } } },
  hooks: {
    "vite:extendConfig"(config, env) {
      if (env.isClient) config.plugins?.push(checkVueGraph());
    },
  },
});
