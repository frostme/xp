import { parse } from "@babel/parser";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { FrontendContext, FrontendOutput, FrontendProfile } from "./types";

interface SyntaxNode {
  type: string;
  start: number;
  end: number;
  name?: string;
  value?: string;
  data?: string;
  fragment?: { nodes: SyntaxNode[] };
  expression?: SyntaxNode;
  callee?: SyntaxNode;
  arguments?: SyntaxNode[];
  specifiers?: { type: string; local: { name: string }; imported?: { name: string } }[];
  source?: { value: string };
  declarations?: { id: SyntaxNode; init: SyntaxNode }[];
  properties?: { key?: { name: string }; value?: { name: string } }[];
  declaration?: SyntaxNode;
  params?: SyntaxNode[];
  body?: SyntaxNode[] | SyntaxNode;
  argument?: SyntaxNode;
  typeAnnotation?: { typeAnnotation?: { typeName?: { name?: string } } };
  async?: boolean;
}

function statements(source: string): SyntaxNode[] {
  return parse(source, { sourceType: "module", plugins: ["typescript"] }).program
    .body as unknown as SyntaxNode[];
}

function usesRoot(source: string, module: string, methods: string[]) {
  const body = statements(source);
  const roots = body
    .filter((node) => node.source?.value === "./App.svelte")
    .flatMap((node) => node.specifiers ?? [])
    .filter((s) => s.type === "ImportDefaultSpecifier");
  const methodsUsed = body
    .filter((node) => node.source?.value === module)
    .flatMap((node) => node.specifiers ?? [])
    .filter((s) => methods.includes(s.imported?.name ?? ""));
  if (roots.length !== 1) return;
  const candidates = body.flatMap((node) => {
    const declaration = node.declaration ?? node;
    return [node.expression, ...(declaration.declarations ?? []).map((item) => item.init)];
  });
  const calls = candidates
    .map((node) =>
      node?.type === "ArrowFunctionExpression" && !Array.isArray(node.body) ? node.body : node,
    )
    .filter(
      (call) =>
        call?.type === "CallExpression" &&
        call.arguments?.[0]?.type === "Identifier" &&
        call.arguments[0].name === roots[0]!.local.name &&
        methodsUsed.some((method) => method.local.name === call.callee?.name),
    );
  if (calls.length !== 1) return;
  return methodsUsed.find((method) => method.local.name === calls[0]?.callee?.name)?.imported?.name;
}

async function rooted(ctx: FrontendContext) {
  const entries = await Promise.all(["src/main.ts", "src/main.js"].map((p) => ctx.read(p)));
  const present = entries.filter((entry): entry is string => entry !== null);
  if (present.length !== 1) return false;
  const method = usesRoot(present[0]!, "svelte", ["mount", "hydrate"]);
  if (method === "mount") return true;
  if (method !== "hydrate") return false;
  // Both compiler targets must render the identified App. Do not guess a server tree.
  for (const path of ["src/entry-server.ts", "src/entry-server.js"]) {
    const entry = await ctx.read(path);
    if (entry && usesRoot(entry, "svelte/server", ["render"])) return true;
  }
  return false;
}

type Insert = { at: number; value: string };
function insert(source: string, edits: Insert[]) {
  for (const { at, value } of edits.reverse().sort((a, b) => b.at - a.at)) {
    source = source.slice(0, at) + value + source.slice(at);
  }
  return source;
}

function layout(ctx: FrontendContext, source: string, kit: boolean) {
  const require = createRequire(join(ctx.cwd, "package.json"));
  const { parse: parseSvelte } = require("svelte/compiler") as {
    parse(
      source: string,
      options: { modern: true },
    ): {
      instance?: { content: { start: number; body: SyntaxNode[] } };
      fragment: { nodes: SyntaxNode[] };
    };
  };
  const tree = parseSvelte(source, { modern: true });
  const body = tree.instance?.content.body ?? [];
  const name = "AppXp";
  const from = kit ? "../xp/AppXp.svelte" : "./xp/AppXp.svelte";
  const ancestry: SyntaxNode[][] = [];
  function walk(nodes: SyntaxNode[], parents: SyntaxNode[]) {
    for (const node of nodes) {
      if (node.type === "RenderTag" && node.expression?.callee?.name === "children")
        ancestry.push([...parents, node]);
      if (node.fragment) walk(node.fragment.nodes, [...parents, node]);
    }
  }
  walk(tree.fragment.nodes, []);
  const roots = tree.fragment.nodes.filter(
    (n) => n.type !== "Comment" && (n.type !== "Text" || n.data?.trim()),
  );
  const registered = body.some(
    (n) =>
      n.source?.value === from &&
      n.specifiers?.some((s) => s.type === "ImportDefaultSpecifier" && s.local.name === name),
  );
  if (registered) {
    const ownsTree = kit
      ? ancestry.length === 1 && ancestry[0]!.some((n) => n.name === name)
      : roots.length === 1 && roots[0]!.name === name;
    return ownsTree ? source : undefined;
  }
  if (/\b(AppXp|XPProvider)\b/.test(source) || !roots.length) return;
  if (!kit && roots.some((node) => node.type.startsWith("Svelte") || node.type === "SnippetBlock"))
    return;
  const importLine = `import AppXp from "${from}";`;
  const edits: Insert[] = [];
  let attributes = "";
  let first = roots[0]!,
    last = roots.at(-1)!;
  const props = body
    .flatMap((n) => n.declarations ?? [])
    .find((d) => d.init?.callee?.name === "$props");
  if (kit) {
    if (ancestry.length !== 1 || props?.id.type !== "ObjectPattern") return;
    const data = props.id.properties?.find((prop) => prop.key?.name === "data")?.value?.name;
    if (!data) {
      if (
        props.id.typeAnnotation &&
        props.id.typeAnnotation.typeAnnotation?.typeName?.name !== "LayoutProps"
      )
        return;
      if (/\bdata\b/.test(source)) return;
      edits.push({ at: props.id.start + 1, value: " data," });
    }
    attributes = ` {...${data ?? "data"}.xp}`;
    first = last = ancestry[0]!.at(-1)!;
  } else if (props?.id.properties?.some((p) => p.key?.name === "xp" && p.value?.name === "xp")) {
    attributes = " {...xp}";
  }
  if (tree.instance) edits.push({ at: tree.instance.content.start, value: `\n  ${importLine}\n` });
  else edits.push({ at: 0, value: `<script>\n  ${importLine}\n</script>\n` });
  edits.push(
    { at: first.start, value: `<AppXp${attributes}>` },
    { at: last.end, value: "</AppXp>" },
  );
  return insert(source, edits);
}

function serverLoad(source: string) {
  const body = statements(source);
  const imports = body.filter((n) => n.source?.value === "../xp/request.server");
  if (imports.length)
    return imports.length === 1 &&
      imports[0]?.specifiers?.some(
        (s) => s.imported?.name === "loadXp" && s.local.name === "loadXp",
      ) &&
      /\bxp:\s*await loadXp\(/.test(source)
      ? source
      : undefined;
  if (/\bloadXp\b/.test(source)) return;
  const loads = body
    .filter((n) => n.type === "ExportNamedDeclaration")
    .flatMap((n) => n.declaration?.declarations ?? [])
    .filter((d) => d.id.name === "load");
  if (loads.length !== 1) return;
  const fn = loads[0]!.init;
  const event = fn.params?.[0];
  if (!event || event.type !== "Identifier" || !event.name || fn.type !== "ArrowFunctionExpression")
    return;
  const bodyNode = fn.body;
  if (!bodyNode || Array.isArray(bodyNode)) return;
  const last = Array.isArray(bodyNode.body) ? bodyNode.body.at(-1) : undefined;
  const result =
    bodyNode.type === "ObjectExpression"
      ? bodyNode
      : last?.type === "ReturnStatement"
        ? last.argument
        : undefined;
  if (
    result?.type !== "ObjectExpression" ||
    !result.properties?.every((p) => p.key?.name && p.key.name !== "xp")
  )
    return;
  if (
    bodyNode.type === "BlockStatement" &&
    Array.isArray(bodyNode.body) &&
    bodyNode.body.slice(0, -1).some((n) => /\breturn\b/.test(source.slice(n.start, n.end)))
  )
    return;
  const edits = [
    { at: 0, value: 'import { loadXp } from "../xp/request.server";\n' },
    { at: result.start + 1, value: ` xp: await loadXp(${event.name}),` },
  ];
  if (!fn.async) edits.push({ at: fn.start, value: "async " });
  return insert(source, edits);
}

async function generate(ctx: FrontendContext): Promise<FrontendOutput> {
  const ts = ctx.language === "typescript";
  const kit = ctx.frontend === "sveltekit";
  const ext = ts ? "ts" : "js";
  const lang = ts ? ' lang="ts"' : "";
  const factory = ctx.transport === "rest" ? "createRestLoader" : "createGraphQLLoader";
  const path = kit ? "src/routes/+layout.svelte" : "src/App.svelte";
  const out: FrontendOutput = {
    owned: [
      {
        path: "src/xp/AppXp.svelte",
        purpose: "Svelte provider and public transport",
        content: `<script module${lang}>
  import { ${factory} } from "@frostme/xp/client";
  const loader = ${factory}({ endpoint: ${JSON.stringify(ctx.endpoint)} });
</script>
<script${lang}>
  import { XPProvider } from "@frostme/xp/svelte";
  ${ts ? 'import type { ComponentProps } from "svelte";\n  ' : ""}let props${ts ? ": ComponentProps<typeof XPProvider>" : ""} = $props();
</script>
<XPProvider {loader} {...props} />
`,
      },
      {
        path: "src/xp/CheckoutBanner.svelte",
        purpose: "Checkout experiment usage example",
        content: `<script>
  import { Experiment, Cohort } from "@frostme/xp/svelte";
</script>
<Experiment slug="checkout-banner">
  {#snippet loading()}<p>Loading offer…</p>{/snippet}
  <Cohort slug="on"><p>New checkout offer</p></Cohort>
  <Cohort default><p>Standard checkout</p></Cohort>
</Experiment>
`,
      },
    ],
    registrations: [],
    manual: [],
    nextSteps: [
      "Render CheckoutBanner inside AppXp. Supply the app’s public sessionKey on login or account changes.",
    ],
  };
  if (kit) {
    const source = await ctx.read(`src/routes/+layout.server.${ext}`);
    const other = await ctx.read(`src/routes/+layout.server.${ts ? "js" : "ts"}`);
    const loadPath = `src/routes/+layout.server.${ext}`;
    out.owned.push({
      path: `src/xp/request.server.${ext}`,
      purpose: "Request-local SvelteKit preload",
      content: `import { createXpRequest${ts ? ", type AssignmentLoader" : ""} } from "@frostme/xp/client";
${
  ts
    ? `
export type XpRequestLocals = {
  load: AssignmentLoader;
  slugs: readonly string[];
  sessionKey: string | number;
};
`
    : ""
}
export async function loadXp(event${ts ? ": { locals: object; request: Request }" : ""}) {
  const host = ${ts ? "(event.locals as { xp?: XpRequestLocals })" : "event.locals"}.xp;
  if (!host) return { initialAssignments: {}, initialErrors: [] };
  const decisions = createXpRequest(host.load, { signal: event.request.signal });
  return { ...(await decisions.preload(host.slugs)), sessionKey: host.sessionKey };
}
`,
    });
    let content: string | undefined;
    if (source === null && other === null)
      content = `import { loadXp } from "../xp/request.server";\n${ts ? 'import type { LayoutServerLoad } from "./$types";\n' : ""}\nexport const load${ts ? ": LayoutServerLoad" : ""} = async (event) => ({ xp: await loadXp(event) });\n`;
    else if (source !== null && other === null) {
      try {
        content = serverLoad(source);
      } catch {
        /* An unrecognized server load remains host-owned. */
      }
    }
    if (content !== undefined)
      out.registrations.push({ path: loadPath, kind: "SvelteKit server load", content });
    else
      out.manual.push(
        `In ${loadPath} preserve existing redirects/data and add xp: await loadXp(event) to the returned object. Import { loadXp } from "../xp/request.server".`,
      );
    out.nextSteps?.push(
      "In the authenticated server hook set event.locals.xp to { load, slugs, sessionKey } and Cache-Control to private, no-store for personalized pages.",
    );
  }
  const serverLoadRegistered =
    !kit || out.registrations.some((r) => r.kind === "SvelteKit server load");
  let source = await ctx.read(path);
  if (kit && source === null)
    source = "<script>\n  let { data, children } = $props();\n</script>\n{@render children()}\n";
  let content: string | undefined;
  if (source !== null && serverLoadRegistered) {
    try {
      if (kit || (await rooted(ctx))) content = layout(ctx, source, kit);
    } catch {
      /* A custom bootstrap or template gets manual instructions. */
    }
  }
  if (content !== undefined)
    out.registrations.push({ path, kind: kit ? "SvelteKit layout" : "Svelte root", content });
  else
    out.manual.push(
      `No unique conventional root in ${path}. Import AppXp from "${kit ? "../xp" : "./xp"}/AppXp.svelte". ${kit ? "Wrap the child snippet in <AppXp {...data.xp}>{@render children()}</AppXp>." : "Wrap the existing markup in <AppXp {...xp}>…</AppXp>. For SSR, pass the same public xp props to App in render() and hydrate()."}`,
    );
  return out;
}

export const svelte: FrontendProfile = {
  id: "svelte",
  packages: { svelte: ">=5.59.0 <6" },
  generate,
};
export const sveltekit: FrontendProfile = {
  id: "sveltekit",
  packages: { svelte: ">=5.59.0 <6", "@sveltejs/kit": ">=3.4.0 <4" },
  supersedes: ["svelte"],
  generate,
};
