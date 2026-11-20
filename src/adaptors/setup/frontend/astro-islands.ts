import { satisfies } from "semver";

import type { GeneratedFile, ScopedSetupOptions } from "~/interfaces/setup";

import type { FrontendContext } from "./types";

type Renderer = Exclude<ScopedSetupOptions["island"], undefined | "none">;
const packages = {
  react: { "@astrojs/react": ">=7.1.9 <8", react: ">=19.3.1 <20", "react-dom": ">=19.3.1 <20" },
  vue: { "@astrojs/vue": ">=7.1.6 <8", vue: ">=3.5.46 <4" },
  svelte: { "@astrojs/svelte": ">=9.1.6 <10", svelte: ">=5.59.0 <6" },
  solid: { "@astrojs/solid-js": ">=7.1.6 <8", "solid-js": ">=1.9.20 <1.10" },
} as const;
const renderers = Object.keys(packages) as Renderer[];
export const islandPackages = Object.values(packages).flatMap(Object.keys);

export function resolveIslands(
  versions: Record<string, string>,
  requested?: ScopedSetupOptions["island"],
) {
  const compatible = renderers.filter((renderer) =>
    Object.entries(packages[renderer]).every(
      ([name, range]) => versions[name] && satisfies(versions[name]!, range),
    ),
  );
  if (requested && requested !== "none" && !compatible.includes(requested)) {
    throw new Error(
      `For --island ${requested}, install and declare ${Object.entries(packages[requested])
        .map(([name, range]) => `${name}@${range}`)
        .join(", ")} in this app, or select --island none.`,
    );
  }
  const selected = requested ?? (compatible.length < 2 ? (compatible[0] ?? "none") : undefined);
  return { selected, choices: ["none" as const, ...compatible] };
}

function jsxIsland(solid: boolean, typed: boolean) {
  const binding = solid ? "solid/v1" : "react";
  const read = solid ? "result()" : "result";
  const imports = solid ? "createCohort" : "useCohort";
  const list = solid
    ? "<For each={props.experiments}>{slug => <Decision slug={slug} />}</For>"
    : "{props.experiments.map(slug => <Decision key={slug} slug={slug} />)}";
  return `import { XPProvider, Experiment, Cohort, ${imports} } from "@frostme/xp/${binding}";
import { loader } from "./island-loader";
${typed ? 'import type { IslandProps } from "./island-props";\n' : ""}${solid ? 'import { For } from "solid-js";\n' : ""}
function Decision(props${typed ? ": { slug: string }" : ""}) {
  const result = ${solid ? "createCohort(() => props.slug)" : "useCohort(props.slug)"};
  return <article aria-label={props.slug}>
    <output aria-label="Status">{${read}.status}</output>
    <Experiment slug={props.slug} loading={<span>Loading</span>}>
      <Cohort slug="on">New offer</Cohort><Cohort slug="off">Previous offer</Cohort><Cohort default>Current offer</Cohort>
    </Experiment>
    <button onClick={() => void ${read}.refresh()}>Refresh</button>
  </article>;
}

export default function XpIsland(props${typed ? ": IslandProps" : ""}) {
  return <XPProvider {...props.preload} sessionKey={props.sessionKey} loader={loader}>
    ${list}
  </XPProvider>;
}
`;
}

function vueIsland(typed: boolean) {
  const script = typed ? 'script setup lang="ts"' : "script setup";
  return [
    `<${script}>
import { XPProvider } from "@frostme/xp/vue";
import { loader } from "./island-loader";
import Decision from "./IslandDecision.vue";
${typed ? 'import type { IslandProps } from "./island-props";\ndefineProps<IslandProps>();' : 'defineProps(["preload", "sessionKey", "experiments"]);'}
</script>
<template><XPProvider v-bind="preload" :session-key="sessionKey" :loader="loader"><Decision v-for="slug in experiments" :key="slug" :slug="slug" /></XPProvider></template>
`,
    `<${script}>
import { Experiment, Cohort, useCohort } from "@frostme/xp/vue";
const props = defineProps(${typed ? "{ slug: { type: String, required: true } }" : '["slug"]'});
const result = useCohort(() => props.slug);
</script>
<template><article :aria-label="slug"><output aria-label="Status">{{ result.status }}</output>
  <Experiment :slug="slug"><template #loading>Loading</template><Cohort slug="on">New offer</Cohort><Cohort slug="off">Previous offer</Cohort><Cohort default>Current offer</Cohort></Experiment>
  <button @click="result.refresh()">Refresh</button>
</article></template>
`,
  ];
}

function svelteIsland(typed: boolean) {
  const script = typed ? 'script lang="ts"' : "script";
  return [
    `<${script}>
import { XPProvider } from "@frostme/xp/svelte";
import { loader } from "./island-loader";
import Decision from "./IslandDecision.svelte";
${typed ? 'import type { IslandProps } from "./island-props";\n' : ""}let { preload, sessionKey, experiments }${typed ? ": IslandProps" : ""} = $props();
</script>
<XPProvider {...preload} {sessionKey} {loader}>{#each experiments as slug (slug)}<Decision {slug} />{/each}</XPProvider>
`,
    `<${script}>
import { Experiment, Cohort, cohortStore } from "@frostme/xp/svelte";
let { slug }${typed ? ": { slug: string }" : ""} = $props();
const result = cohortStore(() => slug);
</script>
<article aria-label={slug}><output aria-label="Status">{$result.status}</output>
  <Experiment {slug}>{#snippet loading()}Loading{/snippet}<Cohort slug="on">New offer</Cohort><Cohort slug="off">Previous offer</Cohort><Cohort default>Current offer</Cohort></Experiment>
  <button onclick={() => void $result.refresh()}>Refresh</button>
</article>
`,
  ];
}

export function islandFiles(ctx: FrontendContext, renderer: Renderer): GeneratedFile[] {
  const typed = ctx.language === "typescript";
  const extension =
    renderer === "react" || renderer === "solid" ? (typed ? "tsx" : "jsx") : renderer;
  const components =
    renderer === "vue"
      ? vueIsland(typed)
      : renderer === "svelte"
        ? svelteIsland(typed)
        : [jsxIsland(renderer === "solid", typed)];
  const constructor = ctx.transport === "graphql" ? "createGraphQLLoader" : "createRestLoader";
  return [
    {
      path: `src/xp/island-loader.${typed ? "ts" : "js"}`,
      content: `import { ${constructor} } from "@frostme/xp/client";\nexport const loader = ${constructor}({ endpoint: ${JSON.stringify(ctx.endpoint)} });\n`,
      purpose: "Public browser decision transport",
    },
    {
      path: "src/xp/island-props.d.ts",
      content:
        'import type { XpPreload } from "@frostme/xp/client";\nexport interface IslandProps { preload: XpPreload; sessionKey: string | number; experiments: readonly string[] }\n',
      purpose: "Serializable Astro island props",
    },
    ...components.map((content, i) => ({
      path: `src/xp/${i ? "IslandDecision" : "XpIsland"}.${extension}`,
      content,
      purpose: "Hydrated experiment component",
    })),
    {
      path: "src/xp/CheckoutIsland.astro",
      content: `---\nimport XpIsland from "./XpIsland.${extension}";\nconst experiments = ["checkout-banner"];\nconst preload = !Astro.isPrerendered && Astro.locals.xpHost ? await Astro.locals.xp.preload(experiments) : { initialAssignments: {}, initialErrors: [] };\n---\n<XpIsland client:load {preload} {experiments} sessionKey={Astro.locals.xpHost?.sessionKey ?? 0} />\n`,
      purpose: "Request-preloaded Astro island example",
    },
  ];
}
