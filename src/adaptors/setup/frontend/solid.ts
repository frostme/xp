import { parse, type ParseResult } from "@babel/parser";
import { satisfies } from "semver";

import type { FrontendContext, FrontendOutput, FrontendProfile } from "./types";

type Syntax = { type: string; start?: number | null; end?: number | null; [key: string]: any };

function elements(node: unknown, visit: (node: Syntax) => void) {
  if (Array.isArray(node)) {
    node.forEach((child) => elements(child, visit));
  } else if (node && typeof node === "object" && "type" in node) {
    visit(node as Syntax);
    Object.values(node).forEach((child) => elements(child, visit));
  }
}

function inspect(source: string, module: string, start: boolean) {
  let tree: ParseResult;
  try {
    tree = parse(source, { sourceType: "module", plugins: ["jsx", "typescript"] });
  } catch {
    return;
  }
  const imports = tree.program.body.filter((node) => node.type === "ImportDeclaration");
  const binding = (path: string, name: string) =>
    imports.flatMap((node) =>
      node.source.value !== path
        ? []
        : node.specifiers
            .filter(
              (spec) =>
                spec.type === "ImportSpecifier" &&
                spec.imported.type === "Identifier" &&
                spec.imported.name === name,
            )
            .map((spec) => spec.local.name),
    );
  const wrap = start ? "XpRouterRoot" : "AppXp";
  const imported = binding("./xp/provider", wrap);
  // Limit edits to a unique application entry. Custom scopes and declarations remain app-owned.
  const candidates: Syntax[] = [];
  if (start) {
    const routers = binding("@solidjs/router", "Router");
    elements(tree.program, (node) => {
      if (node.type !== "JSXOpeningElement" || !routers.includes(node["name"].name)) return;
      const root = node["attributes"].find((attr: Syntax) => attr["name"]?.name === "root")?.value
        ?.expression;
      if (root?.type !== "ArrowFunctionExpression" || root.params[0]?.type !== "Identifier") return;
      elements(root.body, (element) => {
        const expr = element["expression"];
        if (
          element.type === "JSXExpressionContainer" &&
          expr?.type === "MemberExpression" &&
          !expr.computed &&
          expr.object.name === root.params[0].name &&
          expr.property.name === "children"
        )
          candidates.push(element);
      });
    });
  } else {
    const render = binding(module, "render");
    for (const statement of tree.program.body) {
      if (statement.type !== "ExpressionStatement") continue;
      const call = statement.expression;
      if (
        call.type !== "CallExpression" ||
        call.callee.type !== "Identifier" ||
        !render.includes(call.callee.name)
      )
        continue;
      const callback = call.arguments[0];
      if (
        callback?.type === "ArrowFunctionExpression" &&
        ["JSXElement", "JSXFragment"].includes(callback.body.type)
      )
        candidates.push(callback.body as Syntax);
    }
  }
  if (candidates.length !== 1) return;
  const candidate = candidates[0]!;
  if (imported.length === 1) {
    let installed = candidate["openingElement"]?.name.name === imported[0];
    if (start)
      elements(tree.program, (parent) => {
        if (
          parent.type === "JSXElement" &&
          parent["openingElement"]?.name.name === imported[0] &&
          parent["children"].includes(candidate)
        )
          installed = true;
      });
    return installed ? source : undefined;
  }
  if (
    new RegExp(`\\b(?:${wrap}|XPProvider)\\b`).test(source) ||
    candidate.start == null ||
    candidate.end == null
  )
    return;
  const offset = imports.at(-1)?.end ?? 0;
  return (
    source.slice(0, offset) +
    `\nimport { ${wrap} } from "./xp/provider";` +
    source.slice(offset, candidate.start) +
    `<${wrap}>` +
    source.slice(candidate.start, candidate.end) +
    `</${wrap}>` +
    source.slice(candidate.end)
  );
}

// Recognize an unambiguous pair of roots. Unknown auth/data expressions require the host
// to supply its public envelope explicitly to both trees.
function hydrationRoot(source: string, renderer: string, callName: "hydrate" | "renderToString") {
  let tree: ParseResult;
  try {
    tree = parse(source, { sourceType: "module", plugins: ["jsx", "typescript"] });
  } catch {
    return;
  }
  const body = tree.program.body;
  const imports = body.filter((node) => node.type === "ImportDeclaration");
  const renders = imports
    .filter((node) => node.source.value === renderer)
    .flatMap((node) =>
      node.specifiers
        .filter(
          (spec) =>
            spec.type === "ImportSpecifier" &&
            spec.imported.type === "Identifier" &&
            spec.imported.name === callName,
        )
        .map((spec) => spec.local.name),
    );
  const wrappers = imports
    .filter((node) => node.source.value === "./xp/provider")
    .flatMap((node) =>
      node.specifiers
        .filter(
          (spec) =>
            spec.type === "ImportSpecifier" &&
            spec.imported.type === "Identifier" &&
            spec.imported.name === "AppXp",
        )
        .map((spec) => spec.local.name),
    );
  const calls = body
    .flatMap((statement) => {
      if (callName === "hydrate" && statement.type === "ExpressionStatement")
        return [statement.expression];
      if (
        callName === "renderToString" &&
        statement.type === "ExportNamedDeclaration" &&
        statement.declaration?.type === "FunctionDeclaration" &&
        !statement.declaration.params.length
      ) {
        const statements = statement.declaration.body.body;
        if (
          statements.length === 1 &&
          statements[0]?.type === "ReturnStatement" &&
          statements[0].argument
        )
          return [statements[0].argument];
      }
      return [];
    })
    .filter(
      (n) =>
        n.type === "CallExpression" &&
        n.callee.type === "Identifier" &&
        renders.includes(n.callee.name),
    );
  const call = calls[0];
  if (calls.length !== 1 || call?.type !== "CallExpression") return;
  const callback = call.arguments[0];
  if (
    callback?.type !== "ArrowFunctionExpression" ||
    callback.params.length ||
    callback.body.type !== "JSXElement"
  )
    return;
  const target = callback.body;
  const outerName = target.openingElement.name;
  const installed = outerName.type === "JSXIdentifier" && wrappers.includes(outerName.name);
  const children = target.children.filter((n) => n.type !== "JSXText" || n.value.trim());
  const app = installed
    ? children.length === 1 && children[0]?.type === "JSXElement"
      ? children[0]
      : null
    : target;
  if (!app?.openingElement.selfClosing || app.openingElement.attributes.length) return;
  const name = app.openingElement.name;
  if (name.type !== "JSXIdentifier") return;
  const appImport = imports.find(
    (node) =>
      node.source.value.startsWith("./") &&
      node.specifiers.some(
        (spec) => spec.type === "ImportDefaultSpecifier" && spec.local.name === name.name,
      ),
  );
  if (!appImport) return;
  if (installed) return { root: appImport.source.value, content: source };
  if (
    wrappers.length ||
    /\b(?:AppXp|XPProvider)\b/.test(source) ||
    target.start == null ||
    target.end == null
  )
    return;
  const offset = imports.at(-1)?.end ?? 0;
  return {
    root: appImport.source.value,
    content:
      source.slice(0, offset) +
      '\nimport { AppXp } from "./xp/provider";' +
      source.slice(offset, target.start) +
      "<AppXp>" +
      source.slice(target.start, target.end) +
      "</AppXp>" +
      source.slice(target.end),
  };
}

async function generate(ctx: FrontendContext): Promise<FrontendOutput> {
  const start = ctx.frontend === "solidstart";
  const v2 = ctx.versions["solid-js"]?.startsWith("2.");
  const adapter = "@frostme/xp/solid" + (v2 ? "" : "/v1");
  if (v2 && !satisfies(ctx.versions["@solidjs/web"] ?? "", ">=2.0.3 <3")) {
    throw new Error(
      "Install and declare @solidjs/web (>=2.0.3 <3) alongside solid-js 2 before running setup.",
    );
  }
  const entries: { path: string; source: string }[] = [];
  const names = start ? ["app"] : ["index", "main", "entry-client"];
  for (const name of names)
    for (const ext of ["jsx", "tsx"]) {
      const path = `src/${name}.${ext}`;
      const source = await ctx.read(path);
      if (source !== null) entries.push({ path, source });
    }
  const entry = entries.length === 1 ? entries[0] : undefined;
  const ts = entry ? entry.path.endsWith(".tsx") : ctx.language === "typescript";
  const ext = ts ? "tsx" : "jsx";
  const hostQueryPath = `src/xp-bootstrap.${ts ? "ts" : "js"}`;
  const hostQuerySource = start ? await ctx.read(hostQueryPath) : null;
  if (hostQuerySource !== null) {
    const program = parse(hostQuerySource, {
      sourceType: "module",
      plugins: ["typescript"],
    }).program;
    if (
      !program.body.some(
        (node) =>
          node.type === "ExportNamedDeclaration" &&
          ((node.declaration?.type === "VariableDeclaration" &&
            node.declaration.declarations.some(
              (binding) => binding.id.type === "Identifier" && binding.id.name === "xpBootstrap",
            )) ||
            node.specifiers.some(
              (binding) =>
                binding.exported.type === "Identifier" && binding.exported.name === "xpBootstrap",
            )),
      )
    )
      throw new Error(
        `Export a named xpBootstrap server query from ${hostQueryPath} before mounting it in SolidStart.`,
      );
  }
  const hostQuery = hostQuerySource !== null;
  const query = start
    ? `import { createAsync${hostQuery ? "" : ", query"} } from "@solidjs/router";
import { Show${ts ? ", type ParentProps" : ""} } from "solid-js";
`
    : "";
  const queryBody = hostQuery
    ? 'import { xpBootstrap } from "../xp-bootstrap";\n'
    : `export const xpBootstrap = query(async () => {
  "use server";
  return { initialAssignments: {}, initialErrors: []${ts ? " as string[]" : ""}, sessionKey: "guest" };
}, "xp-bootstrap");\n`;
  const router = start
    ? `
${queryBody}
export function XpRouterRoot(props${ts ? ": ParentProps" : ""}) {
  const bootstrap = createAsync(() => xpBootstrap());
  return <Show when={bootstrap()}>{value => <AppXp {...value()}>{props.children}</AppXp>}</Show>;
}
`
    : "";
  const output: FrontendOutput = {
    owned: [
      {
        path: `src/xp/provider.${ext}`,
        purpose: "Solid decision provider",
        content: `${query}import { XPProvider${ts ? ", type XPProviderProps" : ""} } from "${adapter}";

export function AppXp(props${ts ? ": XPProviderProps" : ""}) {
  return <XPProvider loader=${JSON.stringify(ctx.transport)} endpoint=${JSON.stringify(ctx.endpoint)} {...props} />;
}
${router}`,
      },
      {
        path: `src/xp/CheckoutBanner.${ext}`,
        purpose: "Checkout experiment usage example",
        content: `import { Cohort, Experiment } from "${adapter}";

export function CheckoutBanner() {
  return <Experiment slug="checkout-banner" loading={<p>Loading…</p>}>
    <Cohort slug="on"><p>New checkout offer</p></Cohort>
    <Cohort default><p>Standard checkout</p></Cohort>
  </Experiment>;
}
`,
      },
    ],
    registrations: [],
    manual: [],
    nextSteps: [
      "Render <CheckoutBanner /> inside AppXp. Pass an opaque public sessionKey updated on account changes.",
      ...(start
        ? [
            "For authenticated SSR, supply a host-owned server query using createXpRequest in your router root. Pass its public preload and session revision to AppXp, and revalidate that query when identity changes.",
          ]
        : []),
    ],
  };
  const renderer = v2 ? "@solidjs/web" : "solid-js/web";
  const client = entry && !start && hydrationRoot(entry.source, renderer, "hydrate");
  if (entry && client) {
    const servers = [];
    for (const path of [`src/entry-server.${ext}`, `src/server.${ext}`]) {
      const source = await ctx.read(path);
      if (source !== null)
        servers.push({ path, root: hydrationRoot(source, renderer, "renderToString") });
    }
    const server = servers.length === 1 ? servers[0] : undefined;
    if (server?.root && server.root.root === client.root) {
      output.registrations.push(
        { path: entry.path, kind: "Solid hydrate root", content: client.content },
        { path: server.path, kind: "Solid server render root", content: server.root.content },
      );
      return output;
    }
  }
  const content = entry && inspect(entry.source, renderer, start);
  if (entry && content !== undefined)
    output.registrations.push({
      path: entry.path,
      kind: start ? "SolidStart router children" : "Solid render root",
      content,
    });
  else
    output.manual.push(
      start
        ? "In src/app, wrap routed children inside the existing router root with XpRouterRoot from ./xp/provider."
        : "Import AppXp from ./xp/provider (named export). Wrap the app in <AppXp {...publicBootstrap}><App /></AppXp> inside both renderToString and hydrate callbacks, passing the same public bootstrap on each side.",
    );
  return output;
}

export const solid: FrontendProfile = {
  id: "solid",
  optionalPackages: ["@solidjs/web"],
  packages: { "solid-js": ">=1.9.20 <1.10 || >=2.0.3 <3" },
  generate,
};
export const solidstart: FrontendProfile = {
  id: "solidstart",
  packages: {
    "@solidjs/start": ">=2.2.3 <3",
    "solid-js": ">=1.9.20 <1.10",
    "@solidjs/router": ">=1.0.3 <2",
  },
  supersedes: ["solid"],
  generate,
};
