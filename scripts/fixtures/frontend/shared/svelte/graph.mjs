export function inspectBrowserGraph() {
  return {
    name: "xp-svelte-browser-graph",
    applyToEnvironment(environment) {
      return environment.config.consumer === "client";
    },
    generateBundle(_opts, bundle) {
      const ids = Object.values(bundle).flatMap((chunk) =>
        chunk.type === "chunk" ? Object.keys(chunk.modules) : [],
      );
      if (!ids.some((id) => id.includes("/@frostme/xp/dist/client/svelte/")))
        this.error("Missing packed Svelte provider in browser bundle");
      for (const id of ids) {
        if (
          /(?:node:|__vite-browser-external|\/node_modules\/(?:react|ink|pg|mongodb|mysql2|mssql|sequelize|@aws-sdk)\/|\/@frostme\/xp\/dist\/(?:cli|server)\/)/.test(
            id,
          )
        )
          this.error(`Unexpected browser module ${id}`);
      }
    },
  };
}
