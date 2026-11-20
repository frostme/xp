import type { ExperimentName, ExperimentSlug, ExperimentType, CohortSlug } from "./types";

import Cohort from "./cohort";
import Entity from "./entity";

export default class Experiment extends Entity<Experiment, "Experiment"> {
  name!: ExperimentName;
  slug!: ExperimentSlug;
  type!: ExperimentType;
  description!: string;
  enabled!: boolean;
  winner!: CohortSlug | null;
  cohorts!: Cohort[];
}
