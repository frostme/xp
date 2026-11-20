import { describe, expect, it } from "vitest";

import type { FrontendContext } from "../types";

import { astro, registerAstroMiddleware } from "../astro";

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
