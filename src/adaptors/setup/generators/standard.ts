import type { GeneratedArtifacts, ProjectDetection, ResolvedSetup } from "~/interfaces/setup";

import { generateDynamo } from "./dynamodb";
import { generateModels } from "./models";
import { generateMongoMigration } from "./mongodb";
import { generateSql } from "./sql";

export async function generateStandard(
  options: ResolvedSetup,
  project: ProjectDetection,
): Promise<GeneratedArtifacts> {
  const result =
    options.database === "dynamodb"
      ? generateDynamo(options)
      : options.database === "mongodb"
        ? generateMongoMigration(options, project)
        : generateSql(options, project);
  const models = generateModels(options);
  return {
    files: [...result.files, ...models.files],
    warnings: [...result.warnings, ...models.warnings],
    prerequisites: [...result.prerequisites, ...models.prerequisites],
    nextSteps: [...result.nextSteps, ...models.nextSteps],
  };
}
