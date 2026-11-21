import { createGraphQLLoader, createRestLoader, type CohortLoader } from "@frostme/xp/client";
import { XPProvider, Experiment, Cohort, useCohort, type CohortResult } from "@frostme/xp/react";

export const loaders: Record<"rest" | "graphql", CohortLoader> = {
  rest: createRestLoader(),
  graphql: createGraphQLLoader(),
};

function Decision() {
  const result: CohortResult = useCohort();
  return <span>{result.slug}</span>;
}

export function App() {
  return (
    <XPProvider loader="rest" initialAssignments={{ checkout: "checkout_on" }}>
      <Experiment slug="checkout">
        <Cohort slug="on">
          <Decision />
        </Cohort>
        <Cohort default>Default</Cohort>
      </Experiment>
    </XPProvider>
  );
}
