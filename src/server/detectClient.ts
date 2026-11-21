import type { IConfig } from "~/interfaces";
import type { SequelizeDialect } from "~/interfaces/config";

import { optionalDriver } from "~/adaptors/data-access/optionalDriver";
import { supportedDialect } from "~/adaptors/data-access/sequelize";
import config from "~/config";

export interface ServerOptions {
  /** Uniform draw in [0, 1) for managed allocations. */
  random?: () => number;
  databaseName?: string;
  tableName?: string;
}

type DetectedClient = IConfig &
  (
    | { driverKind: "postgres" | "mysql" | "mssql" | "mongodb" | "dynamodb" }
    | { driverKind: "sequelize"; dialect: SequelizeDialect }
  );

export function detectClient(client: unknown, options: ServerOptions): DetectedClient {
  const sequelize = optionalDriver<typeof import("sequelize")>("sequelize");
  if (sequelize && client instanceof sequelize.Sequelize) {
    const dialect = supportedDialect(client);
    return { ...config.sequelize(client, dialect), driverKind: "sequelize", dialect };
  }
  const pg = optionalDriver<typeof import("pg")>("pg");
  if (pg && (client instanceof pg.Client || client instanceof pg.Pool))
    return { ...config.postgres(client), driverKind: "postgres" };
  // mysql2 exposes PromisePool at runtime but not in its declaration exports.
  const mysql = optionalDriver<
    typeof import("mysql2/promise") & {
      PromisePool: new (...args: never[]) => import("mysql2/promise").Pool;
    }
  >("mysql2/promise");
  if (mysql && (client instanceof mysql.Connection || client instanceof mysql.PromisePool))
    return { ...config.mysql(client), driverKind: "mysql" };
  const mssql = optionalDriver<typeof import("mssql")>("mssql");
  if (mssql && client instanceof mssql.ConnectionPool)
    return { ...config.mssql(client), driverKind: "mssql" };
  const mongodb = optionalDriver<typeof import("mongodb")>("mongodb");
  if (mongodb && client instanceof mongodb.MongoClient) {
    if (!options.databaseName?.trim()) throw new TypeError("MongoDB requires databaseName");
    return { ...config.mongodb(client, options.databaseName), driverKind: "mongodb" };
  }
  const dynamodb = optionalDriver<typeof import("@aws-sdk/lib-dynamodb")>("@aws-sdk/lib-dynamodb");
  if (dynamodb && client instanceof dynamodb.DynamoDBDocumentClient) {
    if (!options.tableName?.trim()) throw new TypeError("DynamoDB requires tableName");
    return { ...config.dynamodb(client, options.tableName), driverKind: "dynamodb" };
  }
  throw new TypeError(
    "Unsupported database client. Expected pg.Client/Pool, mysql2 promise Connection/Pool, mssql.ConnectionPool, mongodb.MongoClient, DynamoDBDocumentClient, or a Sequelize 6 instance (postgres/mysql/mssql).",
  );
}
