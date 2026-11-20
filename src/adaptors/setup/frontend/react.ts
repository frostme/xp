import { parse } from "@babel/parser";

import type { FrontendProfile, FrontendOutput } from "./types";

type Node = { type: string; start: number; end: number; [key: string]: any };

function mount(source: string) {
  let statements: Node[];
  try {
    statements = parse(source, { sourceType: "module", plugins: ["jsx", "typescript"] }).program
      .body as Node[];
  } catch {
    return;
  }
  const imports = statements.filter((node) => node.type === "ImportDeclaration");
  const bindings = (module: string, name: string) =>
    imports
      .filter((node) => node["source"].value === module)
      .flatMap((node) =>
        node["specifiers"]
          .filter((spec: Node) => spec["imported"]?.name === name)
          .map((spec: Node) => spec["local"].name as string),
      );
  const roots = bindings("react-dom/client", "createRoot");
  const hydrate = bindings("react-dom/client", "hydrateRoot");
  const expressions = statements
    .filter((node) => node.type === "ExpressionStatement")
    .map((node) => node["expression"] as Node);
  const calls = expressions.filter(
    (node) =>
      node.type === "CallExpression" &&
      (hydrate.includes(node["callee"].name) ||
        (node["callee"].type === "MemberExpression" &&
          !node["callee"].computed &&
          node["callee"].property.name === "render" &&
          node["callee"].object.type === "CallExpression" &&
          roots.includes(node["callee"].object.callee.name))),
  );
  if (calls.length !== 1) return;
  const call = calls[0]!;
  if (hydrate.includes(call["callee"].name)) return; // The server tree and data handoff are host-owned.
  const element = call["arguments"][0] as Node | undefined;
  if (!element || !["JSXElement", "JSXFragment"].includes(element.type)) return;
  const registered = bindings("./xp/provider", "AppXp");
  if (registered.includes(element["openingElement"]?.name?.name)) return source;
  if (registered.length || /\b(?:AppXp|XPProvider)\b/.test(source)) return;
  const offset = imports.at(-1)?.end ?? 0;
  return (
    source.slice(0, offset) +
    '\nimport { AppXp } from "./xp/provider";' +
    source.slice(offset, element.start) +
    "<AppXp>" +
    source.slice(element.start, element.end) +
    "</AppXp>" +
    source.slice(element.end)
  );
}

export const react: FrontendProfile = {
  id: "react",
  packages: { react: ">=19.3.1 <20", "react-dom": ">=19.3.1 <20" },
  async generate({ read, language, endpoint, transport }) {
    const entries = [];
    for (const path of ["src/main.tsx", "src/main.jsx"]) {
      const source = await read(path);
      if (source !== null) entries.push({ path, source });
    }
    const entry = entries.length === 1 ? entries[0] : undefined;
    const ts = entry ? entry.path.endsWith(".tsx") : language === "typescript";
    const ext = ts ? "tsx" : "jsx";
    const factory = transport === "graphql" ? "createGraphQLLoader" : "createRestLoader";
    const output: FrontendOutput = {
      owned: [
        {
          path: `src/xp/provider.${ext}`,
          purpose: "React decision provider and public transport",
          content: `import { ${factory} } from "@frostme/xp/client";
import { XPProvider${ts ? ", type XPProviderProps" : ""} } from "@frostme/xp/react";

const loader = ${factory}({ endpoint: ${JSON.stringify(endpoint)} });

export function AppXp(props${ts ? ": XPProviderProps" : ""}) {
  return <XPProvider loader={loader} {...props} />;
}
`,
        },
        {
          path: `src/xp/CheckoutBanner.${ext}`,
          purpose: "Checkout experiment usage example",
          content: `import { Experiment, Cohort } from "@frostme/xp/react";

export function CheckoutBanner() {
  return <Experiment slug="checkout-banner" loading={<p>Loading offer…</p>}>
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
        "Render <CheckoutBanner /> inside AppXp after seeding checkout-banner. Pass the app's opaque session revision as sessionKey when the account changes.",
      ],
    };
    const content = entry && mount(entry.source);
    if (entry && content !== undefined)
      output.registrations.push({ path: entry.path, kind: "React DOM root", content });
    else
      output.manual.push(
        `No unique client-only React mount in ${entries.map(({ path }) => path).join(", ") || "src/main.tsx or src/main.jsx"}. Import { AppXp } from "./xp/provider" and wrap the existing root as <AppXp {...publicBootstrap}><App /></AppXp>. For hydration, wrap the server tree and hydrateRoot tree identically and serialize the same publicBootstrap.`,
      );
    return output;
  },
};
