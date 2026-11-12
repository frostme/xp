import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

import type { StorageFixture } from "~/__tests__/storage/contract";

import { generatedDynamo } from "~/__tests__/storage/setup";
import server from "~/server";

import DynamoDBAdaptor from "..";
import { userKey } from "../schema";

export async function dynamodbFixture(): Promise<
  StorageFixture & {
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
      adaptor,
      server: server(client, { tableName }),
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
