import { Experiment, type ExperimentSlug, type PKey, type CreationPayload } from "~/entities";

export default interface IExperimentDAO {
  getById(id: PKey<"Experiment">): Promise<Experiment>;
  findBySlug(slug: ExperimentSlug): Promise<Experiment | null>;
  create(experiment: CreationPayload<Experiment>): Promise<Experiment>;
  list(): Promise<Experiment[]>;
  update(
    id: PKey<"Experiment">,
    updates: Partial<Pick<Experiment, "name" | "description" | "winner">>,
  ): Promise<void>;
  remove(id: PKey<"Experiment">): Promise<void>;
}
