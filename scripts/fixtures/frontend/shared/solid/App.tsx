import type { AssignmentLoader, XpPreload } from "@frostme/xp/client";

import { createSignal, For, Show } from "solid-js";

import { Cohort, Experiment, createCohort } from "../../src/adapter";
import { AppXp } from "../../src/xp/provider";

export type Bootstrap = XpPreload & { sessionKey: string; journeySlug?: string };

export function Status(props: { slug: string }) {
  const result = createCohort(() => props.slug);
  return (
    <section data-case={props.slug}>
      <b data-xp-status>{result().status}</b>
      <b data-xp-slug>{result().slug ?? ""}</b>
      <b data-xp-error>{String(result().status === "error")}</b>
      <button onClick={() => void result().refresh()}>Retry</button>
      <Experiment slug={props.slug} loading={<i data-loading>pending</i>}>
        <span data-xp-branch>
          <For each={["on", "control", "detailed", "short"]}>
            {(name) => <Cohort slug={name}>{name}</Cohort>}
          </For>
          <Cohort default>default</Cohort>
        </span>
      </Experiment>
    </section>
  );
}

function Controls() {
  const [open, setOpen] = createSignal(false);
  const [transport, changeTransport] = createSignal<"custom" | "rest" | "graphql">("custom");
  let complete: ((decision: string | null) => void) | undefined;
  const loader: AssignmentLoader = (slug, { signal }) => {
    document.documentElement.dataset["requestSlug"] = slug;
    signal.addEventListener("abort", () => {
      document.documentElement.dataset["aborted"] = "yes";
    });
    return new Promise((resolve) => {
      complete = resolve;
    });
  };
  const [gate, switchGate] = createSignal("unmatched");
  const LazyChild = () => {
    throw new Error("Unmatched branch instantiated");
  };
  return (
    <>
      <button data-controls onClick={() => setOpen(true)}>
        Open controls
      </button>
      <Show when={open()}>
        <AppXp
          loader={transport() === "custom" ? loader : (transport() as "rest" | "graphql")}
          endpoint={transport() === "graphql" ? "/graphql" : "/xp"}
        >
          <Status slug="native-test" />
          <Experiment slug="native-test">
            <Cohort slug={gate()}>
              <LazyChild />
            </Cohort>
            <Cohort slug="on">
              <em data-duplicate>one</em>
            </Cohort>
            <Cohort slug="on">
              <em data-duplicate>two</em>
            </Cohort>
          </Experiment>
        </AppXp>
        <button data-rest onClick={() => changeTransport("rest")}>
          Use REST
        </button>
        <button data-graphql onClick={() => changeTransport("graphql")}>
          Use GraphQL
        </button>
        <button
          data-obsolete
          onClick={() => {
            complete?.(null);
            switchGate("unmatched-too");
          }}
        >
          Resolve obsolete loader
        </button>
      </Show>
    </>
  );
}

export function Results() {
  const [slug, changeSlug] = createSignal("missing-preload");
  return (
    <>
      <Status slug="checkout-banner" />
      <Status slug="explicit-null" />
      <Status slug="initial-error" />
      <Status slug={slug()} />
      <Cohort slug="checkout-banner_on">
        <p data-standalone>qualified</p>
      </Cohort>
      <Controls />
      <button data-retarget onClick={() => changeSlug("explicit-null")}>
        Retarget
      </button>
    </>
  );
}

export function App(props: { bootstrap: Bootstrap }) {
  const [revision, changeRevision] = createSignal(0);
  return (
    <AppXp {...props.bootstrap} sessionKey={props.bootstrap.sessionKey + revision()}>
      <Show when={props.bootstrap.journeySlug} fallback={<Results />}>
        {(slug) => <Status slug={slug()} />}
      </Show>
      <button data-xp-switch onClick={() => changeRevision((n) => n + 1)}>
        Switch account
      </button>
    </AppXp>
  );
}
