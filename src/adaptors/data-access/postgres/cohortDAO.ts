import type { Client } from "pg";

import type { ICohortDAO } from "~/interfaces";

import { Cohort, type CohortSlug, type PKey, type CreationPayload } from "~/entities";

export default class PostgresCohortDAO implements ICohortDAO {
  constructor(protected client: Client) {}

  async getById(id: PKey<"Cohort">): Promise<Cohort & { experiment_id: PKey<"Experiment"> }> {
    const res = await this.client.query("SELECT * FROM cohorts WHERE id = $1", [id]);
    if (res.rows.length === 0) {
      throw new Error(`Cohort with id ${id} not found`);
    }
    return res.rows[0] as Cohort & { experiment_id: PKey<"Experiment"> };
  }

  async findBySlug(slug: CohortSlug): Promise<Cohort | null> {
    const res = await this.client.query("SELECT * FROM cohorts WHERE slug = $1", [slug]);
    if (res.rows.length === 0) {
      return null;
    }
    return res.rows[0] as Cohort;
  }

  async getByExperimentId(experimentId: PKey<"Experiment">): Promise<Cohort[]> {
    const res = await this.client.query("SELECT * FROM cohorts WHERE experiment_id = $1", [
      experimentId,
    ]);
    return res.rows as Cohort[];
  }

  async update(
    id: PKey<"Cohort">,
    updates: Partial<Pick<Cohort, "description" | "percentage">>,
  ): Promise<void> {
    const fields = Object.keys(updates);
    const values = Object.values(updates);
    const setString = fields.map((field, index) => `${field} = $${index + 1}`).join(", ");
    await this.client.query(`UPDATE cohorts SET ${setString} WHERE id = $${fields.length + 1}`, [
      ...values,
      id,
    ]);
  }

  async create(
    cohort: CreationPayload<Cohort> & { experiment_id: PKey<"Experiment"> },
  ): Promise<Cohort> {
    const res = await this.client.query(
      "INSERT INTO cohorts (experiment_id, type, slug, description, percentage, value) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
      [
        cohort.experiment_id,
        cohort.type,
        cohort.slug,
        cohort.description,
        cohort.percentage,
        cohort.value ?? null,
      ],
    );
    return res.rows[0] as Cohort;
  }

  async remove(id: PKey<"Cohort">): Promise<void> {
    await this.client.query("DELETE FROM cohorts WHERE id = $1", [id]);
  }
}
