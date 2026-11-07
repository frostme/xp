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
  throw new TypeError("Unsupported database client. Expected pg.Client or pg.Pool.");
}
