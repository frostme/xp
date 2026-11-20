import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

import { checkVueGraph } from "./fixture-shared/vue/graph.mjs";
export default defineConfig(({ isSsrBuild }) => ({
  plugins: [vue(), ...(isSsrBuild ? [] : [checkVueGraph()])],
}));
