import { randomUUID } from "node:crypto";

import type { Cohort, CohortSlug, CreationPayload, PKey } from "~/entities";
import type { ICohortDAO } from "~/interfaces";

import { NotFoundError } from "~/errors";

import MongoStore, { type CohortDocument, mapCohort } from "./store";

export default class MongoCohortDAO implements ICohortDAO {
  constructor(private readonly store: MongoStore) {}

  async getById(id: PKey<"Cohort">): Promise<CohortDocument> {
    const record = await this.store.cohorts.findOne({ id }, { readPreference: "primary" });
    if (!record) throw new NotFoundError(`Cohort with id ${id} not found`);
    return mapCohort(record);
  }

  async findBySlug(slug: CohortSlug): Promise<Cohort | null> {
    const record = await this.store.cohorts.findOne({ slug }, { readPreference: "primary" });
    return record ? mapCohort(record) : null;
  }

  async getByExperimentId(experimentId: PKey<"Experiment">): Promise<Cohort[]> {
    const records = await this.store.cohorts
      .find({ experiment_id: experimentId }, { readPreference: "primary" })
      .toArray();
    return records.map(mapCohort);
  }

  async create(
    input: CreationPayload<Cohort> & { experiment_id: PKey<"Experiment"> },
  ): Promise<Cohort> {
    const record: CohortDocument = {
      id: randomUUID() as PKey<"Cohort">,
      experiment_id: input.experiment_id,
      slug: input.slug,
      description: input.description,
      percentage: input.percentage,
      value: input.value ?? null,
      type: input.type,
    };
    await this.store.transaction(async (session) => {
      if (!(await this.store.lockExperiment(input.experiment_id, session))) {
        throw new NotFoundError(`Experiment with id ${input.experiment_id} not found`);
      }
      await this.store.cohorts.insertOne({ ...record }, { session });
    });
    return mapCohort(record);
  }

  async update(
    id: PKey<"Cohort">,
    updates: Partial<Pick<Cohort, "description" | "percentage">>,
  ): Promise<void> {
    const fields: Partial<Pick<Cohort, "description" | "percentage">> = {};
    if (updates.description !== undefined) fields.description = updates.description;
    if (updates.percentage !== undefined) fields.percentage = updates.percentage;
    if (Object.keys(fields).length === 0) return;

    await this.store.transaction(async (session) => {
      const cohort = await this.store.cohorts.findOne({ id }, { session });
      if (!cohort || !(await this.store.lockExperiment(cohort.experiment_id, session))) return;
      await this.store.cohorts.updateOne({ id }, { $set: fields }, { session });
    });
  }

  async remove(id: PKey<"Cohort">): Promise<void> {
    await this.store.transaction(async (session) => {
      const cohort = await this.store.cohorts.findOne({ id }, { session });
      if (!cohort || !(await this.store.lockExperiment(cohort.experiment_id, session))) return;
      await this.store.memberships.deleteMany({ cohort_id: id }, { session });
      await this.store.experiments.updateOne(
        { id: cohort.experiment_id, winner: cohort.slug },
        { $set: { winner: null } },
        { session },
      );
      await this.store.cohorts.deleteOne({ id }, { session });
    });
  }
}
