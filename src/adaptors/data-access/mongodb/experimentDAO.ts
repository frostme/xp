import { randomUUID } from "node:crypto";

import type { Experiment, ExperimentSlug, PKey, CreationPayload } from "~/entities";
import type { IExperimentDAO } from "~/interfaces";

import { NotFoundError } from "~/errors";

import MongoStore, { type CohortDocument, type ExperimentDocument, mapCohort } from "./store";

export default class MongoExperimentDAO implements IExperimentDAO {
  constructor(private readonly store: MongoStore) {}

  async getById(id: PKey<"Experiment">): Promise<Experiment> {
    const record = await this.store.experiments.findOne({ id }, { readPreference: "primary" });
    if (!record) throw new NotFoundError(`Experiment with id ${id} not found`);
    return this.store.experiment(record);
  }

  async findBySlug(slug: ExperimentSlug): Promise<Experiment | null> {
    const record = await this.store.experiments.findOne({ slug }, { readPreference: "primary" });
    return record ? this.store.experiment(record) : null;
  }

  async list(): Promise<Experiment[]> {
    const records = await this.store.experiments.find({}, { readPreference: "primary" }).toArray();
    return Promise.all(records.map((record) => this.store.experiment(record)));
  }

  async create(input: CreationPayload<Experiment>): Promise<Experiment> {
    const record: ExperimentDocument = {
      id: randomUUID() as PKey<"Experiment">,
      name: input.name,
      slug: input.slug,
      type: input.type,
      description: input.description,
      winner: null,
      version: 0,
    };
    const cohorts: CohortDocument[] = input.cohorts.map((cohort) => ({
      id: randomUUID() as PKey<"Cohort">,
      experiment_id: record.id,
      slug: cohort.slug,
      description: cohort.description,
      percentage: cohort.percentage,
      value: cohort.value ?? null,
      type: cohort.type,
    }));
    await this.store.transaction(async (session) => {
      await this.store.experiments.insertOne({ ...record }, { session });
      if (cohorts.length > 0) {
        await this.store.cohorts.insertMany(
          cohorts.map((cohort) => ({ ...cohort })),
          { session },
        );
      }
    });
    return {
      id: record.id,
      name: record.name,
      slug: record.slug,
      type: record.type,
      description: record.description,
      winner: null,
      cohorts: cohorts.map(mapCohort),
    };
  }

  async update(
    id: PKey<"Experiment">,
    updates: Partial<Pick<Experiment, "name" | "description" | "winner">>,
    winnerCohortId?: PKey<"Cohort">,
  ): Promise<void> {
    const fields: Partial<Pick<Experiment, "name" | "description" | "winner">> = {};
    if (updates.name !== undefined) fields.name = updates.name;
    if (updates.description !== undefined) fields.description = updates.description;
    if (updates.winner !== undefined) fields.winner = updates.winner;
    if (Object.keys(fields).length === 0) return;

    await this.store.transaction(async (session) => {
      if (!(await this.store.lockExperiment(id, session))) return;
      if (fields.winner !== undefined && fields.winner !== null) {
        const cohort = await this.store.cohorts.findOne(
          {
            slug: fields.winner,
            experiment_id: id,
            ...(winnerCohortId === undefined ? {} : { id: winnerCohortId }),
          },
          { session },
        );
        if (!cohort) throw new NotFoundError("Winning cohort does not belong to the experiment");
      }
      await this.store.experiments.updateOne({ id }, { $set: fields }, { session });
    });
  }

  async remove(id: PKey<"Experiment">): Promise<void> {
    await this.store.transaction(async (session) => {
      if (!(await this.store.lockExperiment(id, session))) return;
      await this.store.memberships.deleteMany({ experiment_id: id }, { session });
      await this.store.cohorts.deleteMany({ experiment_id: id }, { session });
      await this.store.experiments.deleteOne({ id }, { session });
    });
  }
}
