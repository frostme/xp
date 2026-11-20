import { builtinModules } from "node:module";
export function checkVueGraph() {
  return {
    name: "check-xp-vue-browser-graph",
    generateBundle(_opts, bundle) {
      const ids = Object.values(bundle).flatMap((chunk) => Object.keys(chunk.modules ?? {}));
      if (!ids.some((id) => id.includes("/@frostme/xp/dist/client/vue/")))
        throw new Error("Missing packed Vue browser binding");
      const unexpected = ids.filter(
        (id) =>
          /\/node_modules\/(react|react-dom|ink|pg|mssql|sequelize|mongodb|mysql2|solid-js|svelte)\//.test(
            id,
          ) ||
          /\/@frostme\/xp\/dist\/(cli|server)\//.test(id) ||
          id.startsWith("node:") ||
          builtinModules.includes(id) ||
          id.includes("vite-browser-external"),
      );
      if (unexpected.length) throw new Error("Unexpected browser inputs: " + unexpected.join(", "));
    },
  };
}
