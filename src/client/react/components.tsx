import { createContext, useContext, useState, useSyncExternalStore, type ReactNode } from "react";

import { isSlugPart } from "~/entities/slug";

import { createGraphQLLoader } from "../loaders/graphql";
import { createRestLoader } from "../loaders/rest";
import {
  Assignments,
  type AssignmentLoader,
  type CohortResult,
  type InitialAssignments,
} from "./assignments";

const SessionContext = createContext<Assignments | null>(null);
const ExperimentContext = createContext<string | undefined>(undefined);

export interface XPProviderProps {
  children?: ReactNode;
  loader?: "rest" | "graphql" | AssignmentLoader;
  experimentHost?: string;
  endpoint?: string;
  sessionKey?: string | number;
  initialAssignments?: InitialAssignments;
}

export function XPProvider({
  children,
  loader = "rest",
  endpoint,
  experimentHost,
  sessionKey,
  initialAssignments,
}: XPProviderProps) {
  function startSession(preload?: InitialAssignments) {
    const options = {
      ...(endpoint === undefined ? {} : { endpoint }),
      ...(experimentHost === undefined ? {} : { experimentHost }),
    };
    const resolve =
      typeof loader === "function"
        ? loader
        : loader === "graphql"
          ? createGraphQLLoader(options)
          : createRestLoader(options);
    return {
      loader,
      endpoint,
      experimentHost,
      sessionKey,
      assignments: new Assignments(resolve, preload),
    };
  }
  const [session, setSession] = useState(() => startSession(initialAssignments));
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
  const entry = assignments.entry(experiment);
  const result = useSyncExternalStore(entry.subscribe, entry.getSnapshot, entry.getServerSnapshot);
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
  let experiment = enclosingSlug;
  let qualified: string | undefined;
  if (props.default) {
    if (!enclosingSlug || props.slug !== undefined)
      throw new Error("A default Cohort requires an enclosing Experiment and no slug");
  } else {
    const parts = props.slug.split("_");
    if (parts.length === 2) {
      const [prefix, local] = parts;
      if (!isSlugPart(prefix) || !isSlugPart(local))
        throw new Error("Invalid qualified cohort slug");
      if (enclosingSlug && enclosingSlug !== prefix)
        throw new Error("Cohort slug conflicts with its enclosing Experiment");
      experiment = prefix;
      qualified = props.slug;
    } else {
      if (!enclosingSlug || !isSlugPart(props.slug))
        throw new Error("A local cohort slug requires an enclosing Experiment");
      qualified = `${enclosingSlug}_${props.slug}`;
    }
  }
  const result = useCohort(experiment);
  const matches = props.default
    ? result.status === "error" || (result.status === "ready" && result.slug === null)
    : result.status === "ready" && result.slug === qualified;
  return matches ? props.children : null;
}
