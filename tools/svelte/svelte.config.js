import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

export default { outDir: ".stage", preprocess: vitePreprocess({ script: true }) };
