import { randomUUID } from "node:crypto";
import { Client, Pool, type PoolConfig } from "pg";

import type { StorageFixture } from "~/__tests__/storage/contract";

import server from "~/server";

import PostgresAdaptor from "..";

const postgresSchema = `
CREATE TABLE users (
  id TEXT PRIMARY KEY
);
CREATE TABLE experiments (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('flag', 'simple', 'multivariate', 'dynamic')),
  description TEXT NOT NULL,
  winner TEXT
);
CREATE TABLE cohorts (
  id SERIAL PRIMARY KEY,
  experiment_id INTEGER NOT NULL REFERENCES experiments(id),
  slug TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('control', 'treatment')),
  description TEXT NOT NULL,
  percentage DOUBLE PRECISION NOT NULL CHECK (percentage >= 0 AND percentage <= 100),
  value JSONB NOT NULL DEFAULT 'null'::jsonb,
  UNIQUE (id, experiment_id)
);
CREATE INDEX cohorts_experiment_id_idx ON cohorts(experiment_id);
CREATE TABLE user_cohorts (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  experiment_id INTEGER NOT NULL REFERENCES experiments(id),
  cohort_id INTEGER NOT NULL,
  UNIQUE (user_id, experiment_id),
  FOREIGN KEY (cohort_id, experiment_id) REFERENCES cohorts(id, experiment_id)
);
CREATE INDEX user_cohorts_experiment_id_idx ON user_cohorts(experiment_id);
CREATE INDEX user_cohorts_cohort_id_idx ON user_cohorts(cohort_id);
`;

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
