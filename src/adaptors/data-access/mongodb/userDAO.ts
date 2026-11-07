import { randomUUID } from "node:crypto";

import type { PKey, User, UserCohort } from "~/entities";
import type { IUserDAO } from "~/interfaces";

import { DuplicateAssignmentError, NotFoundError } from "~/errors";

import MongoStore, { isDuplicateKey, mapMembership } from "./store";

export default class MongoUserDAO implements IUserDAO {
  constructor(private readonly store: MongoStore) {}

  async findById(id: PKey<"User">): Promise<User> {
    const record = await this.store.users.findOne({ id }, { readPreference: "primary" });
    if (!record) throw new NotFoundError(`User with id ${id} not found`);
    return { id: record.id };
  }

  async findUserCohort(
    userId: PKey<"User">,
    experimentId: PKey<"Experiment">,
  ): Promise<UserCohort | null> {
    const record = await this.store.memberships.findOne(
      { user_id: userId, experiment_id: experimentId },
      { readPreference: "primary" },
    );
    return record ? mapMembership(record) : null;
  }

  async addUserCohort(
    userId: PKey<"User">,
    experimentId: PKey<"Experiment">,
    cohortId: PKey<"Cohort">,
  ): Promise<UserCohort> {
    const record: UserCohort = {
      id: randomUUID() as PKey<"UserCohort">,
      user_id: userId,
      experiment_id: experimentId,
      cohort_id: cohortId,
    };
    try {
      await this.store.transaction(async (session) => {
        if (!(await this.store.lockExperiment(experimentId, session))) {
          throw new NotFoundError(`Experiment with id ${experimentId} not found`);
        }
        if (!(await this.store.users.findOne({ id: userId }, { session }))) {
          throw new NotFoundError(`User with id ${userId} not found`);
        }
        if (
          !(await this.store.cohorts.findOne(
            { id: cohortId, experiment_id: experimentId },
            { session },
          ))
        ) {
          throw new NotFoundError("Cohort does not belong to the experiment");
        }
        await this.store.memberships.insertOne({ ...record }, { session });
      });
    } catch (error) {
      if (isDuplicateKey(error)) throw new DuplicateAssignmentError({ cause: error });
      throw error;
    }
    return mapMembership(record);
  }

  async removeUserCohort(userId: PKey<"User">, experimentId: PKey<"Experiment">): Promise<void> {
    await this.store.transaction(async (session) => {
      if (!(await this.store.lockExperiment(experimentId, session))) return;
      await this.store.memberships.deleteOne(
        { user_id: userId, experiment_id: experimentId },
        { session },
      );
    });
  }
}
