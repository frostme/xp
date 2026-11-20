import {
  createXpSession,
  type CohortResult,
  type XpSession,
  type XpSessionOptions,
} from "@frostme/xp/client";
import {
  createContext,
  createMemo,
  createSignal,
  onCleanup,
  Show,
  untrack,
  useContext,
  type Accessor,
  type ParentProps,
} from "solid-js";

import { matchesGate, parseGate } from "../gates.js";
import { provider, watchMounted } from "./lifecycle.js";

const sessionContext = createContext<Accessor<XpSession> | null>(null);
const experimentContext = createContext<Accessor<string | undefined>>(() => undefined);
const Session = provider(sessionContext);
const Scope = provider(experimentContext);

export type XPProviderProps = ParentProps<XpSessionOptions & { sessionKey?: string | number }>;
export type ExperimentProps = ParentProps<{ slug: string; loading?: ParentProps["children"] }>;
export type CohortProps = ParentProps<
  { default: true; slug?: never } | { default?: false; slug: string }
>;

export function XPProvider(props: XPProviderProps): ParentProps["children"] {
  let current: XpSession | undefined;
  const session = createMemo(() => {
    // All four reactive inputs define the account/transport scope. Preload is used once.
    void props.sessionKey;
    const { loader, endpoint, experimentHost } = props;
    const preload = current
      ? {}
      : untrack(() => ({
          initialAssignments: props.initialAssignments,
          initialErrors: props.initialErrors,
        }));
    current?.dispose();
    current = createXpSession({ loader, endpoint, experimentHost, ...preload });
    return current;
  });
  onCleanup(() => current?.dispose());
  return (
    <Session value={session}>
      <Scope value={() => undefined}>{props.children}</Scope>
    </Session>
  );
}

export function createCohort(slug?: string | Accessor<string>): Accessor<CohortResult> {
  const session = useContext(sessionContext);
  if (!session) throw new Error("createCohort requires an XPProvider");
  const enclosing = useContext(experimentContext);
  const target = createMemo(() => {
    const experiment = typeof slug === "function" ? slug() : (slug ?? enclosing());
    if (experiment === undefined)
      throw new Error("Provide an experiment slug or an enclosing Experiment");
    const store = session();
    store.getSnapshot(experiment);
    return { store, experiment };
  });
  const [revision, invalidate] = createSignal(0);
  watchMounted(target, ({ store, experiment }) => {
    const changed = () => invalidate((n) => n + 1);
    const unsubscribe = store.subscribe(experiment, changed);
    changed();
    return unsubscribe;
  });
  return createMemo(() => {
    revision();
    const { store, experiment } = target();
    return { ...store.getSnapshot(experiment), refresh: () => store.refresh(experiment) };
  });
}

export function Experiment(props: ExperimentProps): ParentProps["children"] {
  const slug = () => props.slug;
  const result = createCohort(slug);
  return (
    <Scope value={slug}>
      <Show when={result().status === "loading"}>{props.loading}</Show>
      {props.children}
    </Scope>
  );
}

export function Cohort(props: CohortProps): ParentProps["children"] {
  const enclosing = useContext(experimentContext);
  const gate = createMemo(() => parseGate(enclosing(), props.slug, props.default));
  const result = createCohort(() => gate().experiment);
  return <Show when={matchesGate(gate(), result())}>{props.children}</Show>;
}
