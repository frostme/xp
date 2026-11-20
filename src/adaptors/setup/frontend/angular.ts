import { parse } from "@babel/parser";
import path from "node:path";

import type { FrontendProfile } from "./types";

type Node = { type: string; start: number; end: number; [key: string]: any };

function ast(source: string) {
  return parse(source, { sourceType: "module", plugins: ["typescript", "decorators-legacy"] })
    .program.body as unknown as Node[];
}

function imports(nodes: Node[], from: string, name: string): string[] {
  return nodes
    .filter(
      (n) =>
        n.type === "ImportDeclaration" && n["source"].value === from && n["importKind"] !== "type",
    )
    .flatMap((n) => n["specifiers"])
    .filter(
      (n) => n.type === "ImportSpecifier" && n.imported.name === name && n["importKind"] !== "type",
    )
    .map((n) => n["local"].name);
}

function nodesIn(node: Node, type: string): Node[] {
  const found: Node[] = [];
  function visit(item: unknown) {
    if (!item || typeof item !== "object") return;
    const n = item as Node;
    if (n.type === type) found.push(n);
    for (const [key, value] of Object.entries(n)) {
      if (key === "loc") continue;
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  }
  visit(node);
  return found;
}

function bootstrap(nodes: Node[]) {
  const names = imports(nodes, "@angular/platform-browser", "bootstrapApplication");
  const calls = nodes
    .flatMap((n) => nodesIn(n, "CallExpression"))
    .filter((n) => names.includes(n["callee"].name));
  return calls.length === 1 ? calls[0] : undefined;
}

function sourceImport(nodes: Node[], local: string, from: string) {
  for (const node of nodes) {
    if (node.type !== "ImportDeclaration" || !node["source"].value.startsWith(".")) continue;
    const specifier = node["specifiers"].find(
      (s: Node) => s.type === "ImportSpecifier" && s["local"].name === local,
    );
    if (specifier)
      return {
        file: path.posix.join(
          path.posix.dirname(from),
          node["source"].value.replace(/\.js$/, "") + ".ts",
        ),
        name: specifier.imported.name,
      };
  }
  return null;
}

function literalConfig(nodes: Node[], name: string) {
  return nodes
    .flatMap((n) =>
      n.type === "ExportNamedDeclaration" ? (n["declaration"]?.declarations ?? []) : [],
    )
    .find((n) => n.id.type === "Identifier" && n.id.name === name)?.init as Node | undefined;
}

function addProvider(source: string, file: string, config: Node | undefined) {
  if (config?.type !== "ObjectExpression") return;
  if (config["properties"].some((p: Node) => p.type !== "ObjectProperty" || p["computed"])) return;
  const properties = config["properties"].filter(
    (p: Node) => (p["key"].name ?? p["key"].value) === "providers",
  );
  const providers = properties[0]?.value;
  if (properties.length !== 1 || providers?.type !== "ArrayExpression") return;
  let from = path.posix.relative(path.posix.dirname(file), "src/xp/providers");
  if (!from.startsWith(".")) from = "./" + from;
  const imported = imports(ast(source), from, "provideAppXp");
  const registrations = providers.elements.filter(
    (n: Node | null) =>
      n?.type === "CallExpression" &&
      imported.includes(n["callee"].name) &&
      n["arguments"].length === 0,
  );
  if (registrations.length === 1) return source;
  if (registrations.length || imported.length || /\b(?:provideAppXp|provideXp)\b/.test(source))
    return;
  const last = providers.elements.at(-1);
  const offset = last?.end ?? providers.start + 1;
  const withProvider =
    source.slice(0, offset) + (last ? ", " : "") + "provideAppXp()" + source.slice(offset);
  const lastImport = ast(source)
    .filter((n) => n.type === "ImportDeclaration")
    .at(-1);
  const insertion = lastImport?.end ?? 0;
  return (
    withProvider.slice(0, insertion) +
    "\nimport { provideAppXp } from " +
    JSON.stringify(from) +
    ";\n" +
    withProvider.slice(insertion)
  );
}

function helper(transport: string, endpoint: string) {
  return `import { InjectionToken, TransferState, inject, makeStateKey, type Provider } from "@angular/core";
import { provideXp, type XpAngularOptions } from "@frostme/xp/angular";
import type { XpPreload } from "@frostme/xp/client";

type Bootstrap = Partial<XpPreload> & { sessionKey?: string | number };
const key = makeStateKey<Bootstrap>("xp.frontend");
const initial = new InjectionToken<Bootstrap>("xp request preload", {
  factory: () => inject(TransferState).get(key, {}),
});

// Provide a getter from host code to rotate sessionKey or use a custom browser loader.
export const APP_XP_OPTIONS = new InjectionToken<() => XpAngularOptions>("app xp options");

export function provideAppXp() {
  return provideXp(() => ({
    loader: ${JSON.stringify(transport)},
    endpoint: ${JSON.stringify(endpoint)},
    ...inject(initial),
    ...inject(APP_XP_OPTIONS, { optional: true })?.(),
  }));
}

// Call in the server application injector once for this authenticated request.
export function provideAppXpPreload(read: () => XpPreload & { sessionKey: string | number }): Provider {
  return {
    provide: initial,
    useFactory: () => {
      const { initialAssignments, initialErrors, sessionKey } = read();
      const data = { initialAssignments, initialErrors, sessionKey };
      inject(TransferState).set(key, data);
      return data;
    },
  };
}
`;
}

const example = `import { Component, inject } from "@angular/core";
import { XpCohort, XpDecisions, XpDefault, XpExperiment, XpLoading } from "@frostme/xp/angular";

@Component({
  selector: "xp-checkout-example",
  imports: [XpExperiment, XpCohort, XpDefault, XpLoading],
  template: \`
    <section xpExperiment="checkout-banner">
      <span *xpLoading>Checking…</span>
      <span *xpCohort="'on'">New checkout</span>
      <span *xpDefault>Standard checkout</span>
    </section>
    <button (click)="checkout().refresh()">Retry</button>
  \`,
})
export class CheckoutExample {
  readonly checkout = inject(XpDecisions).cohort("checkout-banner");
}
`;

export const angular: FrontendProfile = {
  id: "angular",
  packages: { "@angular/core": ">=22.3.0 <23" },
  async generate(ctx) {
    const owned = [
      {
        path: "src/xp/providers.ts",
        content: helper(ctx.transport, ctx.endpoint),
        purpose: "Angular bootstrap, request preload and application option hook",
      },
      {
        path: "src/xp/checkout-example.ts",
        content: example,
        purpose: "Standalone checkout-banner example",
      },
    ];
    let file = "src/main.ts";
    const manual = () => ({
      owned,
      registrations: [],
      manual: [
        `Inspect ${file} and any server bootstrap. Import provideAppXp from src/xp/providers and append provideAppXp() to the shared ApplicationConfig.providers on both roots. Setup could not uniquely match the application configuration.`,
      ],
    });
    const main = await ctx.read(file);
    if (!main) return manual();
    try {
      const mainNodes = ast(main);
      const call = bootstrap(mainNodes);
      const root = sourceImport(mainNodes, call?.["arguments"][0]?.name, file);
      if (!call || !root) return manual();
      let config = call["arguments"][1] as Node;
      let source = main;
      const configImport = sourceImport(mainNodes, config?.["name"], file);
      if (configImport) {
        file = configImport.file;
        const configFile = await ctx.read(file);
        if (!configFile) return manual();
        source = configFile;
        config = literalConfig(ast(source), configImport.name)!;
      }
      const server = await ctx.read("src/main.server.ts");
      if (server || source.includes("provideClientHydration")) {
        if (!server || !configImport) return manual();
        const serverNodes = ast(server);
        const start = bootstrap(serverNodes);
        const serverRoot = sourceImport(
          serverNodes,
          start?.["arguments"][0]?.name,
          "src/main.server.ts",
        );
        const serverConfig = sourceImport(
          serverNodes,
          start?.["arguments"][1]?.name,
          "src/main.server.ts",
        );
        if (serverRoot?.file !== root.file || serverRoot.name !== root.name || !serverConfig)
          return manual();
        if (serverConfig.file !== configImport.file || serverConfig.name !== configImport.name) {
          const text = await ctx.read(serverConfig.file);
          if (!text) return manual();
          const serverAst = ast(text);
          const merged = literalConfig(serverAst, serverConfig.name);
          if (
            merged?.type !== "CallExpression" ||
            !imports(serverAst, "@angular/core", "mergeApplicationConfig").includes(
              merged["callee"].name,
            )
          )
            return manual();
          const shared = sourceImport(serverAst, merged["arguments"][0]?.name, serverConfig.file);
          if (shared?.file !== configImport.file || shared.name !== configImport.name)
            return manual();
        }
      }
      const content = addProvider(source, file, config);
      if (content === undefined) return manual();
      return {
        owned,
        registrations: [{ path: file, kind: "angular-application-config", content }],
        manual: [],
      };
    } catch (error) {
      if (error instanceof SyntaxError) return manual();
      throw error;
    }
  },
};
