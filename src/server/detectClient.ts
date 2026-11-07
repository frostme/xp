import type { IConfig } from "~/interfaces";

import { optionalDriver } from "~/adaptors/data-access/optionalDriver";
import config from "~/config";

export interface ServerOptions {
  databaseName?: string;
  tableName?: string;
}

export function detectClient(client: unknown, _options: ServerOptions): IConfig {
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
  throw new TypeError(
    "Unsupported database client. Expected pg.Client/Pool or mysql2 promise Connection/Pool.",
  );
}
