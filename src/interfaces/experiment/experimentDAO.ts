import type { ExperimentDefinition, RolloutChange } from "~/entities/rollout";
import type { DirectoryQuery, DirectoryPage } from "~/interfaces/management";

import { Experiment, type ExperimentSlug, type PKey } from "~/entities";

export default interface IExperimentDAO {
  getById(id: PKey<"Experiment">): Promise<Experiment>;
  findBySlug(slug: ExperimentSlug): Promise<Experiment | null>;
  create(experiment: ExperimentDefinition): Promise<Experiment>;
  commitRollout(change: RolloutChange): Promise<void>;
  setEnabled(slug: ExperimentSlug, enabled: boolean): Promise<void>;
  list(): Promise<Experiment[]>;
  listPage(options: DirectoryQuery): Promise<DirectoryPage>;
  countMemberships(experiment: Experiment): Promise<Record<string, number>>;
  update(
    id: PKey<"Experiment">,
    updates: Partial<Pick<Experiment, "name" | "description" | "winner">>,
    winnerCohortId?: PKey<"Cohort">,
  ): Promise<void>;
  remove(id: PKey<"Experiment">): Promise<void>;
}
