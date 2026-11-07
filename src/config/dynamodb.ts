import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import type { IConfig } from "~/interfaces";

import { random } from "~/adaptors/bucketers";
import DynamoDBAdaptor from "~/adaptors/data-access/dynamodb";
import ZodValidation from "~/adaptors/validation/zod";

export default function dynamodbConfig(client: DynamoDBDocumentClient, tableName: string): IConfig {
  return {
    dao: new DynamoDBAdaptor(client, tableName),
    validation: ZodValidation,
    bucketer: random,
  };
}
