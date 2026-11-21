import type { Cohort, Experiment, User, UserCohort, PKey } from "~/entities";
import type { RolloutChange } from "~/entities/rollout";
import type { IDataAccessAdaptor } from "~/interfaces";

import { initialDelivery, rolloutMetadata } from "~/entities/rollout";
import {
  DuplicateAssignmentError,
  ExperimentPausedError,
  ExperimentSlugConflictError,
  NotFoundError,
} from "~/errors";
import { RolloutConflictError } from "~/errors/rolloutConflictError";

import { isExperimentSlugConflict } from "./experimentSlugConflict";

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
function isEnabled(row: Row): boolean {
  // MySQL returns TINYINT(1) as a number. PostgreSQL and SQL Server return booleans.
  return row["enabled"] !== false && row["enabled"] !== 0;
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
    enabled: isEnabled(row),
    winner: row["winner"] ?? null,
    ...rolloutMetadata(row["rollout_phase"], row["rollout_revision"]),
    cohorts: rows.map(cohort),
  } as Experiment;
}
// Parent and cohorts are separate statements on a pooled read. A changed revision
// invalidates the combined view even when a later assignment would also detect it.
async function readDefinition(s: SqlSession, initial: Row | undefined): Promise<Experiment | null> {
  let parent = initial;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!parent) return null;
    const definition = await hydrate(s, parent);
    if (!Object.hasOwn(parent, "rollout_revision")) return definition;
    const previousRevision = parent["rollout_revision"];
    [parent] = await s.query(`SELECT * FROM experiments WHERE id = ${s.parameter(1)}`, [
      parent["id"],
    ]);
    if (!parent) return null;
    if (parent["rollout_revision"] === previousRevision) return definition;
  }
  throw new RolloutConflictError("The definition changed during the read. Refresh and retry.");
}
function nextRevision(parent: Row): Row {
  return Object.hasOwn(parent, "rollout_revision")
    ? { rollout_revision: Number(parent["rollout_revision"]) + 1 }
    : {};
}
function changed(row: Row, fields: Row): boolean {
  return Object.entries(fields).some(([key, value]) => value !== undefined && value !== row[key]);
}
function requireLegacyCohorts(parent: Row) {
  if (parent["rollout_phase"] != null)
    throw new RolloutConflictError(
      "Managed cohort definitions are fixed. Use a rollout command to change their split.",
    );
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

async function lockCohort(s: SqlSession, id: PKey<"Cohort">) {
  const [hint] = await s.query(`SELECT experiment_id FROM cohorts WHERE id = ${s.parameter(1)}`, [
    id,
  ]);
  if (!hint) return null;
  const [parent] = await s.lock("experiments", `id = ${s.parameter(1)}`, [hint["experiment_id"]]);
  if (!parent) return null;
  // The original lookup may predate a delete and reuse of the same slug.
  const [record] = await s.lock("cohorts", `id = ${s.parameter(1)}`, [id]);
  return record ? { parent, record } : null;
}

async function commitRollout(s: SqlSession, change: RolloutChange): Promise<void> {
  const parent = await lockExperiment(s, change.id);
  if (!Object.hasOwn(parent, "rollout_revision"))
    throw new RolloutConflictError("Apply the xp storage v3 migration before managing a rollout.");
  if (Number(parent["rollout_revision"]) !== change.expectedRevision)
    throw new RolloutConflictError();
  if (change.winner != null) {
    required(
      await s.query(
        `SELECT id FROM cohorts WHERE experiment_id = ${s.parameter(1)} AND slug = ${s.parameter(2)}`,
        [change.id, change.winner],
      ),
      "Winning cohort",
    );
  }
  if (change.weights) {
    const cohorts = await s.query(
      `SELECT id FROM cohorts WHERE experiment_id = ${s.parameter(1)}`,
      [change.id],
    );
    const ids = new Set(cohorts.map((row) => row["id"]));
    if (
      change.weights.length !== ids.size ||
      !change.weights.every((weight) => ids.delete(weight.id))
    )
      throw new RolloutConflictError("The cohorts changed. Refresh the split before saving.");
    for (const weight of change.weights) {
      await update(s, "cohorts", weight.id, { percentage: weight.basisPoints / 100 });
    }
  }
  await update(s, "experiments", change.id, {
    winner: change.winner,
    enabled: change.enabled,
    rollout_phase: change.phase,
    ...nextRevision(parent),
  });
}

// All mutations lock the experiment first, including membership and winner changes.
export function relationalAdaptor(database: SqlDatabase): IDataAccessAdaptor {
  return {
    experimentDAO: {
      getById: (id) =>
        database.read(async (s) => {
          const [row] = await s.query(`SELECT * FROM experiments WHERE id = ${s.parameter(1)}`, [
            id,
          ]);
          const definition = await readDefinition(s, row);
          if (!definition) throw new NotFoundError("Experiment not found");
          return definition;
        }),
      findBySlug: (slug) =>
        database.read(async (s) => {
          const [row] = await s.query(`SELECT * FROM experiments WHERE slug = ${s.parameter(1)}`, [
            slug,
          ]);
          return readDefinition(s, row);
        }),
      commitRollout: (change) => database.transaction((s) => commitRollout(s, change)),
      setEnabled: (slug, enabled) =>
        database.transaction(async (s) => {
          const row = required(
            await s.lock("experiments", `slug = ${s.parameter(1)}`, [slug]),
            "Experiment",
          );
          if (isEnabled(row) !== enabled)
            await update(s, "experiments", row["id"], { enabled, ...nextRevision(row) });
        }),
      list: () =>
        database.read(async (s) => {
          const result: Experiment[] = [];
          for (const row of await s.query("SELECT * FROM experiments")) {
            const definition = await readDefinition(s, row);
            if (definition) result.push(definition);
          }
          return result;
        }),
      create: async (input) => {
        let parentInsertFailure: unknown;
        try {
          return await database.transaction(async (s) => {
            const row = await s
              .insert("experiments", {
                name: input.name,
                slug: input.slug,
                type: input.type,
                description: input.description,
                ...initialDelivery(input),
              })
              .catch((error: unknown) => {
                parentInsertFailure = error;
                throw error;
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
          });
        } catch (error) {
          if (error === parentInsertFailure && (await isExperimentSlugConflict(database, error))) {
            throw new ExperimentSlugConflictError(input.slug, { cause: error });
          }
          throw error;
        }
      },
      update: (id, values, winnerCohortId) =>
        database.transaction(async (s) => {
          const rows = await s.lock("experiments", `id = ${s.parameter(1)}`, [id]);
          const parent = rows[0];
          if (!parent) return;
          if (parent["rollout_phase"] != null && values.winner !== undefined)
            throw new RolloutConflictError("Select a winner through the managed rollout command.");
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
          const fields = {
            name: values.name,
            description: values.description,
            winner: values.winner,
          };
          if (changed(parent, fields))
            await update(s, "experiments", id, { ...fields, ...nextRevision(parent) });
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
          const parent = await lockExperiment(s, input.experiment_id);
          requireLegacyCohorts(parent);
          await update(s, "experiments", input.experiment_id, nextRevision(parent));
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
          const locked = await lockCohort(s, id);
          if (!locked) return;
          if (values.percentage !== undefined) requireLegacyCohorts(locked.parent);
          const fields = { description: values.description, percentage: values.percentage };
          if (!changed(locked.record, fields)) return;
          await update(s, "cohorts", id, fields);
          await update(s, "experiments", locked.parent["id"], nextRevision(locked.parent));
        }),
      remove: (id) =>
        database.transaction(async (s) => {
          const locked = await lockCohort(s, id);
          if (!locked) return;
          const { parent, record } = locked;
          requireLegacyCohorts(parent);
          await update(s, "experiments", parent["id"], {
            ...nextRevision(parent),
            ...(parent["winner"] === record["slug"] ? { winner: null } : {}),
          });
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
      addUserCohort: (userId, experimentId, cohortId, _deliveries, expectedRevision) =>
        database.transaction(async (s) => {
          const experiment = await lockExperiment(s, experimentId);
          if (
            expectedRevision !== undefined &&
            Number(experiment["rollout_revision"] ?? 0) !== expectedRevision
          )
            throw new RolloutConflictError();
          if (!isEnabled(experiment)) throw new ExperimentPausedError();
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
