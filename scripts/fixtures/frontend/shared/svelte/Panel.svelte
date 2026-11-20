<script lang="ts">
  import { Cohort, Experiment, XPProvider } from "@frostme/xp/svelte";
  import State from "./State.svelte";
  import Impossible from "./Impossible.svelte";
  let { slug }: { slug?: string } = $props();
  let active = $state("absent");
  let signalSeen = $state(false);
  const custom = async (name: string, {signal}: { signal: AbortSignal }) => {
    signalSeen = signal instanceof AbortSignal;
    return name + "_on";
  };
</script>

{#if slug}
  <section data-experiment={slug}>
    <State {slug} />
    <Experiment {slug}>
      {#each ["short", "control", "detailed"] as local}
        <Cohort slug={local}><output data-xp-branch>{local}</output></Cohort>
      {/each}
      <Cohort default><output data-xp-branch>default</output></Cohort>
    </Experiment>
  </section>
{:else}
  {#each ["assigned", "empty", "failed", active] as name}
    <section data-experiment={name}>
      <State slug={name}/>
      <Experiment slug={name}>
        {#snippet loading()}<i>pending</i>{/snippet}
        <Cohort slug="on"><b>treatment</b></Cohort>
        <Cohort slug="on"><b>again</b></Cohort>
        <Cohort default><b>fallback</b></Cohort>
        <Cohort slug="never"><Impossible /></Cohort>
      </Experiment>
    </section>
  {/each}
  <Cohort slug="assigned_on"><em>standalone</em></Cohort>
  <button onclick={() => active = active === "absent" ? "unlisted" : "absent"}>Change experiment</button>
  <XPProvider loader={custom}>
    <section data-custom><State slug="local" />{signalSeen}</section>
  </XPProvider>
{/if}
