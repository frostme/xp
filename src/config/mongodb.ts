import type { MongoClient } from "mongodb";

import type { IConfig } from "~/interfaces";

import { random } from "~/adaptors/bucketers";
import MongoDBAdaptor from "~/adaptors/data-access/mongodb";
import ZodValidation from "~/adaptors/validation/zod";

export default function mongodbConfig(client: MongoClient, databaseName: string): IConfig {
  return {
    dao: new MongoDBAdaptor(client, databaseName),
    validation: ZodValidation,
    bucketer: random,
  };
}
