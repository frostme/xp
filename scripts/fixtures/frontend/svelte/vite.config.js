import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

import { inspectBrowserGraph } from "./fixture-shared/svelte/graph.mjs";
export default defineConfig({
  plugins: [svelte(), inspectBrowserGraph()],
  ssr: { noExternal: ["@frostme/xp"] },
});
