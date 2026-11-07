import {
  createConnection,
  createPool,
  type ConnectionOptions,
  type Pool,
  type PoolOptions,
} from "mysql2/promise";
import { randomUUID } from "node:crypto";

import type { StorageFixture } from "~/__tests__/storage/contract";

import server from "~/server";

import MysqlAdaptor from "..";

const mysqlSchema = `
CREATE TABLE users (
  id VARCHAR(191) COLLATE utf8mb4_0900_bin PRIMARY KEY
) ENGINE=InnoDB;
CREATE TABLE experiments (
  id INTEGER AUTO_INCREMENT PRIMARY KEY,
  name TEXT NOT NULL,
  slug VARCHAR(191) COLLATE utf8mb4_0900_bin NOT NULL UNIQUE,
  type VARCHAR(32) NOT NULL CHECK (type IN ('flag', 'simple', 'multivariate', 'dynamic')),
  description TEXT NOT NULL,
  winner VARCHAR(191) COLLATE utf8mb4_0900_bin
) ENGINE=InnoDB;
CREATE TABLE cohorts (
  id INTEGER AUTO_INCREMENT PRIMARY KEY,
  experiment_id INTEGER NOT NULL,
  slug VARCHAR(191) COLLATE utf8mb4_0900_bin NOT NULL UNIQUE,
  type VARCHAR(32) NOT NULL CHECK (type IN ('control', 'treatment')),
  description TEXT NOT NULL,
  percentage DOUBLE NOT NULL CHECK (percentage >= 0 AND percentage <= 100),
  value JSON NOT NULL,
  UNIQUE (id, experiment_id),
  FOREIGN KEY (experiment_id) REFERENCES experiments(id),
  INDEX cohorts_experiment_id_idx (experiment_id)
) ENGINE=InnoDB;
CREATE TABLE user_cohorts (
  id INTEGER AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(191) COLLATE utf8mb4_0900_bin NOT NULL,
  experiment_id INTEGER NOT NULL,
  cohort_id INTEGER NOT NULL,
  UNIQUE (user_id, experiment_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (experiment_id) REFERENCES experiments(id),
  FOREIGN KEY (cohort_id, experiment_id) REFERENCES cohorts(id, experiment_id),
  INDEX user_cohorts_experiment_id_idx (experiment_id),
  INDEX user_cohorts_cohort_id_idx (cohort_id)
) ENGINE=InnoDB;
`;

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
