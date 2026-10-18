import type { JsonValue } from "type-fest";

import type { CohortSlug, CohortType } from "./types";

import Entity from "./entity";

export default class Cohort extends Entity<Cohort, "Cohort"> {
  slug!: CohortSlug;
  description!: string;
  percentage!: number;
  value!: JsonValue;
  type!: CohortType;
}
