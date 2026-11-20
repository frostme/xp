import assert from "node:assert/strict";
import { builtinModules } from "node:module";

export function auditBrowser() {
  return {
    name: "verify-solid-browser-imports",
    generateBundle(_config, bundle) {
      const ids = Object.values(bundle).flatMap((chunk) =>
        chunk.type === "chunk" ? Object.keys(chunk.modules) : [],
      );
      const browser = ids.find((id) => /\/dist\/client\/solid\/v[12]\.browser\.js$/.test(id));
      assert.ok(browser, "browser entry includes the packed Solid browser adapter");
      for (const id of ids) {
        assert.ok(
          !/[/\\](react|react-dom|vue|svelte|ink|pg|mongodb|mysql2|mssql)[/\\]|\/@frostme\/xp\/dist\/(cli|server|adaptors)\/|browser-external|^node:/.test(
            id,
          ) && !builtinModules.includes(id),
          id,
        );
      }
    },
  };
}
