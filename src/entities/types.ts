import type { Tagged, KebabCase, ConditionalOmitDeep } from "type-fest";

export type PKey<T extends string> = Tagged<string, T>;
export type CreationPayload<T> = ConditionalOmitDeep<T, "id", { condition: "equality" }>;

export type ExperimentName = Tagged<string, "ExperimentName">;
export type ExperimentSlug = KebabCase<ExperimentName>;

export const EXPERIMENT_TYPES = ["flag", "simple", "multivariate", "dynamic"] as const;
export type ExperimentType = (typeof EXPERIMENT_TYPES)[number];

export type CohortName = Tagged<"on" | "off" | string, "CohortName">;
export type CohortSlug = `${ExperimentSlug}_${CohortName}`;
export type CohortType = "control" | "treatment";
