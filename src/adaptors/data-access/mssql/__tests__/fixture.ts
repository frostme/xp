import sql from "mssql";
import { randomUUID } from "node:crypto";

import type { StorageFixture } from "~/__tests__/storage/contract";

import { generatedSql } from "~/__tests__/storage/setup";
import server from "~/server";

import MssqlAdaptor from "..";

const mssqlSchema = generatedSql("mssql");

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
