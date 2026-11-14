import { randomUUID } from "node:crypto";
import { Client, Pool, type PoolConfig } from "pg";

import type { StorageFixture } from "~/__tests__/storage/contract";

import { generatedSql } from "~/__tests__/storage/setup";
import server from "~/server";

import PostgresAdaptor from "..";

const postgresSchema = generatedSql("postgres");

function postgresConnectionConfig(): PoolConfig {
  if (process.env["POSTGRES_URL"]) return { connectionString: process.env["POSTGRES_URL"] };
  return {
    host: process.env["PGHOST"] ?? "127.0.0.1",
    port: Number(process.env["PGPORT"] ?? 5433),
    user: process.env["PGUSER"] ?? "test_user",
    password: process.env["PGPASSWORD"] ?? "test_password",
    database: process.env["PGDATABASE"] ?? "test_db",
  };
}

export interface PostgresFixture extends StorageFixture {
  pool: Pool;
  connectionConfig: PoolConfig;
}

export async function setupPostgres(): Promise<PostgresFixture> {
  const schema = `xp_${randomUUID().replaceAll("-", "")}`;
  const config = postgresConnectionConfig();
  const admin = new Client(config);
  await admin.connect();
  const connectionConfig = { ...config, options: `-c search_path=${schema}`, max: 8 };
  const pool = new Pool(connectionConfig);
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(postgresSchema);
    return {
      pool,
      connectionConfig,
      adaptor: new PostgresAdaptor(pool),
      server: server(pool),
      async seedUser(id) {
        await pool.query("INSERT INTO users (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [id]);
      },
      async cleanup() {
        await pool.end();
        try {
          await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {
          await admin.end();
        }
      },
    };
  } catch (error) {
    await pool.end();
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
    throw error;
  }
}
