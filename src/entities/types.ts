import type { Tagged, KebabCase } from "type-fest";

import { kebabCase } from "es-toolkit/string";
import * as z from "zod";

export type PKey<T extends string | number> = Tagged<string | number, T>;
// Only strip fields owned by persistence, never keys inside arbitrary JSON values.
export type CreationPayload<T> = T extends { cohorts: (infer C)[] }
  ? Omit<T, "id" | "winner" | "cohorts"> & { cohorts: CreationPayload<C>[] }
  : Omit<T, "id">;

const KebabCaseSchema = z.string().refine((val) => val === kebabCase(val), {
  message: "String must be in kebab-case",
});

export const ExperimentNameSchema = z.string().brand<"ExperimentName">();
export type ExperimentName = z.infer<typeof ExperimentNameSchema>;
export type ExperimentSlug = KebabCase<ExperimentName>;

const EXPERIMENT_TYPES = ["flag", "simple", "multivariate", "dynamic"] as const;
export const ExperimentTypeSchema = z.enum(EXPERIMENT_TYPES);
export type ExperimentType = z.infer<typeof ExperimentTypeSchema>;

export const CohortNameSchema = z
  .union([KebabCaseSchema, z.literal("on"), z.literal("off")])
  .brand<"CohortName">();
type CohortName = z.infer<typeof CohortNameSchema>;
export type CohortSlug = `${ExperimentSlug}_${CohortName}`;
const COHORT_TYPES = ["control", "treatment"] as const;
export const CohortTypeSchema = z.enum(COHORT_TYPES);
export type CohortType = z.infer<typeof CohortTypeSchema>;
