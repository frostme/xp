import sql from "mssql";
import { randomUUID } from "node:crypto";

import type { StorageFixture } from "~/__tests__/storage/contract";

import server from "~/server";

import MssqlAdaptor from "..";

const mssqlSchema = `
CREATE TABLE users (
  id NVARCHAR(255) COLLATE Latin1_General_100_BIN2 NOT NULL PRIMARY KEY
);
CREATE TABLE experiments (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  name NVARCHAR(MAX) NOT NULL,
  slug NVARCHAR(255) COLLATE Latin1_General_100_BIN2 NOT NULL UNIQUE,
  type NVARCHAR(20) NOT NULL CHECK (type IN ('flag', 'simple', 'multivariate', 'dynamic')),
  description NVARCHAR(MAX) NOT NULL,
  winner NVARCHAR(255) COLLATE Latin1_General_100_BIN2 NULL
);
CREATE TABLE cohorts (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  experiment_id INT NOT NULL REFERENCES experiments(id),
  slug NVARCHAR(255) COLLATE Latin1_General_100_BIN2 NOT NULL UNIQUE,
  type NVARCHAR(20) NOT NULL CHECK (type IN ('control', 'treatment')),
  description NVARCHAR(MAX) NOT NULL,
  percentage FLOAT NOT NULL CHECK (percentage >= 0 AND percentage <= 100),
  value NVARCHAR(MAX) NOT NULL DEFAULT N'null' CHECK (ISJSON(value, VALUE) = 1),
  UNIQUE (id, experiment_id)
);
CREATE INDEX cohorts_experiment_id_idx ON cohorts(experiment_id);
CREATE TABLE user_cohorts (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  user_id NVARCHAR(255) COLLATE Latin1_General_100_BIN2 NOT NULL REFERENCES users(id),
  experiment_id INT NOT NULL REFERENCES experiments(id),
  cohort_id INT NOT NULL,
  UNIQUE (user_id, experiment_id),
  FOREIGN KEY (cohort_id, experiment_id) REFERENCES cohorts(id, experiment_id)
);
CREATE INDEX user_cohorts_experiment_id_idx ON user_cohorts(experiment_id);
CREATE INDEX user_cohorts_cohort_id_idx ON user_cohorts(cohort_id);
`;

export interface MssqlFixture extends StorageFixture {
  pool: sql.ConnectionPool;
}

export async function setupMssql(): Promise<MssqlFixture> {
  const database = `xp_${randomUUID().replaceAll("-", "")}`;
  const config: sql.config = {
    server: process.env["MSSQL_HOST"] ?? "127.0.0.1",
    port: Number(process.env["MSSQL_PORT"] ?? 1434),
    user: process.env["MSSQL_USER"] ?? "sa",
    password: process.env["MSSQL_SA_PASSWORD"] ?? "Xp_test_Password123!",
    database: "master",
    connectionTimeout: 30_000,
    requestTimeout: 30_000,
    options: { encrypt: false, trustServerCertificate: true },
    pool: { min: 0, max: 8, idleTimeoutMillis: 1000 },
  };
  const admin = new sql.ConnectionPool(config);
  await admin.connect();
  const pool = new sql.ConnectionPool({ ...config, database });
  const dropDatabase = () =>
    admin
      .request()
      .query(
        `IF DB_ID(N'${database}') IS NOT NULL BEGIN ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${database}]; END`,
      );
  try {
    await admin.request().query(`CREATE DATABASE [${database}]`);
    await pool.connect();
    await pool.request().query(mssqlSchema);
    return {
      pool,
      adaptor: new MssqlAdaptor(pool),
      server: server(pool),
      async seedUser(id) {
        await pool
          .request()
          .input("id", sql.NVarChar(255), id)
          .query(
            "IF NOT EXISTS (SELECT 1 FROM users WHERE id = @id) INSERT INTO users (id) VALUES (@id)",
          );
      },
      async cleanup() {
        await pool.close();
        try {
          await dropDatabase();
        } finally {
          await admin.close();
        }
      },
    };
  } catch (error) {
    await pool.close();
    try {
      await dropDatabase();
    } finally {
      await admin.close();
    }
    throw error;
  }
}
