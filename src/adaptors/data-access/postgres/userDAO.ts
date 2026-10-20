import type { Client } from "pg";

import type { IUserDAO } from "~/interfaces";

import { User, UserCohort, type PKey } from "~/entities";

export default class PostgresUserDAO implements IUserDAO {
  constructor(protected client: Client) {}

  async findById(id: PKey<"User">): Promise<User> {
    const res = await this.client.query("SELECT * FROM users WHERE id = $1", [id]);
    if (res.rows.length === 0) {
      throw new Error(`User with id ${id} not found`);
    }
    return res.rows[0] as User;
  }

  async findUserCohort(
    userId: PKey<"User">,
    experimentId: PKey<"Experiment">,
  ): Promise<UserCohort | null> {
    const res = await this.client.query(
      "SELECT * FROM user_cohorts WHERE user_id = $1 AND experiment_id = $2",
      [userId, experimentId],
    );

    if (res.rows.length === 0) {
      return null;
    }
    return res.rows[0] as UserCohort;
  }

  async addUserCohort(
    userId: PKey<"User">,
    experimentId: PKey<"Experiment">,
    cohortId: PKey<"Cohort">,
  ): Promise<UserCohort> {
    const res = await this.client.query(
      "INSERT INTO user_cohorts (user_id, experiment_id, cohort_id) VALUES ($1, $2, $3) RETURNING *",
      [userId, experimentId, cohortId],
    );

    return res.rows[0] as UserCohort;
  }

  async removeUserCohort(userId: PKey<"User">, experimentId: PKey<"Experiment">): Promise<void> {
    return void (await this.client.query(
      "DELETE FROM user_cohorts WHERE user_id = $1 AND experiment_id = $2",
      [userId, experimentId],
    ));
  }
}
