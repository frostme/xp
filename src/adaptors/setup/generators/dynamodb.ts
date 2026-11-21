import type { GeneratedArtifacts, ResolvedSetup } from "~/interfaces/setup";

import { nativeGuidance, outputPath, shellQuote } from "./common";

export function generateDynamo(options: ResolvedSetup): GeneratedArtifacts {
  if (!/^[A-Za-z0-9_.-]{3,255}$/.test(options.tableName))
    throw new Error(
      "DynamoDB table names must contain 3–255 letters, digits, underscores, hyphens, or periods.",
    );
  const path = outputPath(options.migrationsDir, "xp-create-table.json");
  return {
    files: [
      {
        path,
        purpose: "DynamoDB create-table input",
        content:
          JSON.stringify(
            {
              TableName: options.tableName,
              AttributeDefinitions: [
                { AttributeName: "pk", AttributeType: "S" },
                { AttributeName: "sk", AttributeType: "S" },
              ],
              KeySchema: [
                { AttributeName: "pk", KeyType: "HASH" },
                { AttributeName: "sk", KeyType: "RANGE" },
              ],
              BillingMode: "PAY_PER_REQUEST",
            },
            null,
            2,
          ) + "\n",
      },
    ],
    warnings: [],
    prerequisites: [],
    nextSteps: [
      `Provision with your infrastructure workflow or aws dynamodb create-table --cli-input-json ${shellQuote(`file://${path}`)}. Wait for the table to become ACTIVE.`,
      "Before assignment, write each application user using pk='USER#'+Buffer.from(JSON.stringify([typeof id,id])).toString('base64url'), sk='META', and the original primitive id. The same ID type must be used on later calls.",
      nativeGuidance(options),
    ],
  };
}

/** The sparse index contains analytics items only. The host owns the table lifecycle. */
export function generateAnalyticsIndex(options: ResolvedSetup): GeneratedArtifacts {
  const path = outputPath(options.migrationsDir, "xp-analytics-v1.update-table.json");
  const index = {
    IndexName: "xp_analytics_due",
    KeySchema: [
      { AttributeName: "analytics_pk", KeyType: "HASH" },
      { AttributeName: "analytics_sk", KeyType: "RANGE" },
    ],
    Projection: { ProjectionType: "ALL" },
  };
  return {
    files: [
      {
        path,
        content:
          JSON.stringify(
            {
              TableName: options.tableName,
              AttributeDefinitions: index.KeySchema.map(({ AttributeName }) => ({
                AttributeName,
                AttributeType: "S",
              })),
              GlobalSecondaryIndexUpdates: [{ Create: index }],
            },
            null,
            2,
          ) + "\n",
        purpose: "Add DynamoDB analytics due-work index",
      },
    ],
    warnings: [],
    prerequisites: [],
    nextSteps: [
      `After the base table is ACTIVE, apply aws dynamodb update-table --cli-input-json ${shellQuote(`file://${path}`)}. Wait until the xp_analytics_due index reports ACTIVE before enabling capture. For provisioned-capacity tables, set the index throughput in your infrastructure workflow.`,
    ],
  };
}
