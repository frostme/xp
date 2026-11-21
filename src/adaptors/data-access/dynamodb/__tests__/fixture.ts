import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  UpdateTableCommand,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import type { StorageFixture } from "~/__tests__/storage/contract";

import { generatedDynamo, setupOptions } from "~/__tests__/storage/setup";
import { generateAnalyticsIndex } from "~/adaptors/setup/generators/dynamodb";
import server from "~/server";

import DynamoDBAdaptor from "..";
import { userKey } from "../schema";

export async function dynamodbFixture(): Promise<
  StorageFixture & {
    applyAnalytics(): Promise<void>;
    client: DynamoDBDocumentClient;
    tableName: string;
    seedPrimitiveUser(id: string | number): Promise<void>;
    items(): Promise<Record<string, any>[]>;
  }
> {
  const raw = new DynamoDBClient({
    endpoint: process.env["DYNAMODB_ENDPOINT"] ?? "http://127.0.0.1:8000",
    region: "us-east-1",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
  const client = DynamoDBDocumentClient.from(raw);
  const tableName = `xp_test_${randomUUID().replaceAll("-", "")}`;
  try {
    await raw.send(new CreateTableCommand(generatedDynamo(tableName)));
    const adaptor = new DynamoDBAdaptor(client, tableName);
    const seedPrimitiveUser = async (id: string | number) => {
      await client.send(new PutCommand({ TableName: tableName, Item: { ...userKey(id), id } }));
    };
    return {
      startupOptions: { connection: client, tableName },
      adaptor,
      server: server(client, { tableName }),
      reopen: () => server(client, { tableName }),
      // Version 1 experiments omit enabled and require no storage alteration.
      applyUpgrade: () => Promise.resolve(),
      async applyAnalytics() {
        const spec = generateAnalyticsIndex({ ...setupOptions("dynamodb"), tableName });
        await raw.send(new UpdateTableCommand(JSON.parse(spec.files[0]!.content)));
        await expect
          .poll(
            async () => {
              const { Table } = await raw.send(new DescribeTableCommand({ TableName: tableName }));
              return Table?.GlobalSecondaryIndexes?.find(
                (index) => index.IndexName === "xp_analytics_due",
              )?.IndexStatus;
            },
            { timeout: 15_000, interval: 100 },
          )
          .toBe("ACTIVE");
      },
      client,
      tableName,
      seedUser: seedPrimitiveUser,
      seedPrimitiveUser,
      async items() {
        const items: Record<string, any>[] = [];
        let cursor: Record<string, any> | undefined;
        do {
          const page = await client.send(
            new ScanCommand({
              TableName: tableName,
              ConsistentRead: true,
              ...(cursor ? { ExclusiveStartKey: cursor } : {}),
            }),
          );
          items.push(...(page.Items ?? []));
          cursor =
            page.LastEvaluatedKey && Object.keys(page.LastEvaluatedKey).length > 0
              ? page.LastEvaluatedKey
              : undefined;
        } while (cursor);
        return items;
      },
      async cleanup() {
        try {
          await raw.send(new DeleteTableCommand({ TableName: tableName }));
        } finally {
          client.destroy();
        }
      },
    };
  } catch (error) {
    await raw.send(new DeleteTableCommand({ TableName: tableName })).catch(() => undefined);
    client.destroy();
    throw error;
  }
}
