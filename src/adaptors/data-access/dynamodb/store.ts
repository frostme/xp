import type { DynamoDBDocumentClient, TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";

import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import type {
  Cohort,
  CohortSlug,
  CreationPayload,
  Experiment,
  ExperimentSlug,
  PKey,
  User,
  UserCohort,
} from "~/entities";

import { DuplicateAssignmentError, NotFoundError, ValidationError } from "~/errors";

import { loadDriver } from "../optionalDriver";
import {
  cohortClaim,
  cohortKey,
  cohortLocator,
  experimentClaim,
  experimentKey,
  membershipKey,
  membershipReference,
  userKey,
  type Key,
} from "./schema";

type Action = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
type Item = Record<string, any>;
type State = "active" | "deleting";
type StoredExperiment = Omit<Experiment, "cohorts"> & Key & { state: State };
type StoredCohort = Cohort & Key & { experiment_id: PKey<"Experiment">; state: State };
type StoredMembership = UserCohort & Key;
const attempts = 5;
const pageSize = 25;

function conditionalFailure(error: unknown): boolean {
  const failure = error as { name?: string; CancellationReasons?: { Code?: string }[] };
  return (
    failure?.name === "ConditionalCheckFailedException" ||
    (failure?.name === "TransactionCanceledException" &&
      failure.CancellationReasons?.some((reason) => reason.Code === "ConditionalCheckFailed") ===
        true)
  );
}

function transactionConflict(error: unknown): boolean {
  const failure = error as { name?: string; CancellationReasons?: { Code?: string }[] };
  return (
    failure?.name === "TransactionConflictException" ||
    failure?.name === "TransactionInProgressException" ||
    (failure?.name === "TransactionCanceledException" &&
      failure.CancellationReasons?.some((reason) => reason.Code === "TransactionConflict") === true)
  );
}

function cohortValue(row: StoredCohort): Cohort & { experiment_id: PKey<"Experiment"> } {
  return {
    id: row.id,
    experiment_id: row.experiment_id,
    slug: row.slug,
    description: row.description,
    percentage: row.percentage,
    type: row.type,
    value: row.value ?? null,
  };
}

function membershipValue(row: StoredMembership): UserCohort {
  return {
    id: row.id,
    user_id: row.user_id,
    experiment_id: row.experiment_id,
    cohort_id: row.cohort_id,
  };
}

/** All related records live in the base table so read-after-write and cleanup do not depend on a GSI. */
export default class DynamoDBStore {
  private readonly sdk =
    loadDriver<typeof import("@aws-sdk/lib-dynamodb")>("@aws-sdk/lib-dynamodb");

  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {
    if (!tableName.trim()) throw new ValidationError("DynamoDB tableName is required");
  }

  private async get<T extends Item>(key: Key): Promise<T | null> {
    const result = await this.client.send(
      new this.sdk.GetCommand({ TableName: this.tableName, Key: key, ConsistentRead: true }),
    );
    return (result.Item as T | undefined) ?? null;
  }

  private async snapshot<T extends Item>(keys: Key[]): Promise<(T | null)[]> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await this.client.send(
          new this.sdk.TransactGetCommand({
            TransactItems: keys.map((key) => ({ Get: { TableName: this.tableName, Key: key } })),
          }),
        );
        return keys.map((_, index) => (result.Responses?.[index]?.Item as T | undefined) ?? null);
      } catch (error) {
        if (!transactionConflict(error) || attempt === attempts - 1) throw error;
        await delay(Math.min(20 * 2 ** attempt, 250));
      }
    }
  }

  private async write(actions: Action[]): Promise<void> {
    const input = { TransactItems: actions, ClientRequestToken: randomUUID() };
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.client.send(new this.sdk.TransactWriteCommand(input));
        return;
      } catch (error) {
        if (!transactionConflict(error) || attempt === attempts - 1) throw error;
        await delay(Math.min(20 * 2 ** attempt, 250));
      }
    }
  }

  private put(item: Item): Action {
    return {
      Put: {
        TableName: this.tableName,
        Item: item,
        ConditionExpression: "attribute_not_exists(pk)",
      },
    };
  }

  private active(key: Key): Action {
    return {
      ConditionCheck: {
        TableName: this.tableName,
        Key: key,
        ConditionExpression: "#state = :active",
        ExpressionAttributeNames: { "#state": "state" },
        ExpressionAttributeValues: { ":active": "active" },
      },
    };
  }

  private async query<T extends Item>(pk: string, prefix: string): Promise<T[]> {
    const records: T[] = [];
    let cursor: Record<string, any> | undefined;
    do {
      const result = await this.client.send(
        new this.sdk.QueryCommand({
          TableName: this.tableName,
          ConsistentRead: true,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      );
      records.push(...((result.Items ?? []) as T[]));
      cursor =
        result.LastEvaluatedKey && Object.keys(result.LastEvaluatedKey).length > 0
          ? result.LastEvaluatedKey
          : undefined;
    } while (cursor);
    return records;
  }

  private async firstPage<T extends Item>(pk: string, prefix: string): Promise<T[]> {
    const result = await this.client.send(
      new this.sdk.QueryCommand({
        TableName: this.tableName,
        ConsistentRead: true,
        Limit: pageSize,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk, ":prefix": prefix },
      }),
    );
    return (result.Items ?? []) as T[];
  }

  private async rawCohort(id: PKey<"Cohort">): Promise<StoredCohort | null> {
    const locator = await this.get<{ experiment_id: PKey<"Experiment"> } & Item>(cohortLocator(id));
    return locator ? this.get<StoredCohort>(cohortKey(locator.experiment_id, id)) : null;
  }

  private async visibleCohort(id: PKey<"Cohort">): Promise<StoredCohort | null> {
    const row = await this.rawCohort(id);
    if (!row) return null;
    const [cohort, experiment] = await this.snapshot<StoredCohort | StoredExperiment>([
      cohortKey(row.experiment_id, id),
      experimentKey(row.experiment_id),
    ]);
    return cohort?.state === "active" && experiment?.state === "active"
      ? (cohort as StoredCohort)
      : null;
  }

  async getExperiment(id: PKey<"Experiment">): Promise<Experiment> {
    const row = await this.get<StoredExperiment>(experimentKey(id));
    if (row?.state !== "active") throw new NotFoundError(`Experiment with id ${id} not found`);
    const cohorts = await this.getCohorts(id);
    // A concurrent cascade may have fenced the parent while the cohort query was in flight.
    const current = await this.get<StoredExperiment>(experimentKey(id));
    if (current?.state !== "active") {
      throw new NotFoundError(`Experiment with id ${id} not found`);
    }
    return {
      id: current.id,
      name: current.name,
      slug: current.slug,
      type: current.type,
      description: current.description,
      winner: current.winner,
      cohorts,
    };
  }

  async findExperiment(slug: ExperimentSlug): Promise<Experiment | null> {
    const claim = await this.get<{ experiment_id: PKey<"Experiment"> } & Item>(
      experimentClaim(slug),
    );
    if (!claim) return null;
    try {
      return await this.getExperiment(claim.experiment_id);
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  async listExperiments(): Promise<Experiment[]> {
    const experiments: Experiment[] = [];
    let cursor: Record<string, any> | undefined;
    do {
      const result = await this.client.send(
        new this.sdk.ScanCommand({
          TableName: this.tableName,
          ConsistentRead: true,
          FilterExpression: "begins_with(pk, :prefix) AND sk = :meta AND #state = :active",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: { ":prefix": "EXP#", ":meta": "META", ":active": "active" },
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      );
      for (const row of (result.Items ?? []) as StoredExperiment[]) {
        try {
          experiments.push(await this.getExperiment(row.id));
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
        }
      }
      cursor =
        result.LastEvaluatedKey && Object.keys(result.LastEvaluatedKey).length > 0
          ? result.LastEvaluatedKey
          : undefined;
    } while (cursor);
    return experiments;
  }

  private cohortItems(cohort: Cohort & { experiment_id: PKey<"Experiment"> }): Item[] {
    return [
      { ...cohortKey(cohort.experiment_id, cohort.id), ...cohort, state: "active" },
      { ...cohortLocator(cohort.id), cohort_id: cohort.id, experiment_id: cohort.experiment_id },
      { ...cohortClaim(cohort.slug), cohort_id: cohort.id, experiment_id: cohort.experiment_id },
    ];
  }

  async createExperiment(input: CreationPayload<Experiment>): Promise<Experiment> {
    if (input.cohorts.length > 32) {
      throw new ValidationError("DynamoDB supports at most 32 initial cohorts per experiment");
    }
    const id = randomUUID() as PKey<"Experiment">;
    const cohorts = input.cohorts.map((cohort) => ({
      id: randomUUID() as PKey<"Cohort">,
      experiment_id: id,
      slug: cohort.slug,
      description: cohort.description,
      percentage: cohort.percentage,
      type: cohort.type,
      value: cohort.value ?? null,
    }));
    const experiment: Experiment = {
      id,
      name: input.name,
      slug: input.slug,
      description: input.description,
      type: input.type,
      winner: null,
      cohorts,
    };
    const { cohorts: _cohorts, ...fields } = experiment;
    await this.write([
      this.put({ ...experimentKey(id), ...fields, state: "active" }),
      this.put({ ...experimentClaim(input.slug), experiment_id: id }),
      ...cohorts.flatMap((cohort) => this.cohortItems(cohort).map((item) => this.put(item))),
    ]);
    return experiment;
  }

  private updateAction(key: Key, updates: Item): Action | null {
    const fields = Object.entries(updates).filter(([, value]) => value !== undefined);
    if (!fields.length) return null;
    const names: Record<string, string> = { "#state": "state" };
    const values: Item = { ":active": "active" };
    const assignments = fields.map(([name, value], index) => {
      names[`#f${index}`] = name;
      values[`:v${index}`] = value;
      return `#f${index} = :v${index}`;
    });
    return {
      Update: {
        TableName: this.tableName,
        Key: key,
        UpdateExpression: `SET ${assignments.join(", ")}`,
        ConditionExpression: "#state = :active",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      },
    };
  }

  async updateExperiment(
    id: PKey<"Experiment">,
    updates: Partial<Pick<Experiment, "name" | "description" | "winner">>,
    winnerCohortId?: PKey<"Cohort">,
  ): Promise<void> {
    const action = this.updateAction(experimentKey(id), {
      name: updates.name,
      description: updates.description,
      winner: updates.winner,
    });
    if (!action) return;
    if ((await this.get<StoredExperiment>(experimentKey(id)))?.state !== "active") return;
    const actions: Action[] = [action];
    if (updates.winner != null) {
      const cohort = await this.findCohort(updates.winner);
      if (
        !cohort ||
        (winnerCohortId !== undefined && cohort.id !== winnerCohortId) ||
        (await this.rawCohort(cohort.id))?.experiment_id !== id
      ) {
        throw new NotFoundError("Winning cohort no longer exists in the experiment");
      }
      actions.push(this.active(cohortKey(id, cohort.id)));
    }
    try {
      await this.write(actions);
    } catch (error) {
      if (conditionalFailure(error)) {
        if ((await this.get<StoredExperiment>(experimentKey(id)))?.state !== "active") return;
        throw new NotFoundError("Winning cohort no longer exists", { cause: error });
      }
      throw error;
    }
  }

  async getCohort(id: PKey<"Cohort">): Promise<Cohort & { experiment_id: PKey<"Experiment"> }> {
    const row = await this.visibleCohort(id);
    if (!row) throw new NotFoundError(`Cohort with id ${id} not found`);
    return cohortValue(row);
  }

  async findCohort(slug: CohortSlug): Promise<Cohort | null> {
    const claim = await this.get<{ cohort_id: PKey<"Cohort"> } & Item>(cohortClaim(slug));
    if (!claim) return null;
    const row = await this.visibleCohort(claim.cohort_id);
    return row ? cohortValue(row) : null;
  }

  async getCohorts(id: PKey<"Experiment">): Promise<Cohort[]> {
    if ((await this.get<StoredExperiment>(experimentKey(id)))?.state !== "active") return [];
    const rows = await this.query<StoredCohort>(experimentKey(id).pk, "C#");
    if ((await this.get<StoredExperiment>(experimentKey(id)))?.state !== "active") return [];
    return rows.filter((row) => row.state === "active").map(cohortValue);
  }

  async createCohort(
    input: CreationPayload<Cohort> & { experiment_id: PKey<"Experiment"> },
  ): Promise<Cohort> {
    const cohort = {
      id: randomUUID() as PKey<"Cohort">,
      experiment_id: input.experiment_id,
      slug: input.slug,
      description: input.description,
      percentage: input.percentage,
      type: input.type,
      value: input.value ?? null,
    };
    try {
      await this.write([
        this.active(experimentKey(input.experiment_id)),
        ...this.cohortItems(cohort).map((item) => this.put(item)),
      ]);
    } catch (error) {
      if (
        conditionalFailure(error) &&
        (await this.get<StoredExperiment>(experimentKey(input.experiment_id)))?.state !== "active"
      ) {
        throw new NotFoundError("Experiment not found", { cause: error });
      }
      throw error;
    }
    return cohort;
  }

  async updateCohort(
    id: PKey<"Cohort">,
    updates: Partial<Pick<Cohort, "description" | "percentage">>,
  ): Promise<void> {
    const row = await this.visibleCohort(id);
    if (!row) return;
    const action = this.updateAction(cohortKey(row.experiment_id, id), {
      description: updates.description,
      percentage: updates.percentage,
    });
    if (!action) return;
    try {
      await this.write([action, this.active(experimentKey(row.experiment_id))]);
    } catch (error) {
      if (conditionalFailure(error)) return;
      throw error;
    }
  }

  async getUser(id: PKey<"User">): Promise<User> {
    const row = await this.get<User & Item>(userKey(id));
    if (!row) throw new NotFoundError(`User with id ${id} not found`);
    return { id: row.id };
  }

  async findMembership(
    userId: PKey<"User">,
    experimentId: PKey<"Experiment">,
  ): Promise<UserCohort | null> {
    const key = membershipKey(experimentId, userId);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const row = await this.get<StoredMembership>(key);
      if (!row) return null;
      const [current, experiment, cohort] = await this.snapshot<Item>([
        key,
        experimentKey(experimentId),
        cohortKey(experimentId, row.cohort_id),
      ]);
      if (!current || experiment?.["state"] !== "active") return null;
      // A leave/rejoin may have changed cohorts between the first read and the snapshot.
      if (current["id"] !== row.id) continue;
      return cohort?.["state"] === "active" ? membershipValue(current as StoredMembership) : null;
    }
    throw new Error("User assignment changed repeatedly during lookup; retry the operation");
  }

  async addMembership(
    userId: PKey<"User">,
    experimentId: PKey<"Experiment">,
    cohortId: PKey<"Cohort">,
  ): Promise<UserCohort> {
    const membership: UserCohort = {
      id: randomUUID() as PKey<"UserCohort">,
      user_id: userId,
      experiment_id: experimentId,
      cohort_id: cohortId,
    };
    try {
      await this.write([
        this.put({ ...membershipKey(experimentId, userId), ...membership }),
        this.put({ ...membershipReference(cohortId, userId), ...membership }),
        this.active(experimentKey(experimentId)),
        this.active(cohortKey(experimentId, cohortId)),
        {
          ConditionCheck: {
            TableName: this.tableName,
            Key: userKey(userId),
            ConditionExpression: "attribute_exists(pk)",
          },
        },
      ]);
    } catch (error) {
      if (conditionalFailure(error)) {
        if (await this.findMembership(userId, experimentId))
          throw new DuplicateAssignmentError({ cause: error });
        await this.getUser(userId);
        await this.getExperiment(experimentId);
        const cohort = await this.getCohort(cohortId);
        if (cohort.experiment_id !== experimentId) {
          throw new NotFoundError("Cohort does not belong to the experiment", { cause: error });
        }
      }
      throw error;
    }
    return membership;
  }

  private ownedDelete(key: Key, field: string, owner: string | number, deleting = false): Action {
    return {
      Delete: {
        TableName: this.tableName,
        Key: key,
        ConditionExpression: deleting
          ? "attribute_not_exists(pk) OR (#owner = :owner AND #state = :deleting)"
          : "attribute_not_exists(pk) OR #owner = :owner",
        ExpressionAttributeNames: { "#owner": field, ...(deleting ? { "#state": "state" } : {}) },
        ExpressionAttributeValues: {
          ":owner": owner,
          ...(deleting ? { ":deleting": "deleting" } : {}),
        },
      },
    };
  }

  private async deleteMembership(row: UserCohort): Promise<void> {
    const key = membershipKey(row.experiment_id, row.user_id);
    const reference = membershipReference(row.cohort_id, row.user_id);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await this.write([
          this.ownedDelete(key, "id", row.id),
          this.ownedDelete(reference, "id", row.id),
        ]);
        return;
      } catch (error) {
        if (!conditionalFailure(error) || attempt === attempts - 1) throw error;
        const currentReference = await this.get<StoredMembership>(reference);
        // The old pair was already removed. Never touch a replacement assignment.
        if (!currentReference || currentReference.id !== row.id) return;
        await delay(20 * 2 ** attempt);
      }
    }
  }

  async removeMembership(userId: PKey<"User">, experimentId: PKey<"Experiment">): Promise<void> {
    const row = await this.get<StoredMembership>(membershipKey(experimentId, userId));
    if (row) await this.deleteMembership(row);
  }

  private async drainMemberships(pk: string): Promise<void> {
    for (;;) {
      const rows = await this.firstPage<StoredMembership>(pk, "M#");
      if (!rows.length) return;
      for (const row of rows) await this.deleteMembership(row);
    }
  }

  private async markCohortDeleting(id: PKey<"Cohort">): Promise<StoredCohort | null> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const row = await this.rawCohort(id);
      if (!row || row.state === "deleting") return row;
      const parent = await this.get<StoredExperiment>(experimentKey(row.experiment_id));
      if (!parent) return null;
      const cohortUpdate: Action = {
        Update: {
          TableName: this.tableName,
          Key: cohortKey(row.experiment_id, id),
          UpdateExpression: "SET #state = :deleting",
          ConditionExpression: "#state = :active",
          ExpressionAttributeNames: { "#state": "state" },
          ExpressionAttributeValues: { ":active": "active", ":deleting": "deleting" },
        },
      };
      const winnerAction: Action =
        parent.winner === row.slug
          ? {
              Update: {
                TableName: this.tableName,
                Key: experimentKey(row.experiment_id),
                UpdateExpression: "SET winner = :null",
                ConditionExpression: "attribute_exists(pk) AND winner = :slug",
                ExpressionAttributeValues: { ":null": null, ":slug": row.slug },
              },
            }
          : {
              ConditionCheck: {
                TableName: this.tableName,
                Key: experimentKey(row.experiment_id),
                ConditionExpression:
                  "attribute_exists(pk) AND (attribute_not_exists(winner) OR winner <> :slug)",
                ExpressionAttributeValues: { ":slug": row.slug },
              },
            };
      try {
        await this.write([cohortUpdate, winnerAction]);
        return { ...row, state: "deleting" };
      } catch (error) {
        if (!conditionalFailure(error) || attempt === attempts - 1) throw error;
        await delay(20 * 2 ** attempt);
      }
    }
    return null;
  }

  async removeCohort(id: PKey<"Cohort">): Promise<void> {
    const row = await this.markCohortDeleting(id);
    if (!row) return;
    await this.drainMemberships(cohortLocator(id).pk);
    try {
      await this.write([
        this.ownedDelete(cohortKey(row.experiment_id, id), "id", id, true),
        this.ownedDelete(cohortLocator(id), "cohort_id", id),
        this.ownedDelete(cohortClaim(row.slug), "cohort_id", id),
      ]);
    } catch (error) {
      // Another cleaner may have completed and the slug may already belong to a new cohort.
      if (conditionalFailure(error) && !(await this.rawCohort(id))) return;
      throw error;
    }
  }

  async removeExperiment(id: PKey<"Experiment">): Promise<void> {
    let row = await this.get<StoredExperiment>(experimentKey(id));
    if (!row) return;
    if (row.state === "active") {
      try {
        await this.write([
          {
            Update: {
              TableName: this.tableName,
              Key: experimentKey(id),
              UpdateExpression: "SET #state = :deleting",
              ConditionExpression: "#state = :active",
              ExpressionAttributeNames: { "#state": "state" },
              ExpressionAttributeValues: { ":active": "active", ":deleting": "deleting" },
            },
          },
        ]);
      } catch (error) {
        if (!conditionalFailure(error)) throw error;
        row = await this.get<StoredExperiment>(experimentKey(id));
        if (!row) return;
        if (row.state !== "deleting") throw error;
      }
    }
    await this.drainMemberships(experimentKey(id).pk);
    for (;;) {
      const cohorts = await this.firstPage<StoredCohort>(experimentKey(id).pk, "C#");
      if (!cohorts.length) break;
      for (const cohort of cohorts) await this.removeCohort(cohort.id);
    }
    try {
      await this.write([
        this.ownedDelete(experimentKey(id), "id", id, true),
        this.ownedDelete(experimentClaim(row.slug), "experiment_id", id),
      ]);
    } catch (error) {
      if (conditionalFailure(error) && !(await this.get<StoredExperiment>(experimentKey(id))))
        return;
      throw error;
    }
  }
}
