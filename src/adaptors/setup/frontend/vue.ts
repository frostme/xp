import { parse } from "@babel/parser";
import { createRequire } from "node:module";
import { posix, resolve } from "node:path";

import type { FrontendProfile } from "./types";

type Context = Parameters<FrontendProfile["generate"]>[0];
type SfcCompiler = typeof import("vue/compiler-sfc");

/** Resolve the default component argument to the unique createApp() imported from Vue. */
function mountedComponent(source: string, entry: string): string | undefined {
  const statements = parse(source, { sourceType: "module", plugins: ["typescript"] }).program.body;
  const imports = statements.filter((node) => node.type === "ImportDeclaration");
  const factories = imports
    .filter((node) => node.source.value === "vue")
    .flatMap((node) =>
      node.specifiers
        .filter(
          (spec) =>
            spec.type === "ImportSpecifier" &&
            spec.imported.type === "Identifier" &&
            spec.imported.name === "createApp",
        )
        .map((spec) => spec.local.name),
    );
  const calls = statements.flatMap((node) => {
    if (node.type !== "ExpressionStatement") return [];
    const expr = node.expression;
    if (
      expr.type !== "CallExpression" ||
      expr.callee.type !== "MemberExpression" ||
      expr.callee.computed ||
      expr.callee.property.type !== "Identifier" ||
      expr.callee.property.name !== "mount"
    )
      return [];
    const app = expr.callee.object;
    if (
      app.type !== "CallExpression" ||
      app.callee.type !== "Identifier" ||
      !factories.includes(app.callee.name) ||
      app.arguments.length !== 1 ||
      app.arguments[0]?.type !== "Identifier"
    )
      return [];
    return [app.arguments[0].name];
  });
  if (calls.length !== 1) return;
  const target = imports.find((node) =>
    node.specifiers.some(
      (spec) => spec.type === "ImportDefaultSpecifier" && spec.local.name === calls[0],
    ),
  )?.source.value;
  if (target?.startsWith(".") && target.endsWith(".vue"))
    return posix.join(posix.dirname(entry), target);
  return undefined;
}

async function rootPath(ctx: Context, nuxt: boolean): Promise<string | undefined> {
  if (nuxt) {
    if (
      (await ctx.read("app/app.vue")) !== null ||
      (await ctx.read("app/pages/index.vue")) !== null
    )
      return "app/app.vue";
    return;
  }
  const entries = await Promise.all(
    ["src/main.ts", "src/main.js"].map(async (path) => ({ path, source: await ctx.read(path) })),
  );
  const found = entries.filter((entry) => entry.source !== null);
  if (found.length === 1 && found[0]?.source) {
    try {
      return mountedComponent(found[0].source, found[0].path);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return undefined;
}

function wrapRoot(
  compiler: SfcCompiler,
  source: string,
  path: string,
  from: string,
  typescript: boolean,
): string | undefined {
  const result = compiler.parse(source, { filename: path });
  const { template, scriptSetup, script } = result.descriptor;
  if (
    result.errors.length ||
    !template ||
    template.src ||
    template.lang ||
    script?.src ||
    scriptSetup?.src
  )
    return;
  const nodes = template.ast?.children.filter(
    (node) => node.type !== 3 && !(node.type === 2 && !node.content.trim()),
  );
  const declaration = `import XpAppProvider from "${from}";`;
  if (
    scriptSetup?.content.includes(declaration) &&
    nodes?.length === 1 &&
    nodes[0]?.type === 1 &&
    nodes[0].tag === "XpAppProvider"
  )
    return source;
  if (
    source.includes("XpAppProvider") ||
    /\bXPProvider\b|<xp-provider\b/.test(source) ||
    source.includes(from)
  )
    return;
  const start = template.loc.start.offset;
  const end = template.loc.end.offset;
  const edits = [
    { at: start, text: "\n<XpAppProvider>" },
    { at: end, text: "</XpAppProvider>\n" },
  ];
  if (scriptSetup) edits.push({ at: scriptSetup.loc.start.offset, text: `\n${declaration}\n` });
  else {
    const lang = script ? script.lang : typescript ? "ts" : undefined;
    if (lang && !["ts", "js"].includes(lang)) return;
    edits.push({
      at: 0,
      text: `<script setup${lang ? ` lang="${lang}"` : ""}>\n${declaration}\n</script>\n`,
    });
  }
  return edits
    .sort((a, b) => b.at - a.at)
    .reduce((value, { at, text }) => value.slice(0, at) + text + value.slice(at), source);
}

async function generate(ctx: Context, nuxt: boolean) {
  const base = nuxt ? "app" : "src";
  const dir = base + "/xp";
  const ts = ctx.language === "typescript";
  const ext = ts ? "ts" : "js";
  const lang = ts ? ' lang="ts"' : "";
  const factory = ctx.transport === "graphql" ? "createGraphQLLoader" : "createRestLoader";
  const owned = [
    {
      path: dir + "/options." + ext,
      purpose: "Host session revision, transport and serializable preload seam",
      content: `import { ${factory} } from "@frostme/xp/client";
${ts ? 'import type { AssignmentLoader, XpPreload } from "@frostme/xp/client";\nimport type { InjectionKey, Ref } from "vue";\n\nexport type XpBootstrap = Partial<XpPreload> & { sessionKey?: string | number };\nexport type XpHost = XpBootstrap & { loader?: AssignmentLoader };\n' : ""}
export const xpBootstrap${ts ? ": InjectionKey<Readonly<Ref<XpHost>>>" : ""} = Symbol("xp bootstrap");
export const xpLoader = ${factory}({ endpoint: ${JSON.stringify(ctx.endpoint)} });
`,
    },
    {
      path: dir + "/XpAppProvider.vue",
      purpose: "Vue application provider",
      content: `<script setup${lang}>
import { inject${nuxt ? "" : ", shallowRef"} } from "vue";
import { XPProvider } from "@frostme/xp/vue";
import { xpBootstrap, xpLoader${nuxt && ts ? ", type XpBootstrap" : ""} } from "./options";
const bootstrap = inject(xpBootstrap, ${nuxt ? `useState${ts ? "<XpBootstrap>" : ""}("xp:bootstrap", () => ({}))` : `shallowRef${ts ? '<import("./options").XpHost>' : ""}({})`});
</script>
<template><XPProvider :loader="xpLoader" v-bind="bootstrap"><slot /></XPProvider></template>
`,
    },
    {
      path: dir + "/CheckoutBanner.vue",
      purpose: "Checkout banner example for a seeded experiment",
      content: `<script setup${lang}>
import { Experiment, Cohort } from "@frostme/xp/vue";
</script>
<template>
  <Experiment slug="checkout-banner">
    <template #loading>Loading checkout…</template>
    <Cohort slug="on">Express checkout</Cohort>
    <Cohort default>Checkout</Cohort>
  </Experiment>
  <Cohort slug="checkout-banner_on">Express checkout is available</Cohort>
</template>
`,
    },
  ];
  const path = await rootPath(ctx, nuxt);
  const registrations = [];
  if (path) {
    const existing = await ctx.read(path);
    const source =
      existing ?? (nuxt ? "<template><NuxtLayout><NuxtPage /></NuxtLayout></template>\n" : null);
    const require = createRequire(resolve(ctx.cwd, "package.json"));
    const compiler: SfcCompiler = require("vue/compiler-sfc");
    let from = posix.relative(posix.dirname(path), dir + "/XpAppProvider.vue");
    if (!from.startsWith(".")) from = "./" + from;
    const content = source && wrapRoot(compiler, source, path, from, ts);
    if (content) registrations.push({ path, kind: "vue-root", content });
  }
  return {
    owned,
    registrations,
    manual: registrations.length
      ? []
      : [
          `Unable to identify one safely wrappable ${path ?? (nuxt ? "app/app.vue" : "root imported by src/main.ts or src/main.js")}. Import XpAppProvider from ${dir}/XpAppProvider.vue and wrap the root template in <XpAppProvider>…</XpAppProvider> on server and client.`,
        ],
    nextSteps: [
      nuxt
        ? 'Set useState("xp:bootstrap") from request-local useAsyncData in a Nuxt app plugin before the initial render.'
        : "Provide a reactive bootstrap using app.provide(xpBootstrap, revisionAndPreload) in the SSR and browser app factories.",
    ],
  };
}

export const vue: FrontendProfile = {
  id: "vue",
  packages: { vue: ">=3.5.46 <4" },
  generate: (context) => generate(context, false),
};

export const nuxt: FrontendProfile = {
  id: "nuxt",
  packages: { nuxt: ">=4.6.4 <5", vue: ">=3.5.46 <4" },
  supersedes: ["vue"],
  generate: (context) => generate(context, true),
};
