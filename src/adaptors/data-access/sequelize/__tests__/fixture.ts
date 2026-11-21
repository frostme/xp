import { Sequelize } from "sequelize";

import type { StorageFixture } from "~/__tests__/storage/contract";
import type { SequelizeDialect } from "~/interfaces/config";

import { setupMssql } from "~/adaptors/data-access/mssql/__tests__/fixture";
import { setupMysql } from "~/adaptors/data-access/mysql/__tests__/fixture";
import { setupPostgres } from "~/adaptors/data-access/postgres/__tests__/fixture";
import server from "~/server";
import { detectClient } from "~/server/detectClient";

export interface SequelizeFixture extends StorageFixture {
  applyAnalytics(): Promise<void>;
  startupOptions: { connection: Sequelize };
  reopen(): ReturnType<typeof server>;
}

async function usingSequelize(
  native: StorageFixture & { applyAnalytics(): Promise<void> },
  connect: () => Sequelize,
): Promise<SequelizeFixture> {
  let connection: Sequelize | undefined;
  try {
    connection = connect();
    await connection.authenticate();
    const sequelize = connection;
    return {
      ...native,
      startupOptions: { connection: sequelize },
      adaptor: detectClient(sequelize, {}).dao,
      server: server(sequelize),
      reopen: () => server(sequelize),
      async cleanup() {
        try {
          await sequelize.close();
        } finally {
          await native.cleanup();
        }
      },
    };
  } catch (error) {
    try {
      await connection?.close();
    } finally {
      await native.cleanup();
    }
    throw error;
  }
}

export async function setupSequelize(
  dialect: SequelizeDialect,
  version: 1 | 2 | 3 = 3,
): Promise<SequelizeFixture> {
  if (dialect === "postgres") {
    const native = await setupPostgres(version);
    return usingSequelize(native, () => {
      const config = native.connectionConfig;
      const common = {
        dialect,
        logging: false as const,
        dialectOptions: { options: config.options },
      };
      return config.connectionString
        ? new Sequelize(config.connectionString, common)
        : new Sequelize({
            ...common,
            database: config.database!,
            username: config.user!,
            password: config.password as string,
            host: config.host!,
            port: config.port!,
          });
    });
  }
  if (dialect === "mysql") {
    const native = await setupMysql({}, version);
    return usingSequelize(native, () => {
      const config = native.connectionConfig;
      return new Sequelize({
        dialect,
        logging: false,
        database: config.database!,
        username: config.user!,
        password: config.password!,
        host: config.host!,
        port: config.port!,
      });
    });
  }
  const tedious = await import("tedious");
  const native = await setupMssql(version);
  return usingSequelize(native, () => {
    const config = native.connectionConfig;
    return new Sequelize({
      dialect,
      logging: false,
      database: config.database!,
      username: config.user!,
      password: config.password!,
      dialectModule: tedious,
      host: config.server,
      port: config.port!,
      dialectOptions: { options: config.options },
    });
  });
}
