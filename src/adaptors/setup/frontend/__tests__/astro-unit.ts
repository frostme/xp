import { describe, expect, it } from "vitest";

import type { FrontendContext } from "../types";

import { astro, registerAstroMiddleware } from "../astro";
import { resolveIslands } from "../astro-islands";

const auth =
  'import { defineMiddleware as define } from "astro:middleware";\nexport const onRequest = define(async (ctx, next) => { /* auth first */ return next() });\n';
const ctx: FrontendContext = {
  cwd: ".",
  language: "typescript",
  frontend: "astro",
  transport: "rest",
  endpoint: "/xp",
  versions: { astro: "7.4.13" },
  island: "none",
  read: async () => null,
};

describe("Astro middleware registration", () => {
  it("preserves the initializer and subsequent host edits across reruns", () => {
    const result = registerAstroMiddleware(auth, "./xp/request");
    expect(result).toContain(
      "xpSequence(define(async (ctx, next) => { /* auth first */ return next() }), xpMiddleware)",
    );
    const edited = result + "// host edit\n";
    expect(registerAstroMiddleware(edited, "./xp/request")).toEqual(edited);
  });
  it("wraps an existing authenticated sequence in place", () => {
    const source =
      'import { sequence as seq } from "astro:middleware";\nexport const onRequest = seq(trace, login);';
    expect(registerAstroMiddleware(source, "./xp/request")).toContain(
      "seq(seq(trace, login), xpMiddleware)",
    );
  });
  it("falls back for conflicting or indirect registrations", async () => {
    const result = await astro.generate({
      ...ctx,
      read: async (p) =>
        p === "src/middleware.ts" ? 'export { auth as onRequest } from "./custom"' : null,
    });
    expect(result.registrations).toEqual([]);
    expect(result.owned.some((f) => f.path === "src/xp/request.ts")).toEqual(true);
    expect(result.manual.join(" ")).toContain("src/middleware.ts");
  });
  it("creates conventional native JS middleware, preserving later edits to the created entry", async () => {
    const { registrations } = await astro.generate({ ...ctx, language: "javascript" });
    const first = registrations[0]!;
    expect(first.path).toEqual("src/middleware.js");
    const edited = first.content + "// app-owned\n";
    const rerun = await astro.generate({
      ...ctx,
      language: "javascript",
      read: async (p) => (p === first.path ? edited : null),
    });
    expect(rerun.registrations[0]?.content).toEqual(edited);
  });
});

describe("Astro island detection", () => {
  const vue = { "@astrojs/vue": "7.1.6", vue: "3.5.46" };
  const svelte = { "@astrojs/svelte": "9.1.6", svelte: "5.59.0" };
  it("selects the only installed compatible renderer or server-only", () => {
    expect(resolveIslands({})).toEqual({ selected: "none", choices: ["none"] });
    expect(resolveIslands(vue).selected).toBe("vue");
    expect(resolveIslands(vue, "none").selected).toBe("none");
    expect(resolveIslands({ ...vue, vue: "2.7.0" }).selected).toBe("none");
    expect(resolveIslands({ "@astrojs/solid-js": "7.1.6", "solid-js": "2.0.3" }).selected).toBe(
      "none",
    );
  });
  it("offers a choice between several renderers and rejects incompatible explicit selections", () => {
    expect(resolveIslands({ ...vue, ...svelte })).toEqual({
      selected: undefined,
      choices: ["none", "vue", "svelte"],
    });
    expect(resolveIslands({ ...vue, ...svelte }, "svelte").selected).toEqual("svelte");
    expect(() => resolveIslands({ ...vue, "@astrojs/vue": "6.0.0" }, "vue")).toThrow(
      /@astrojs\/vue/,
    );
  });
});
