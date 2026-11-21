import type {
  DynamoDBDocumentClient,
  QueryCommandInput,
  TransactWriteCommandInput,
  UpdateCommandInput,
} from "@aws-sdk/lib-dynamodb";

import { randomUUID } from "node:crypto";

import type { AnalyticsDestination, PendingDelivery } from "~/entities/analytics";
import type {
  AnalyticsStore,
  ClaimedDelivery,
  ClaimOptions,
  ClaimRef,
  DeliveryDiagnostics,
  DeliveryFailure,
  DeliveryState,
  DeliverySummary,
  DeliveryTransition,
} from "~/interfaces/analytics";

import { loadDriver } from "../optionalDriver";

type Action = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
type StoredDelivery = PendingDelivery & {
  state: DeliveryState;
  attempts: number;
  dueAt: number;
  createdAt: number;
  reason?: DeliveryFailure;
  leaseToken?: string;
};
type IndexedDelivery = Pick<
  StoredDelivery,
  "provider" | "attempts" | "dueAt" | "state" | "createdAt" | "reason"
> & { sk: string };
const bindingPartition = "XP_ANALYTICS#DESTINATIONS";
const indexName = "xp_analytics_due";
const partition = (destinationKey: string) => "XP_ANALYTICS#DELIVERIES#" + destinationKey;
const rowKey = (destinationKey: string, eventId: string) => ({
  pk: partition(destinationKey),
  sk: eventId,
});
const indexPartition = (key: string, state: DeliveryState) => key + "#" + state;
const indexSort = (time: number, eventId: string) => new Date(time).toISOString() + "#" + eventId;
const ownsClaim = "#state = :claimed AND leaseToken = :token AND dueAt > :now";
const isConditionFailure = (error: unknown) =>
  (error as Error)?.name === "ConditionalCheckFailedException";

export default class DynamoAnalyticsStore implements AnalyticsStore {
  private readonly sdk =
    loadDriver<typeof import("@aws-sdk/lib-dynamodb")>("@aws-sdk/lib-dynamodb");

  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly write: (actions: Action[]) => Promise<void>,
  ) {}

  async ready(destinations: readonly AnalyticsDestination[]): Promise<void> {
    const { DescribeTableCommand } = loadDriver<typeof import("@aws-sdk/client-dynamodb")>(
      "@aws-sdk/client-dynamodb",
    );
    const { Table } = await this.client.send(
      new DescribeTableCommand({ TableName: this.tableName }),
    );
    const index = Table?.GlobalSecondaryIndexes?.find((item) => item.IndexName === indexName);
    if (
      index?.IndexStatus !== "ACTIVE" ||
      index.Projection?.ProjectionType !== "ALL" ||
      !["analytics_pk", "analytics_sk"].every(
        (attribute, i) =>
          Table?.AttributeDefinitions?.some(
            (field) => field.AttributeName === attribute && field.AttributeType === "S",
          ) &&
          index.KeySchema?.some(
            (field) =>
              field.AttributeName === attribute && field.KeyType === (i ? "RANGE" : "HASH"),
          ),
      )
    ) {
      throw new Error(
        "Analytics storage is unavailable. Apply the xp setup --analytics DynamoDB update and wait for xp_analytics_due to become ACTIVE.",
      );
    }
    if (!destinations.length) return;
    try {
      await this.write(
        destinations.map(({ key, provider }) => ({
          Put: {
            TableName: this.tableName,
            Item: { pk: bindingPartition, sk: key, provider },
            ConditionExpression: "attribute_not_exists(pk) OR #provider = :provider",
            ExpressionAttributeNames: { "#provider": "provider" },
            ExpressionAttributeValues: { ":provider": provider },
          },
        })),
      );
    } catch (error) {
      if (
        (error as { CancellationReasons?: { Code?: string }[] })?.CancellationReasons?.some(
          (item) => item.Code === "ConditionalCheckFailed",
        )
      ) {
        throw new Error("Analytics destination key is already bound to a different provider.", {
          cause: error,
        });
      }
      throw error;
    }
  }

  membershipActions(deliveries: readonly PendingDelivery[]): Action[] {
    // Five membership actions plus two per destination keeps the maximum at 69.
    // Both slugs already fit DynamoDB primary keys and a mapped ID fits 1 KiB.
    if (deliveries.length > 32) throw new RangeError("Configure at most 32 analytics destinations");
    return deliveries.flatMap(({ destinationKey, provider, event, subjectId }) => {
      const createdAt = Date.parse(event.occurredAt);
      return [
        {
          ConditionCheck: {
            TableName: this.tableName,
            Key: { pk: bindingPartition, sk: destinationKey },
            ConditionExpression: "#provider = :provider",
            ExpressionAttributeNames: { "#provider": "provider" },
            ExpressionAttributeValues: { ":provider": provider },
          },
        },
        {
          Put: {
            TableName: this.tableName,
            ConditionExpression: "attribute_not_exists(pk)",
            Item: {
              ...rowKey(destinationKey, event.id),
              event,
              provider,
              destinationKey,
              subjectId,
              createdAt,
              dueAt: createdAt,
              attempts: 0,
              state: "pending",
              analytics_pk: indexPartition(destinationKey, "pending"),
              analytics_sk: indexSort(createdAt, event.id),
            },
          },
        },
      ];
    });
  }

  private async *rows<T>(query: QueryCommandInput, limit: number): AsyncGenerator<T> {
    let cursor: QueryCommandInput["ExclusiveStartKey"];
    let remaining = limit;
    if (remaining <= 0) return;
    do {
      const result = await this.client.send(
        new this.sdk.QueryCommand({
          ...query,
          Limit: Math.min(remaining, 128),
          ...(cursor && { ExclusiveStartKey: cursor }),
        }),
      );
      for (const item of result.Items ?? []) {
        yield item as T;
        remaining--;
      }
      cursor = result.LastEvaluatedKey;
    } while (remaining > 0 && cursor && Object.keys(cursor).length);
  }

  private indexed(
    key: string,
    state: DeliveryState,
    limit: number,
    through?: number,
    exclusive = false,
  ) {
    // ISO time and the occurrence UUID order items sharing the same millisecond.
    const bounded = through !== undefined;
    return this.rows<IndexedDelivery>(
      {
        TableName: this.tableName,
        IndexName: indexName,
        ProjectionExpression: "sk, dueAt, createdAt, #state, #provider, #attempts, #reason",
        ExpressionAttributeNames: {
          "#state": "state",
          "#provider": "provider",
          "#attempts": "attempts",
          "#reason": "reason",
        },
        KeyConditionExpression: bounded
          ? "analytics_pk = :pk AND analytics_sk <= :end"
          : "analytics_pk = :pk",
        ExpressionAttributeValues: {
          ":pk": indexPartition(key, state),
          ...(bounded && { ":end": indexSort(through, exclusive ? "" : "~") }),
        },
      },
      limit,
    );
  }

  async destinations(after: string | null, limit: number): Promise<AnalyticsDestination[]> {
    const bindings = this.rows<{ sk: string; provider: string }>(
      {
        TableName: this.tableName,
        ConsistentRead: true,
        KeyConditionExpression: after === null ? "pk = :pk" : "pk = :pk AND sk > :after",
        ExpressionAttributeValues: {
          ":pk": bindingPartition,
          ...(after !== null && { ":after": after }),
        },
      },
      limit,
    );
    const result: AnalyticsDestination[] = [];
    for await (const binding of bindings)
      result.push({ key: binding.sk, provider: binding.provider });
    return result;
  }

  async claim(
    destination: AnalyticsDestination,
    { now, limit, leaseMs }: ClaimOptions,
  ): Promise<ClaimedDelivery[]> {
    const candidates: IndexedDelivery[] = [];
    for (const state of ["pending", "claimed"] as const) {
      for await (const row of this.indexed(destination.key, state, limit, now))
        candidates.push(row);
    }
    candidates.sort((a, b) => a.dueAt - b.dueAt || a.sk.localeCompare(b.sk));
    const claimed: ClaimedDelivery[] = [];
    for (const row of candidates) {
      const leaseToken = randomUUID();
      const leaseUntil = now + leaseMs;
      try {
        const result = await this.client.send(
          new this.sdk.UpdateCommand({
            TableName: this.tableName,
            Key: rowKey(destination.key, row.sk),
            ConditionExpression:
              "#provider = :provider AND (#state = :pending OR #state = :claimed) AND dueAt <= :now",
            UpdateExpression:
              "SET #state = :claimed, leaseToken = :token, dueAt = :until, analytics_pk = :pk, analytics_sk = :sk ADD #attempts :one",
            ExpressionAttributeNames: {
              "#state": "state",
              "#provider": "provider",
              "#attempts": "attempts",
            },
            ExpressionAttributeValues: {
              ":provider": destination.provider,
              ":pending": "pending",
              ":claimed": "claimed",
              ":now": now,
              ":token": leaseToken,
              ":until": leaseUntil,
              ":one": 1,
              ":pk": indexPartition(destination.key, "claimed"),
              ":sk": indexSort(leaseUntil, row.sk),
            },
            ReturnValues: "ALL_NEW",
          }),
        );
        const current = result.Attributes as StoredDelivery;
        claimed.push({
          event: current.event,
          destinationKey: current.destinationKey,
          provider: current.provider,
          subjectId: current.subjectId,
          attempts: current.attempts,
          leaseToken,
          leaseUntil,
        });
        if (claimed.length === limit) break;
      } catch (error) {
        if (!isConditionFailure(error)) throw error;
      }
    }
    return claimed;
  }

  private async update(
    ref: Pick<ClaimRef, "destinationKey" | "eventId">,
    input: Omit<UpdateCommandInput, "TableName" | "Key">,
  ) {
    try {
      await this.client.send(
        new this.sdk.UpdateCommand({
          TableName: this.tableName,
          Key: rowKey(ref.destinationKey, ref.eventId),
          ...input,
        }),
      );
      return true;
    } catch (error) {
      if (isConditionFailure(error)) return false;
      throw error;
    }
  }

  settle(ref: ClaimRef, next: DeliveryTransition, now: number): Promise<boolean> {
    const time = next.state === "pending" ? next.availableAt : now;
    const hasReason = next.state !== "delivered";
    return this.update(ref, {
      ConditionExpression: ownsClaim,
      UpdateExpression:
        "SET #state = :next, dueAt = :time, analytics_pk = :pk, analytics_sk = :sk" +
        (hasReason ? ", #reason = :reason REMOVE leaseToken" : " REMOVE leaseToken, #reason"),
      ExpressionAttributeNames: { "#state": "state", "#reason": "reason" },
      ExpressionAttributeValues: {
        ":claimed": "claimed",
        ":token": ref.leaseToken,
        ":now": now,
        ":next": next.state,
        ":time": time,
        ":pk": indexPartition(ref.destinationKey, next.state),
        ":sk": indexSort(time, ref.eventId),
        ...(hasReason && { ":reason": next.reason }),
      },
    });
  }

  renew(ref: ClaimRef, leaseUntil: number, now: number): Promise<boolean> {
    if (leaseUntil <= now) return Promise.resolve(false);
    return this.update(ref, {
      ConditionExpression: ownsClaim + " AND dueAt < :until",
      UpdateExpression: "SET dueAt = :until, analytics_sk = :sk",
      ExpressionAttributeNames: { "#state": "state" },
      ExpressionAttributeValues: {
        ":claimed": "claimed",
        ":token": ref.leaseToken,
        ":now": now,
        ":until": leaseUntil,
        ":sk": indexSort(leaseUntil, ref.eventId),
      },
    });
  }

  redrive(destinationKey: string, eventId: string, now: number): Promise<boolean> {
    return this.update(
      { destinationKey, eventId },
      {
        ConditionExpression: "#state = :failed",
        UpdateExpression:
          "SET #state = :pending, #attempts = :zero, dueAt = :now, analytics_pk = :pk, analytics_sk = :sk REMOVE #reason",
        ExpressionAttributeNames: {
          "#state": "state",
          "#attempts": "attempts",
          "#reason": "reason",
        },
        ExpressionAttributeValues: {
          ":failed": "failed",
          ":pending": "pending",
          ":zero": 0,
          ":now": now,
          ":pk": indexPartition(destinationKey, "pending"),
          ":sk": indexSort(now, eventId),
        },
      },
    );
  }

  async inspect(key: string, state: DeliveryState, limit: number): Promise<DeliverySummary[]> {
    const out: DeliverySummary[] = [];
    for await (const row of this.indexed(key, state, limit)) {
      out.push({
        eventId: row.sk,
        occurredAt: new Date(row.createdAt).toISOString(),
        destinationKey: key,
        provider: row.provider,
        state: row.state,
        attempts: row.attempts,
        reason: row.reason ?? null,
      });
    }
    return out;
  }

  async diagnostics(key: string): Promise<DeliveryDiagnostics> {
    const counts = { pending: 0, claimed: 0, delivered: 0, failed: 0 };
    let oldestPendingAt: number | null = null;
    const rows = this.rows<Pick<StoredDelivery, "state" | "createdAt">>(
      {
        TableName: this.tableName,
        ConsistentRead: true,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": partition(key) },
        ProjectionExpression: "#state, createdAt",
        ExpressionAttributeNames: { "#state": "state" },
      },
      Infinity,
    );
    for await (const row of rows) {
      counts[row.state]++;
      if (row.state === "pending" || row.state === "claimed")
        oldestPendingAt = Math.min(oldestPendingAt ?? Infinity, row.createdAt);
    }
    return { counts, oldestPendingAt };
  }

  async prune(key: string, before: number, limit: number): Promise<number> {
    return this.remove(key, ["delivered", "failed"], before, limit, true);
  }

  async purge(key: string, now: number, limit: number): Promise<number> {
    return this.remove(key, ["pending", "claimed"], now, limit, false);
  }

  private async remove(
    key: string,
    states: DeliveryState[],
    cutoff: number,
    limit: number,
    history: boolean,
  ) {
    let count = 0;
    for (const state of states) {
      if (count >= limit) break;
      const unconditionalTime = state === "pending";
      const candidates = this.indexed(
        key,
        state,
        limit - count,
        unconditionalTime ? undefined : cutoff,
        history,
      );
      for await (const row of candidates) {
        try {
          await this.client.send(
            new this.sdk.DeleteCommand({
              TableName: this.tableName,
              Key: rowKey(key, row.sk),
              ConditionExpression:
                "#state = :state" +
                (unconditionalTime
                  ? ""
                  : history
                    ? " AND dueAt < :cutoff"
                    : " AND dueAt <= :cutoff"),
              ExpressionAttributeNames: { "#state": "state" },
              ExpressionAttributeValues: {
                ":state": state,
                ...(!unconditionalTime && { ":cutoff": cutoff }),
              },
            }),
          );
          count++;
        } catch (error) {
          if (!isConditionFailure(error)) throw error;
        }
      }
    }
    return count;
  }
}
