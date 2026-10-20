import { Cohort, type CohortSlug, type PKey, type CreationPayload } from "~/entities";

export default interface ICohortDAO {
  getById(id: PKey<"Cohort">): Promise<Cohort & { experiment_id: PKey<"Experiment"> }>;
  findBySlug(slug: CohortSlug): Promise<Cohort | null>;
  getByExperimentId(experimentId: PKey<"Experiment">): Promise<Cohort[]>;
  update(
    id: PKey<"Cohort">,
    updates: Partial<Pick<Cohort, "description" | "percentage">>,
  ): Promise<void>;
  create(cohort: CreationPayload<Cohort> & { experiment_id: PKey<"Experiment"> }): Promise<Cohort>;
  remove(id: PKey<"Cohort">): Promise<void>;
}
