import type { Client } from "pg";

import type { IExperimentDAO } from "~/interfaces";

import { Experiment, type ExperimentSlug, type PKey, type CreationPayload } from "~/entities";

export default class PostgresExperimentDAO implements IExperimentDAO {
  constructor(protected client: Client) {}

  async getById(id: PKey<"Experiment">): Promise<Experiment> {
    const res = await this.client.query("SELECT * FROM experiments WHERE id = $1", [id]);
    if (res.rows.length === 0) {
      throw new Error(`Experiment with id ${id} not found`);
    }
    return res.rows[0] as Experiment;
  }

  async findBySlug(slug: ExperimentSlug): Promise<Experiment | null> {
    const res = await this.client.query("SELECT * FROM experiments WHERE slug = $1", [slug]);
    if (res.rows.length === 0) {
      return null;
    }
    return res.rows[0] as Experiment;
  }

  async create(experiment: CreationPayload<Experiment>): Promise<Experiment> {
    try {
      await this.client.query("BEGIN");
      const insertExperimentQuery = `INSERT INTO experiments (name, type, slug, description) VALUES ($1, $2, $3, $4) RETURNING *`;
      const res = await this.client.query(insertExperimentQuery, [
        experiment.name,
        experiment.type,
        experiment.slug,
        experiment.description,
      ]);

      const createdExperiment = res.rows[0];

      const insertCohortsQuery = `INSERT INTO cohorts (experiment_id, type, slug, description, percentage, value) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`;
      const cohorts = await Promise.all(
        experiment.cohorts.map(async (cohort) => {
          const cohortRes = await this.client.query(insertCohortsQuery, [
            createdExperiment.id,
            cohort.type,
            cohort.slug,
            cohort.description,
            cohort.type == "control" ? 100 : 0,
            cohort.value ?? null,
          ]);

          return cohortRes.rows[0];
        }),
      );

      const experimentWithCohorts = {
        ...createdExperiment,
        cohorts,
      };

      await this.client.query("COMMIT");
      return experimentWithCohorts as Experiment;
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
  }

  async list(): Promise<Experiment[]> {
    const res = await this.client.query("SELECT * FROM experiments");
    return res.rows as Experiment[];
  }

  async update(
    id: PKey<"Experiment">,
    updates: Partial<Pick<Experiment, "name" | "description" | "winner">>,
  ): Promise<void> {
    const fields = Object.keys(updates);
    const values = Object.values(updates);
    const setString = fields.map((field, index) => `${field} = $${index + 1}`).join(", ");
    await this.client.query(
      `UPDATE experiments SET ${setString} WHERE id = $${fields.length + 1}`,
      [...values, id],
    );
  }

  async remove(id: PKey<"Experiment">): Promise<void> {
    await this.client.query("DELETE FROM experiments WHERE id = $1", [id]);
  }
}
