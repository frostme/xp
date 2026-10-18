import type { ExperimentName, ExperimentSlug, ExperimentType, CohortSlug } from "./types";

import Cohort from "./cohort";
import Entity from "./entity";

export default class Experiment extends Entity<Experiment, "Experiment"> {
  name!: ExperimentName;
  slug!: ExperimentSlug;
  type!: ExperimentType;
  description!: string;
  winner!: CohortSlug | null;
  cohorts!: Cohort[];
}
