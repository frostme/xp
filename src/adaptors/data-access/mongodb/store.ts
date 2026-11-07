import type { ClientSession, MongoClient } from "mongodb";

import type { Cohort, Experiment, PKey, User, UserCohort } from "~/entities";

export type ExperimentDocument = Omit<Experiment, "cohorts"> & { version: number };
export type CohortDocument = Cohort & { experiment_id: PKey<"Experiment"> };

/** Coordinates mutations through an experiment write, preventing transaction write skew. */
export default class MongoStore {
  readonly experiments;
  readonly cohorts;
  readonly users;
  readonly memberships;

  constructor(
    private readonly client: MongoClient,
    databaseName: string,
  ) {
    if (!databaseName.trim()) {
      throw new Error("MongoDB requires a non-empty databaseName.");
    }
    const db = client.db(databaseName);
    this.experiments = db.collection<ExperimentDocument>("experiments");
    this.cohorts = db.collection<CohortDocument>("cohorts");
    this.users = db.collection<User>("users");
    this.memberships = db.collection<UserCohort>("user_cohorts");
  }

  async transaction<T>(operation: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = this.client.startSession();
    try {
      return await session.withTransaction(() => operation(session), {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        readPreference: "primary",
      });
    } finally {
      await session.endSession();
    }
  }

  async lockExperiment(id: PKey<"Experiment">, session: ClientSession) {
    return this.experiments.findOneAndUpdate(
      { id },
      { $inc: { version: 1 } },
      { session, returnDocument: "after" },
    );
  }

  async experiment(record: ExperimentDocument): Promise<Experiment> {
    const cohorts = await this.cohorts
      .find({ experiment_id: record.id }, { readPreference: "primary" })
      .toArray();
    return {
      id: record.id,
      name: record.name,
      slug: record.slug,
      type: record.type,
      description: record.description,
      winner: record.winner,
      cohorts: cohorts.map(mapCohort),
    };
  }
}

export function mapCohort(record: CohortDocument): CohortDocument {
  return {
    id: record.id,
    experiment_id: record.experiment_id,
    slug: record.slug,
    description: record.description,
    percentage: record.percentage,
    value: record.value ?? null,
    type: record.type,
  };
}

export function mapMembership(record: UserCohort): UserCohort {
  return {
    id: record.id,
    user_id: record.user_id,
    experiment_id: record.experiment_id,
    cohort_id: record.cohort_id,
  };
}

export function isDuplicateKey(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === 11000;
}
