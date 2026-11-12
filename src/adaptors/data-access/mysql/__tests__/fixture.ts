import {
  createConnection,
  createPool,
  type ConnectionOptions,
  type Pool,
  type PoolOptions,
} from "mysql2/promise";
import { randomUUID } from "node:crypto";

import type { StorageFixture } from "~/__tests__/storage/contract";

import { generatedSql } from "~/__tests__/storage/setup";
import server from "~/server";

import MysqlAdaptor from "..";

const mysqlSchema = generatedSql("mysql");

export interface MysqlFixture extends StorageFixture {
  pool: Pool;
  connectionConfig: ConnectionOptions;
}

export async function setupMysql(
  options: Pick<PoolOptions, "connectionLimit" | "jsonStrings"> = {},
): Promise<MysqlFixture> {
  const database = `xp_${randomUUID().replaceAll("-", "")}`;
  const config: ConnectionOptions = {
    host: process.env["MYSQL_HOST"] ?? "127.0.0.1",
    port: Number(process.env["MYSQL_PORT"] ?? 3307),
    user: process.env["MYSQL_USER"] ?? "root",
    password: process.env["MYSQL_PASSWORD"] ?? "root_password",
  };
  const admin = await createConnection(config);
  const connectionConfig: ConnectionOptions = {
    ...config,
    database,
    ...(options.jsonStrings === undefined ? {} : { jsonStrings: options.jsonStrings }),
  };
  const pool = createPool({ ...connectionConfig, connectionLimit: options.connectionLimit ?? 8 });
  try {
    await admin.query(
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`,
    );
    for (const statement of mysqlSchema
      .split(";")
      .map((sql) => sql.trim())
      .filter(Boolean)) {
      await pool.query(statement);
    }
    return {
      pool,
      connectionConfig,
      adaptor: new MysqlAdaptor(pool),
      server: server(pool),
      async seedUser(id) {
        await pool.execute("INSERT INTO users (id) VALUES (?) ON DUPLICATE KEY UPDATE id = id", [
          id,
        ]);
      },
      async cleanup() {
        await pool.end();
        try {
          await admin.query(`DROP DATABASE \`${database}\``);
        } finally {
          await admin.end();
        }
      },
    };
  } catch (error) {
    await pool.end();
    try {
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    } finally {
      await admin.end();
    }
    throw error;
  }
}
