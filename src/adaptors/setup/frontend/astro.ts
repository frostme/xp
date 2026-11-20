import { parse } from "@babel/parser";

import type { ScopedSetupOptions } from "~/interfaces/setup";

import type { FrontendProfile } from "./types";

import { islandFiles, islandPackages } from "./astro-islands";

const middlewarePaths = [
  "src/middleware.ts",
  "src/middleware.js",
  "src/middleware/index.ts",
  "src/middleware/index.js",
];

/** Preserve the initializer, including comments, arguments and existing middleware order. */
export function registerAstroMiddleware(source: string, helper: string): string | null {
  let body;
  try {
    body = parse(source, { sourceType: "module", plugins: ["typescript"] }).program.body;
  } catch {
    return null;
  }
  if (
    body.some(
      (node) =>
        node.type === "ExportNamedDeclaration" &&
        node.source?.value === helper &&
        node.specifiers.some(
          (s) =>
            s.type === "ExportSpecifier" &&
            s.local.type === "Identifier" &&
            s.local.name === "xpMiddleware" &&
            s.exported.type === "Identifier" &&
            s.exported.name === "onRequest",
        ),
    )
  )
    return source;
  const imports = body.filter((node) => node.type === "ImportDeclaration");
  const bindings = (module: string, binding: string) =>
    imports.flatMap((node) =>
      node.source.value === module
        ? node.specifiers.flatMap((s) =>
            s.type === "ImportSpecifier" &&
            s.imported.type === "Identifier" &&
            s.imported.name === binding
              ? [s.local.name]
              : [],
          )
        : [],
    );
  const registrations = body.flatMap((node) =>
    node.type === "ExportNamedDeclaration" &&
    node.declaration?.type === "VariableDeclaration" &&
    node.declaration.kind === "const"
      ? node.declaration.declarations.filter(
          (item) => item.id.type === "Identifier" && item.id.name === "onRequest",
        )
      : [],
  );
  if (registrations.length !== 1) return null;
  const init = registrations[0]?.init;
  const sequences = bindings("astro:middleware", "sequence");
  const helpers = bindings(helper, "xpMiddleware");
  if (init?.type === "Identifier" && helpers.includes(init.name)) return source;
  if (init?.type !== "CallExpression" || init.callee.type !== "Identifier") return null;
  if (sequences.includes(init.callee.name) && init.arguments.at(-1)?.type === "Identifier") {
    const tail = init.arguments.at(-1);
    if (tail?.type === "Identifier" && helpers.includes(tail.name)) return source;
  }
  if (
    ![...sequences, ...bindings("astro:middleware", "defineMiddleware")].includes(init.callee.name)
  )
    return null;
  if (helpers.length || /\b(xpSequence|xpMiddleware)\b/.test(source)) return null;
  if (init.start == null || init.end == null) return null;
  const sequence = sequences[0] ?? "xpSequence";
  const header = `${sequences.length ? "" : 'import { sequence as xpSequence } from "astro:middleware";\n'}import { xpMiddleware } from "${helper}";\n`;
  return (
    header +
    source.slice(0, init.start) +
    `${sequence}(` +
    source.slice(init.start, init.end) +
    ", xpMiddleware)" +
    source.slice(init.end)
  );
}

const example = `---
import { Experiment, Cohort } from "@frostme/xp/astro";
---
<Experiment slug="checkout-banner">
  <Fragment slot="cohort-on">New checkout banner</Fragment>
  <p>Current checkout banner</p>
</Experiment>
<Cohort slug="checkout-banner_on">Early access checkout</Cohort>
`;

export const astro: FrontendProfile = {
  id: "astro",
  packages: { astro: ">=7.4.13 <8" },
  optionalPackages: islandPackages,
  supersedes: ["react", "vue", "svelte", "solid"],
  async generate(ctx) {
    const ext = ctx.language === "javascript" ? "js" : "ts";
    const files = await Promise.all(
      middlewarePaths.map(async (path) => ({ path, source: await ctx.read(path) })),
    );
    const middleware = files.filter((file) => file.source !== null);
    const path = middleware[0]?.path ?? `src/middleware.${ext}`;
    const helper = path.includes("/middleware/") ? "../xp/request" : "./xp/request";
    const loader = ctx.transport === "graphql" ? "createGraphQLLoader" : "createRestLoader";
    const requestSource = `import { defineMiddleware } from "astro:middleware";
import { createXpRequest, ${loader} } from "@frostme/xp/client";

// In your authentication middleware, pass a trusted absolute endpoint and request-bound fetch/headers.
${ext === "js" ? '/** @param {import("@frostme/xp/client").LoaderOptions} options */\n' : ""}export function createHostLoader(options${ext === "ts" ? ': import("@frostme/xp/client").LoaderOptions' : ""}) {
  return ${loader}({ endpoint: ${JSON.stringify(ctx.endpoint)}, ...options });
}

export const xpMiddleware = defineMiddleware(async (context, next) => {
  const load = context.isPrerendered ? undefined : context.locals.xpHost?.load;
  context.locals.xp = createXpRequest(load ?? (async () => null), { signal: context.request.signal });
  const response = await next();
  if (load) response.headers.set("Cache-Control", "private, no-store");
  return response;
});
`;
    const owned = [
      {
        path: `src/xp/request.${ext}`,
        content: requestSource,
        purpose: "Request-local Astro middleware",
      },
      {
        path: "src/xp/locals.d.ts",
        content: `import type { XpLocals } from "@frostme/xp/astro";\nimport type { AssignmentLoader } from "@frostme/xp/client";\n\ndeclare global {\n  namespace App {\n    interface Locals extends XpLocals {\n      xpHost?: { load: AssignmentLoader; sessionKey?: string | number };\n    }\n  }\n}\n`,
        purpose: "Typed Astro request locals",
      },
      {
        path: "src/xp/CheckoutBanner.astro",
        content: example,
        purpose: "Server-rendered experiment example",
      },
    ];
    if (ctx.island && ctx.island !== "none")
      owned.push(
        ...islandFiles(
          ctx,
          ctx.island as Exclude<ScopedSetupOptions["island"], undefined | "none">,
        ),
      );
    const manual = [];
    let content =
      middleware.length === 0 ? `export { xpMiddleware as onRequest } from "${helper}";\n` : null;
    if (middleware.length === 1 && middleware[0]?.source) {
      const source = middleware[0].source;
      content = registerAstroMiddleware(source, helper);
    }
    if (!content)
      manual.push(
        `Review ${middleware.map((file) => file.path).join(", ")}. Could not identify one supported onRequest initializer. Import { xpMiddleware } from "${helper}" and export onRequest = sequence(yourAuthMiddleware, xpMiddleware).`,
      );
    return {
      owned,
      registrations: content ? [{ path, kind: "astro-middleware", content }] : [],
      manual,
      nextSteps: [
        ...(ctx.island && ctx.island !== "none"
          ? [
              'Register the selected official renderer in astro.config and import CheckoutIsland from "../xp/CheckoutIsland.astro" in your page.',
            ]
          : []),
        "After authentication, set context.locals.xpHost = { load, sessionKey } using a request-bound loader. Without a loader plain pages render the public default.",
        'Import CheckoutBanner from "../xp/CheckoutBanner.astro" into src/pages/index.astro and render <CheckoutBanner />. Use an on-demand route for personalized HTML.',
      ],
    };
  },
};
