import { randomUUID } from "node:crypto";

import type { Experiment, ExperimentSlug, PKey } from "~/entities";
import type { IExperimentDAO } from "~/interfaces";

import { initialDelivery, type ExperimentDefinition, type RolloutChange } from "~/entities/rollout";
import { ExperimentSlugConflictError, NotFoundError } from "~/errors";
import { RolloutConflictError } from "~/errors/rolloutConflictError";

import MongoStore, {
  type CohortDocument,
  type ExperimentDocument,
  isDuplicateKey,
  mapExperiment,
} from "./store";

export default class MongoExperimentDAO implements IExperimentDAO {
  constructor(private readonly store: MongoStore) {}

  async getById(id: PKey<"Experiment">): Promise<Experiment> {
    const record = await this.store.findExperiment({ id });
    if (!record) throw new NotFoundError(`Experiment with id ${id} not found`);
    return record;
  }

  async findBySlug(slug: ExperimentSlug): Promise<Experiment | null> {
    return this.store.findExperiment({ slug });
  }

  async setEnabled(slug: ExperimentSlug, enabled: boolean): Promise<void> {
    await this.store.transaction(async (session) => {
      const parent = await this.store.experiments.findOne({ slug }, { session });
      if (!parent) throw new NotFoundError(`Experiment with slug ${slug} not found`);
      if ((parent.enabled ?? true) === enabled) return;
      await this.store.experiments.updateOne(
        { id: parent.id },
        { $set: { enabled }, $inc: { version: 1, rollout_revision: 1 } },
        { session },
      );
    });
  }

  async list(): Promise<Experiment[]> {
    return this.store.transaction(async (session) => {
      const records = await this.store.experiments.find({}, { session }).toArray();
      const groups = new Map<Experiment["id"], CohortDocument[]>();
      for await (const cohort of this.store.cohorts.find({}, { session })) {
        const group = groups.get(cohort.experiment_id);
        if (group) group.push(cohort);
        else groups.set(cohort.experiment_id, [cohort]);
      }
      return records.map((record) => mapExperiment(record, groups.get(record.id) ?? []));
    });
  }

  async commitRollout(change: RolloutChange): Promise<void> {
    await this.store.transaction(async (session) => {
      const parent = await this.store.lockExperiment(change.id, session);
      if (!parent) throw new NotFoundError(`Experiment with id ${change.id} not found`);
      if ((parent.rollout_revision ?? 0) !== change.expectedRevision)
        throw new RolloutConflictError();
      if (
        change.winner != null &&
        !(await this.store.cohorts.findOne(
          { experiment_id: change.id, slug: change.winner },
          { session },
        ))
      ) {
        throw new NotFoundError("Winning cohort does not belong to the experiment");
      }
      if (change.weights) {
        const ids = new Set(change.weights.map((weight) => weight.id));
        const count = await this.store.cohorts.countDocuments(
          { experiment_id: change.id },
          { session },
        );
        if (ids.size !== change.weights.length || count !== ids.size)
          throw new RolloutConflictError("The cohorts changed. Refresh the split before saving.");
        if (count > 0) {
          const result = await this.store.cohorts.bulkWrite(
            change.weights.map((weight) => ({
              updateOne: {
                filter: { experiment_id: change.id, id: weight.id },
                update: { $set: { percentage: weight.basisPoints / 100 } },
              },
            })),
            { session },
          );
          if (result.matchedCount !== count)
            throw new RolloutConflictError("The cohorts changed. Refresh the split before saving.");
        }
      }
      await this.store.experiments.updateOne(
        { id: change.id },
        {
          $set: {
            winner: change.winner,
            enabled: change.enabled,
            ...(change.phase === null ? {} : { rollout_phase: change.phase }),
          },
          ...(change.phase === null ? { $unset: { rollout_phase: "" } } : {}),
          $inc: { rollout_revision: 1 },
        },
        { session },
      );
    });
  }

  async create(input: ExperimentDefinition): Promise<Experiment> {
    const record: ExperimentDocument = {
      id: randomUUID() as PKey<"Experiment">,
      name: input.name,
      slug: input.slug,
      type: input.type,
      description: input.description,
      ...initialDelivery(input),
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
      try {
        await this.store.experiments.insertOne({ ...record }, { session });
      } catch (error) {
        const constraint = error as {
          keyPattern?: Record<string, unknown>;
          keyValue?: { slug?: string };
        };
        if (
          isDuplicateKey(error) &&
          constraint.keyValue?.slug === input.slug &&
          Object.keys(constraint.keyPattern ?? {}).join(",") === "slug"
        ) {
          throw new ExperimentSlugConflictError(input.slug, { cause: error });
        }
        throw error;
      }
      if (cohorts.length > 0) {
        await this.store.cohorts.insertMany(
          cohorts.map((cohort) => ({ ...cohort })),
          { session },
        );
      }
    });
    return mapExperiment(record, cohorts);
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
      const parent = await this.store.lockExperiment(id, session, true);
      if (!parent) return;
      if (parent.rollout_phase && fields.winner !== undefined)
        throw new RolloutConflictError("Use a rollout command to change the winner.");
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
