import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

import { inspectBrowserGraph } from "./fixture-shared/svelte/graph.mjs";
export default defineConfig({
  plugins: [sveltekit({ adapter: adapter() }), inspectBrowserGraph()],
  ssr: { noExternal: ["@frostme/xp"] },
});
