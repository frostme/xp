import type { CancellationReason } from "@aws-sdk/client-dynamodb";
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
import type { PendingDelivery } from "~/entities/analytics";

import {
  initialDelivery,
  rolloutMetadata,
  type ExperimentDefinition,
  type RolloutPhase,
  type RolloutChange,
} from "~/entities/rollout";
import {
  DuplicateAssignmentError,
  ExperimentPausedError,
  ExperimentSlugConflictError,
  NotFoundError,
  ValidationError,
} from "~/errors";
import { RolloutConflictError } from "~/errors/rolloutConflictError";

import { loadDriver } from "../optionalDriver";
import DynamoAnalyticsStore from "./analytics";
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
type StoredExperiment = Omit<Experiment, "cohorts" | "enabled" | "rolloutPhase" | "revision"> &
  Key & {
    enabled?: boolean;
    state: State;
    rollout_phase?: RolloutPhase;
    rollout_revision?: number;
  };
type StoredCohort = Cohort & Key & { experiment_id: PKey<"Experiment">; state: State };
type StoredMembership = UserCohort & Key;
const attempts = 5;
const pageSize = 25;

function cancellationReasons(error: unknown): CancellationReason[] | undefined {
  const failure = error as { name?: string; CancellationReasons?: CancellationReason[] };
  return failure?.name === "TransactionCanceledException" ? failure.CancellationReasons : undefined;
}

function conditionalFailure(error: unknown): boolean {
  return (
    (error as Error)?.name === "ConditionalCheckFailedException" ||
    cancellationReasons(error)?.some((reason) => reason.Code === "ConditionalCheckFailed") === true
  );
}

function transactionConflict(error: unknown): boolean {
  const name = (error as Error)?.name;
  return (
    name === "TransactionConflictException" ||
    name === "TransactionInProgressException" ||
    cancellationReasons(error)?.some((reason) => reason.Code === "TransactionConflict") === true
  );
}

function revisionCondition(expectedRevision: number) {
  return expectedRevision === 0
    ? "(attribute_not_exists(rollout_revision) OR rollout_revision = :expected)"
    : "rollout_revision = :expected";
}

function guardManagedDefinition(parent: StoredExperiment | null) {
  if (parent?.rollout_phase)
    throw new RolloutConflictError(
      "Use rollout commands to change a managed experiment's cohorts or winner.",
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
  readonly analytics: DynamoAnalyticsStore;
  private readonly sdk =
    loadDriver<typeof import("@aws-sdk/lib-dynamodb")>("@aws-sdk/lib-dynamodb");

  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {
    if (!tableName.trim()) throw new ValidationError("DynamoDB tableName is required");
    this.analytics = new DynamoAnalyticsStore(client, tableName, (actions) => this.write(actions));
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
    const key = experimentKey(id);
    let row = await this.get<StoredExperiment>(key);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (row?.state !== "active") throw new NotFoundError(`Experiment with id ${id} not found`);
      const cohorts = await this.query<StoredCohort>(key.pk, "C#");
      const current = await this.get<StoredExperiment>(key);
      if (current?.state !== "active")
        throw new NotFoundError(`Experiment with id ${id} not found`);
      // A Query covers multiple items/pages. Accept its weights only between equal parent revisions.
      if ((current.rollout_revision ?? 0) === (row.rollout_revision ?? 0)) {
        return {
          id: current.id,
          name: current.name,
          slug: current.slug,
          type: current.type,
          description: current.description,
          enabled: current.enabled ?? true,
          winner: current.winner,
          ...rolloutMetadata(current.rollout_phase, current.rollout_revision),
          cohorts: cohorts.filter((cohort) => cohort.state === "active").map(cohortValue),
        };
      }
      row = current;
    }
    throw new RolloutConflictError("The definition changed during the read. Refresh and retry.");
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

  async createExperiment(input: ExperimentDefinition): Promise<Experiment> {
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
    const fields = {
      id,
      name: input.name,
      slug: input.slug,
      description: input.description,
      type: input.type,
    };
    const delivery = initialDelivery(input);
    try {
      await this.write([
        this.put({ ...experimentKey(id), ...fields, ...delivery, state: "active" }),
        this.put({ ...experimentClaim(input.slug), experiment_id: id }),
        ...cohorts.flatMap((cohort) => this.cohortItems(cohort).map((item) => this.put(item))),
      ]);
    } catch (error) {
      // Item 1 is the unique experiment slug claim. Child slug claims can also fail
      // when another initializer committed this same declaration first.
      if (cancellationReasons(error)?.[1]?.Code === "ConditionalCheckFailed") {
        throw new ExperimentSlugConflictError(input.slug, { cause: error });
      }
      throw error;
    }
    return {
      ...fields,
      enabled: true,
      winner: delivery.winner,
      ...rolloutMetadata(delivery.rollout_phase, delivery.rollout_revision),
      cohorts,
    };
  }

  private updateAction(
    key: Key,
    updates: Item,
    options: {
      advanceRevision?: boolean;
      expectedRevision?: number;
      state?: State;
      legacyOnly?: boolean;
    } = {},
  ): Action {
    const fields = Object.entries(updates).filter(([, value]) => value !== undefined);
    const names: Record<string, string> = { "#state": "state" };
    const values: Item = { ":state": options.state ?? "active" };
    const conditions = ["#state = :state"];
    const assignments = fields.map(([name, value], index) => {
      names[`#f${index}`] = name;
      values[`:v${index}`] = value;
      return `#f${index} = :v${index}`;
    });
    const operations: string[] = [];
    if (assignments.length) operations.push("SET " + assignments.join(", "));
    if (options.advanceRevision) {
      operations.push("ADD rollout_revision :one");
      values[":one"] = 1;
    }
    if (options.expectedRevision !== undefined) {
      conditions.push(revisionCondition(options.expectedRevision));
      values[":expected"] = options.expectedRevision;
    }
    if (options.legacyOnly) {
      conditions.push("(attribute_not_exists(rollout_phase) OR rollout_phase = :null)");
      values[":null"] = null;
    }
    return {
      Update: {
        TableName: this.tableName,
        Key: key,
        UpdateExpression: operations.join(" "),
        ConditionExpression: conditions.join(" AND "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      },
    };
  }

  async commitRollout(change: RolloutChange): Promise<void> {
    const actions = [
      this.updateAction(
        experimentKey(change.id),
        {
          enabled: change.enabled,
          rollout_phase: change.phase ?? undefined,
          winner: change.winner,
        },
        {
          advanceRevision: true,
          expectedRevision: change.expectedRevision,
          legacyOnly: change.phase === null,
        },
      ),
    ];
    const weights = change.weights ?? [];
    for (const weight of weights) {
      actions.push(
        this.updateAction(cohortKey(change.id, weight.id), {
          percentage: weight.basisPoints / 100,
        }),
      );
    }
    if (change.winner !== null) {
      const claim = await this.get<{
        cohort_id: PKey<"Cohort">;
        experiment_id: PKey<"Experiment">;
      }>(cohortClaim(change.winner));
      if (claim?.experiment_id !== change.id)
        throw new RolloutConflictError("The selected winner is no longer available.");
      if (!weights.some((weight) => weight.id === claim.cohort_id))
        actions.push(this.active(cohortKey(change.id, claim.cohort_id)));
    }
    try {
      await this.write(actions);
    } catch (error) {
      if (conditionalFailure(error) || transactionConflict(error)) throw new RolloutConflictError();
      throw error;
    }
  }

  async setEnabled(slug: ExperimentSlug, enabled: boolean): Promise<void> {
    const claim = await this.get<{ experiment_id: PKey<"Experiment"> } & Item>(
      experimentClaim(slug),
    );
    if (claim) {
      const key = experimentKey(claim.experiment_id);
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const parent = await this.get<StoredExperiment>(key);
        if (parent?.state !== "active") break;
        if ((parent.enabled ?? true) === enabled) return;
        try {
          await this.write([
            this.updateAction(
              key,
              { enabled },
              {
                advanceRevision: true,
                expectedRevision: parent.rollout_revision ?? 0,
              },
            ),
          ]);
          return;
        } catch (error) {
          if (!conditionalFailure(error)) throw error;
          if (attempt === attempts - 1) throw new RolloutConflictError();
        }
      }
    }
    throw new NotFoundError(`Experiment with slug ${slug} not found`);
  }

  async updateExperiment(
    id: PKey<"Experiment">,
    updates: Partial<Pick<Experiment, "name" | "description" | "winner">>,
    winnerCohortId?: PKey<"Cohort">,
  ): Promise<void> {
    if (
      updates.winner === undefined &&
      updates.description === undefined &&
      updates.name === undefined
    )
      return;
    const parent = await this.get<StoredExperiment>(experimentKey(id));
    if (parent?.state !== "active") return;
    if (updates.winner !== undefined) guardManagedDefinition(parent);
    const action = this.updateAction(
      experimentKey(id),
      {
        name: updates.name,
        description: updates.description,
        winner: updates.winner,
      },
      { advanceRevision: true, legacyOnly: updates.winner !== undefined },
    );
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
    try {
      return (await this.getExperiment(id)).cohorts;
    } catch (error) {
      if (error instanceof NotFoundError) return [];
      throw error;
    }
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
        this.updateAction(
          experimentKey(input.experiment_id),
          {},
          { advanceRevision: true, legacyOnly: true },
        ),
        ...this.cohortItems(cohort).map((item) => this.put(item)),
      ]);
    } catch (error) {
      if (conditionalFailure(error)) {
        const parent = await this.get<StoredExperiment>(experimentKey(input.experiment_id));
        if (parent?.state !== "active")
          throw new NotFoundError("Experiment not found", { cause: error });
        guardManagedDefinition(parent);
      }
      throw error;
    }
    return cohort;
  }

  async updateCohort(
    id: PKey<"Cohort">,
    updates: Partial<Pick<Cohort, "description" | "percentage">>,
  ): Promise<void> {
    if (updates.description === undefined && updates.percentage === undefined) return;
    const row = await this.visibleCohort(id);
    if (!row) return;
    const action = this.updateAction(cohortKey(row.experiment_id, id), {
      description: updates.description,
      percentage: updates.percentage,
    });
    try {
      await this.write([
        action,
        this.updateAction(
          experimentKey(row.experiment_id),
          {},
          {
            advanceRevision: true,
            legacyOnly: updates.percentage !== undefined,
          },
        ),
      ]);
    } catch (error) {
      if (conditionalFailure(error)) {
        if (updates.percentage !== undefined)
          guardManagedDefinition(
            await this.get<StoredExperiment>(experimentKey(row.experiment_id)),
          );
        return;
      }
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
    deliveries: readonly PendingDelivery[] = [],
    expectedRevision?: number,
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
        {
          ConditionCheck: {
            TableName: this.tableName,
            Key: experimentKey(experimentId),
            ConditionExpression:
              "#state = :active AND (attribute_not_exists(#enabled) OR #enabled = :enabled)" +
              (expectedRevision === undefined ? "" : " AND " + revisionCondition(expectedRevision)),
            ExpressionAttributeNames: { "#state": "state", "#enabled": "enabled" },
            ExpressionAttributeValues: {
              ":active": "active",
              ":enabled": true,
              ...(expectedRevision === undefined ? {} : { ":expected": expectedRevision }),
            },
            ReturnValuesOnConditionCheckFailure: "ALL_OLD",
          },
        },
        this.active(cohortKey(experimentId, cohortId)),
        {
          ConditionCheck: {
            TableName: this.tableName,
            Key: userKey(userId),
            ConditionExpression: "attribute_exists(pk)",
          },
        },
        ...this.analytics.membershipActions(deliveries),
      ]);
    } catch (error) {
      if (expectedRevision !== undefined && transactionConflict(error))
        throw new RolloutConflictError();
      if (conditionalFailure(error)) {
        // Outbox uniqueness and binding failures must never masquerade as a duplicate membership.
        const reasons = cancellationReasons(error);
        if (reasons?.slice(5).some((reason) => reason.Code === "ConditionalCheckFailed"))
          throw error;
        // The SDK exposes cancellation reason items as DynamoDB AttributeValues.
        // Use the condition's snapshot even if a subsequent resume has already committed.
        const reason = cancellationReasons(error)?.[2];
        if (expectedRevision !== undefined && reason?.Code === "ConditionalCheckFailed") {
          throw new RolloutConflictError();
        }
        const parent = reason?.Item;
        if (parent?.["state"]?.S === "active" && parent["enabled"]?.BOOL === false) {
          throw new ExperimentPausedError({ cause: error });
        }
        const experiment = await this.get<StoredExperiment>(experimentKey(experimentId));
        if (experiment?.state !== "active")
          throw new NotFoundError(`Experiment with id ${experimentId} not found`, { cause: error });
        if (expectedRevision !== undefined && experiment.rollout_revision !== expectedRevision)
          throw new RolloutConflictError();
        if (experiment.enabled === false) throw new ExperimentPausedError({ cause: error });
        if (
          reasons?.[0]?.Code === "ConditionalCheckFailed" ||
          (!reasons && (await this.findMembership(userId, experimentId)))
        )
          throw new DuplicateAssignmentError({ cause: error });
        await this.getUser(userId);
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
      // Whole-experiment cleanup drains managed cohorts only after the parent has been fenced.
      if (parent.state === "active") guardManagedDefinition(parent);
      const winnerAction = this.updateAction(
        experimentKey(row.experiment_id),
        parent.winner === row.slug ? { winner: null } : {},
        {
          state: parent.state,
          advanceRevision: true,
          expectedRevision: parent.rollout_revision ?? 0,
          legacyOnly: parent.state === "active",
        },
      );
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
