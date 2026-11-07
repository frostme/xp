import type { Cohort, Experiment, User, UserCohort, PKey } from "~/entities";
import type { IDataAccessAdaptor } from "~/interfaces";

import { DuplicateAssignmentError, NotFoundError } from "~/errors";

export type Row = Record<string, unknown>;
export interface SqlSession {
  query(sql: string, values?: unknown[]): Promise<Row[]>;
  insert(table: string, fields: Row): Promise<Row>;
  lock(table: string, where: string, values: unknown[]): Promise<Row[]>;
  parameter(index: number): string;
}
export interface SqlDatabase {
  read<T>(work: (session: SqlSession) => Promise<T>): Promise<T>;
  transaction<T>(work: (session: SqlSession) => Promise<T>): Promise<T>;
}
function required(rows: Row[], entity: string): Row {
  const row = rows[0];
  if (!row) throw new NotFoundError(`${entity} not found`);
  return row;
}
function cohort(row: Row): Cohort & { experiment_id: PKey<"Experiment"> } {
  return {
    id: row["id"],
    experiment_id: row["experiment_id"],
    slug: row["slug"],
    description: row["description"],
    percentage: Number(row["percentage"]),
    type: row["type"],
    // Drivers normalize JSON to text so JSON strings and SQL text cannot be confused.
    value: row["value"] == null ? null : JSON.parse(String(row["value"])),
  } as Cohort & { experiment_id: PKey<"Experiment"> };
}
function membership(row: Row): UserCohort {
  return {
    id: row["id"],
    user_id: row["user_id"],
    experiment_id: row["experiment_id"],
    cohort_id: row["cohort_id"],
  } as UserCohort;
}
async function hydrate(s: SqlSession, row: Row): Promise<Experiment> {
  const rows = await s.query(`SELECT * FROM cohorts WHERE experiment_id = ${s.parameter(1)}`, [
    row["id"],
  ]);
  return {
    id: row["id"],
    name: row["name"],
    slug: row["slug"],
    description: row["description"],
    type: row["type"],
    winner: row["winner"] ?? null,
    cohorts: rows.map(cohort),
  } as Experiment;
}
async function update(s: SqlSession, table: string, id: unknown, values: Row): Promise<void> {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  if (!entries.length) return;
  await s.query(
    `UPDATE ${table} SET ${entries.map(([key], i) => `${key} = ${s.parameter(i + 1)}`).join(", ")} WHERE id = ${s.parameter(entries.length + 1)}`,
    [...entries.map(([, value]) => value), id],
  );
}
async function lockExperiment(s: SqlSession, id: unknown): Promise<Row> {
  return required(await s.lock("experiments", `id = ${s.parameter(1)}`, [id]), "Experiment");
}

// All mutations lock the experiment first, including membership and winner changes.
export function relationalAdaptor(database: SqlDatabase): IDataAccessAdaptor {
  return {
    experimentDAO: {
      getById: (id) =>
        database.read(async (s) =>
          hydrate(
            s,
            required(
              await s.query(`SELECT * FROM experiments WHERE id = ${s.parameter(1)}`, [id]),
              "Experiment",
            ),
          ),
        ),
      findBySlug: (slug) =>
        database.read(async (s) => {
          const rows = await s.query(`SELECT * FROM experiments WHERE slug = ${s.parameter(1)}`, [
            slug,
          ]);
          return rows[0] ? hydrate(s, rows[0]) : null;
        }),
      list: () =>
        database.read(async (s) => {
          const result: Experiment[] = [];
          for (const row of await s.query("SELECT * FROM experiments"))
            result.push(await hydrate(s, row));
          return result;
        }),
      create: (input) =>
        database.transaction(async (s) => {
          const row = await s.insert("experiments", {
            name: input.name,
            slug: input.slug,
            type: input.type,
            description: input.description,
            winner: null,
          });
          for (const item of input.cohorts) {
            await s.insert("cohorts", {
              experiment_id: row["id"],
              slug: item.slug,
              type: item.type,
              description: item.description,
              percentage: item.percentage,
              value: JSON.stringify(item.value ?? null),
            });
          }
          return hydrate(s, row);
        }),
      update: (id, values, winnerCohortId) =>
        database.transaction(async (s) => {
          const rows = await s.lock("experiments", `id = ${s.parameter(1)}`, [id]);
          if (!rows.length) return;
          if (values.winner != null) {
            required(
              await s.query(
                `SELECT * FROM cohorts WHERE experiment_id = ${s.parameter(1)} AND slug = ${s.parameter(2)}${winnerCohortId === undefined ? "" : ` AND id = ${s.parameter(3)}`}`,
                winnerCohortId === undefined
                  ? [id, values.winner]
                  : [id, values.winner, winnerCohortId],
              ),
              "Winning cohort",
            );
          }
          await update(s, "experiments", id, {
            name: values.name,
            description: values.description,
            winner: values.winner,
          });
        }),
      remove: (id) =>
        database.transaction(async (s) => {
          if (!(await s.lock("experiments", `id = ${s.parameter(1)}`, [id])).length) return;
          await s.query(`DELETE FROM user_cohorts WHERE experiment_id = ${s.parameter(1)}`, [id]);
          await s.query(`DELETE FROM cohorts WHERE experiment_id = ${s.parameter(1)}`, [id]);
          await s.query(`DELETE FROM experiments WHERE id = ${s.parameter(1)}`, [id]);
        }),
    },
    cohortDAO: {
      getById: (id) =>
        database.read(async (s) =>
          cohort(
            required(
              await s.query(`SELECT * FROM cohorts WHERE id = ${s.parameter(1)}`, [id]),
              "Cohort",
            ),
          ),
        ),
      findBySlug: (slug) =>
        database.read(async (s) => {
          const rows = await s.query(`SELECT * FROM cohorts WHERE slug = ${s.parameter(1)}`, [
            slug,
          ]);
          return rows[0] ? cohort(rows[0]) : null;
        }),
      getByExperimentId: (id) =>
        database.read(async (s) =>
          (
            await s.query(`SELECT * FROM cohorts WHERE experiment_id = ${s.parameter(1)}`, [id])
          ).map(cohort),
        ),
      create: (input) =>
        database.transaction(async (s) => {
          await lockExperiment(s, input.experiment_id);
          return cohort(
            await s.insert("cohorts", {
              experiment_id: input.experiment_id,
              slug: input.slug,
              type: input.type,
              description: input.description,
              percentage: input.percentage,
              value: JSON.stringify(input.value ?? null),
            }),
          );
        }),
      update: (id, values) =>
        database.transaction(async (s) => {
          const rows = await s.query(`SELECT * FROM cohorts WHERE id = ${s.parameter(1)}`, [id]);
          if (!rows[0]) return;
          if (
            !(await s.lock("experiments", `id = ${s.parameter(1)}`, [rows[0]["experiment_id"]]))
              .length
          )
            return;
          await update(s, "cohorts", id, {
            description: values.description,
            percentage: values.percentage,
          });
        }),
      remove: (id) =>
        database.transaction(async (s) => {
          const rows = await s.query(`SELECT * FROM cohorts WHERE id = ${s.parameter(1)}`, [id]);
          const row = rows[0];
          if (!row) return;
          if (
            !(await s.lock("experiments", `id = ${s.parameter(1)}`, [row["experiment_id"]])).length
          )
            return;
          // The first read can precede another removal and slug reuse. Recheck
          // the original ID under lock before touching the parent's winner.
          if (!(await s.lock("cohorts", `id = ${s.parameter(1)}`, [id])).length) return;
          await s.query(
            `UPDATE experiments SET winner = NULL WHERE id = ${s.parameter(1)} AND winner = ${s.parameter(2)}`,
            [row["experiment_id"], row["slug"]],
          );
          await s.query(`DELETE FROM user_cohorts WHERE cohort_id = ${s.parameter(1)}`, [id]);
          await s.query(`DELETE FROM cohorts WHERE id = ${s.parameter(1)}`, [id]);
        }),
    },
    userDAO: {
      findById: (id) =>
        database.read(
          async (s) =>
            ({
              id: required(
                await s.query(`SELECT * FROM users WHERE id = ${s.parameter(1)}`, [id]),
                "User",
              )["id"],
            }) as User,
        ),
      findUserCohort: (userId, experimentId) =>
        database.read(async (s) => {
          const rows = await s.query(
            `SELECT * FROM user_cohorts WHERE user_id = ${s.parameter(1)} AND experiment_id = ${s.parameter(2)}`,
            [userId, experimentId],
          );
          return rows[0] ? membership(rows[0]) : null;
        }),
      addUserCohort: (userId, experimentId, cohortId) =>
        database.transaction(async (s) => {
          await lockExperiment(s, experimentId);
          required(
            await s.query(`SELECT * FROM users WHERE id = ${s.parameter(1)}`, [userId]),
            "User",
          );
          required(
            await s.query(
              `SELECT * FROM cohorts WHERE id = ${s.parameter(1)} AND experiment_id = ${s.parameter(2)}`,
              [cohortId, experimentId],
            ),
            "Cohort",
          );
          if (
            (
              await s.query(
                `SELECT * FROM user_cohorts WHERE user_id = ${s.parameter(1)} AND experiment_id = ${s.parameter(2)}`,
                [userId, experimentId],
              )
            ).length
          )
            throw new DuplicateAssignmentError();
          return membership(
            await s.insert("user_cohorts", {
              user_id: userId,
              experiment_id: experimentId,
              cohort_id: cohortId,
            }),
          );
        }),
      removeUserCohort: (userId, experimentId) =>
        database.transaction(async (s) => {
          if (!(await s.lock("experiments", `id = ${s.parameter(1)}`, [experimentId])).length)
            return;
          await s.query(
            `DELETE FROM user_cohorts WHERE user_id = ${s.parameter(1)} AND experiment_id = ${s.parameter(2)}`,
            [userId, experimentId],
          );
        }),
    },
  };
}
