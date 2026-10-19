import type { Tagged, KebabCase, ConditionalOmitDeep } from "type-fest";

import { kebabCase } from "es-toolkit/string";
import * as z from "zod";

export type PKey<T extends string | number> = Tagged<string | number, T>;
export type CreationPayload<T> = ConditionalOmitDeep<T, "id", { condition: "equality" }>;

export const KebabCaseSchema = z.string().refine((val) => val === kebabCase(val), {
  message: "String must be in kebab-case",
});

export const ExperimentNameSchema = z.string().brand<"ExperimentName">();
export type ExperimentName = z.infer<typeof ExperimentNameSchema>;
export type ExperimentSlug = KebabCase<ExperimentName>;

export const EXPERIMENT_TYPES = ["flag", "simple", "multivariate", "dynamic"] as const;
export const ExperimentTypeSchema = z.enum(EXPERIMENT_TYPES);
export type ExperimentType = z.infer<typeof ExperimentTypeSchema>;

export const CohortNameSchema = z
  .union([KebabCaseSchema, z.literal("on"), z.literal("off")])
  .brand<"CohortName">();
export type CohortName = z.infer<typeof CohortNameSchema>;
export type CohortSlug = `${ExperimentSlug}_${CohortName}`;
export const COHORT_TYPES = ["control", "treatment"] as const;
export const CohortTypeSchema = z.enum(COHORT_TYPES);
export type CohortType = z.infer<typeof CohortTypeSchema>;
