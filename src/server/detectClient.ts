import type { IConfig } from "~/interfaces";

import { optionalDriver } from "~/adaptors/data-access/optionalDriver";
import config from "~/config";

export interface ServerOptions {
  databaseName?: string;
  tableName?: string;
}

export function detectClient(client: unknown, options: ServerOptions): IConfig {
  const pg = optionalDriver<typeof import("pg")>("pg");
  if (pg && (client instanceof pg.Client || client instanceof pg.Pool))
    return config.postgres(client);
  // mysql2 exposes PromisePool at runtime but not in its declaration exports.
  const mysql = optionalDriver<
    typeof import("mysql2/promise") & {
      PromisePool: new (...args: never[]) => import("mysql2/promise").Pool;
    }
  >("mysql2/promise");
  if (mysql && (client instanceof mysql.Connection || client instanceof mysql.PromisePool))
    return config.mysql(client);
  const mssql = optionalDriver<typeof import("mssql")>("mssql");
  if (mssql && client instanceof mssql.ConnectionPool) return config.mssql(client);
  const mongodb = optionalDriver<typeof import("mongodb")>("mongodb");
  if (mongodb && client instanceof mongodb.MongoClient) {
    if (!options.databaseName?.trim()) throw new TypeError("MongoDB requires databaseName");
    return config.mongodb(client, options.databaseName);
  }
  const dynamodb = optionalDriver<typeof import("@aws-sdk/lib-dynamodb")>("@aws-sdk/lib-dynamodb");
  if (dynamodb && client instanceof dynamodb.DynamoDBDocumentClient) {
    if (!options.tableName?.trim()) throw new TypeError("DynamoDB requires tableName");
    return config.dynamodb(client, options.tableName);
  }
  throw new TypeError(
    "Unsupported database client. Expected pg.Client/Pool, mysql2 promise Connection/Pool, mssql.ConnectionPool, mongodb.MongoClient, or DynamoDBDocumentClient.",
  );
}
