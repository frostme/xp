import { describe, expect, it } from "vitest";

import type { FrontendContext } from "../frontend/types";

import { solid, solidstart } from "../frontend/solid";

function context(
  files: Record<string, string>,
  values: Partial<FrontendContext> = {},
): FrontendContext {
  return {
    cwd: ".",
    frontend: "solid",
    transport: "rest",
    endpoint: "/xp",
    language: "typescript",
    island: "none",
    versions: { "solid-js": "2.0.3", "@solidjs/web": "2.0.3" },
    read: async (path) => files[path] ?? null,
    ...values,
  };
}

describe("Solid setup", () => {
  it.each(["tsx", "jsx"])(
    "wraps a conventional %s client render and preserves host edits on rerun",
    async (ext) => {
      const path = `src/main.${ext}`;
      const before =
        'import { render as attach } from "@solidjs/web";\nimport App from "./App";\nattach(() => <App theme="shop" />, root);\n';
      const files = { [path]: before };
      const first = await solid.generate(context(files));
      const content = first.registrations[0]?.content ?? "";
      expect(content).toContain('<AppXp><App theme="shop" /></AppXp>');
      expect(files[path]).toBe(before);
      expect(first.owned[0]?.path).toBe("src/xp/provider." + ext);
      files[path] = content + "// local edit\n";
      expect((await solid.generate(context(files))).registrations[0]?.content).toBe(files[path]);
    },
  );
  it("leaves ambiguous roots and unpaired hydration alone, and requires a compatible Solid 2 renderer", async () => {
    const input = 'import { hydrate } from "solid-js/web"; hydrate(() => <App/>, root);';
    const first = await solid.generate(
      context({ "src/index.jsx": input }, { versions: { "solid-js": "1.9.20" } }),
    );
    expect(first.registrations).toHaveLength(0);
    expect(first.owned[0]?.content).toContain("@frostme/xp/solid/v1");
    expect(first.manual.join(" ")).toContain("renderToString");
    await expect(
      solid.generate(context({}, { versions: { "solid-js": "2.0.3" } })),
    ).rejects.toThrow("@solidjs/web");
  });
  it("wraps matching server and browser roots together and leaves a mismatched pair untouched", async () => {
    const files = {
      "src/main.tsx":
        'import App from "./App"; import { hydrate } from "@solidjs/web"; hydrate(() => <App />, root);',
      "src/entry-server.tsx":
        'import App from "./App"; import { renderToString } from "@solidjs/web"; export function page() { return renderToString(() => <App />); }',
    };
    const output = await solid.generate(context(files));
    expect(output.registrations).toHaveLength(2);
    for (const edit of output.registrations) {
      expect(edit.content).toContain("<AppXp><App /></AppXp>");
      Object.assign(files, { [edit.path]: edit.content });
    }
    expect((await solid.generate(context(files))).registrations).toEqual(output.registrations);
    files["src/main.tsx"] = files["src/main.tsx"].replace('"./App"', '"./OtherApp"');
    expect((await solid.generate(context(files))).registrations).toHaveLength(0);
  });
  it("preserves the router and suspense tree and accepts a host-owned query", async () => {
    const file =
      'import {Router} from "@solidjs/router";\nexport default () => <Router root={p => <Suspense><Nav />{p.children}</Suspense>}><FileRoutes /></Router>';
    const files = {
      "src/app.tsx": file,
      "src/xp-bootstrap.ts": 'export const xpBootstrap = query(load, "fixture");',
    };
    const options = { frontend: "solidstart", versions: { "solid-js": "1.9.20" } };
    const result = await solidstart.generate(context(files, options));
    expect(result.owned[0]?.content).toContain('from "../xp-bootstrap"');
    files["src/app.tsx"] = result.registrations[0]!.content;
    expect(files["src/app.tsx"]).toContain(
      "<Suspense><Nav /><XpRouterRoot>{p.children}</XpRouterRoot></Suspense>",
    );
    expect((await solidstart.generate(context(files, options))).registrations[0]?.content).toBe(
      files["src/app.tsx"],
    );
  });
});
