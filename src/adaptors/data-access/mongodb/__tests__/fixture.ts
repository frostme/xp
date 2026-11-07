import { MongoClient } from "mongodb";
import { randomUUID } from "node:crypto";

import type { StorageFixture } from "~/__tests__/storage/contract";

import server from "~/server";

import MongoDBAdaptor from "..";

export async function mongoFixture(): Promise<
  StorageFixture & { client: MongoClient; databaseName: string }
> {
  const client = new MongoClient(
    process.env.XP_MONGODB_URL ?? "mongodb://127.0.0.1:27018/?directConnection=true&replicaSet=rs0",
    { serverSelectionTimeoutMS: 10_000 },
  );
  const databaseName = `xp_test_${randomUUID().replaceAll("-", "")}`;
  await client.connect();
  const db = client.db(databaseName);
  try {
    for (const name of ["experiments", "cohorts", "users", "user_cohorts"]) {
      await db.createCollection(name);
      await db.collection(name).createIndex({ id: 1 }, { unique: true });
    }
    await db.collection("experiments").createIndex({ slug: 1 }, { unique: true });
    await db.collection("cohorts").createIndex({ slug: 1 }, { unique: true });
    await db.collection("cohorts").createIndex({ experiment_id: 1 });
    await db
      .collection("user_cohorts")
      .createIndex({ user_id: 1, experiment_id: 1 }, { unique: true });
    await db.collection("user_cohorts").createIndex({ experiment_id: 1 });
    await db.collection("user_cohorts").createIndex({ cohort_id: 1 });
    return {
      client,
      databaseName,
      adaptor: new MongoDBAdaptor(client, databaseName),
      server: server(client, { databaseName }),
      async seedUser(id) {
        await db.collection("users").updateOne({ id }, { $setOnInsert: { id } }, { upsert: true });
      },
      async cleanup() {
        try {
          await db.dropDatabase();
        } finally {
          await client.close();
        }
      },
    };
  } catch (error) {
    try {
      await db.dropDatabase();
    } finally {
      await client.close();
    }
    throw error;
  }
}
