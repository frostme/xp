import {
  createContext,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { isSlugPart } from "~/entities/slug";

import type { XpPreload } from "../preload";

import { parseGate, matchesGate } from "../gates";
import {
  createXpSession,
  type XpSession,
  type XpSessionOptions,
  type CohortResult,
} from "../session";

const SessionContext = createContext<XpSession | null>(null);
const ExperimentContext = createContext<string | undefined>(undefined);

export interface XPProviderProps extends XpSessionOptions {
  children?: ReactNode;
  sessionKey?: string | number;
}

export function XPProvider({
  children,
  sessionKey,
  initialAssignments,
  initialErrors,
  ...options
}: XPProviderProps) {
  const { loader = "rest", endpoint, experimentHost } = options;
  function startSession(preload?: Partial<XpPreload>) {
    return {
      loader,
      endpoint,
      experimentHost,
      sessionKey,
      assignments: createXpSession({ ...options, ...preload }),
    };
  }
  const [session, setSession] = useState(() =>
    startSession({
      ...(initialAssignments === undefined ? {} : { initialAssignments }),
      ...(initialErrors === undefined ? {} : { initialErrors }),
    }),
  );
  let active = session;
  if (
    session.sessionKey !== sessionKey ||
    session.loader !== loader ||
    session.endpoint !== endpoint ||
    session.experimentHost !== experimentHost
  ) {
    // The SSR preload belongs to its original session. Select an empty store before
    // rendering descendants so an account switch cannot briefly show the previous branch.
    active = startSession();
    setSession(active);
  }

  return (
    <SessionContext.Provider value={active.assignments}>
      <ExperimentContext.Provider value={undefined}>{children}</ExperimentContext.Provider>
    </SessionContext.Provider>
  );
}

export function useCohort(slug?: string): CohortResult {
  const assignments = useContext(SessionContext);
  const enclosingSlug = useContext(ExperimentContext);
  if (!assignments) throw new Error("useCohort requires an XPProvider");
  const experiment = slug ?? enclosingSlug;
  if (!isSlugPart(experiment))
    throw new Error("Provide a kebab-case experiment slug or an enclosing Experiment");
  const entry = useMemo(
    () => ({
      subscribe: (notify: () => void) => assignments.subscribe(experiment, notify),
      snapshot: () => assignments.getSnapshot(experiment),
      serverSnapshot: () => assignments.getServerSnapshot(experiment),
      refresh: () => assignments.refresh(experiment),
    }),
    [assignments, experiment],
  );
  const result = useSyncExternalStore(entry.subscribe, entry.snapshot, entry.serverSnapshot);
  return { ...result, refresh: entry.refresh };
}

export interface ExperimentProps {
  slug: string;
  children?: ReactNode;
  loading?: ReactNode;
}

export function Experiment({ slug, children, loading }: ExperimentProps) {
  const result = useCohort(slug);
  return (
    <ExperimentContext.Provider value={slug}>
      {result.status === "loading" ? loading : null}
      {children}
    </ExperimentContext.Provider>
  );
}

export type CohortProps = { children?: ReactNode } & (
  | { default: true; slug?: never }
  | { default?: false; slug: string }
);

export function Cohort(props: CohortProps) {
  const enclosingSlug = useContext(ExperimentContext);
  const gate = parseGate(enclosingSlug, props.slug, props.default);
  const result = useCohort(gate.experiment);
  return matchesGate(gate, result) ? props.children : null;
}
