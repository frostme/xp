import path from "node:path";

import type {
  GeneratedArtifacts,
  GeneratedFile,
  ProjectDetection,
  ResolvedSetup,
} from "~/interfaces/setup";

import { isSql, renderAvailabilityUpgrade } from "../storage";
import { migrationStamp } from "./common";
import { generateDrizzle } from "./drizzle";
import { generateModels } from "./models";
import { prismaBlocks } from "./schema-utils";
import { generateSql } from "./sql";

/** Upgrade only files whose v1 fingerprints have already been verified. */
export async function generateUpgrade(
  options: ResolvedSetup,
  project: ProjectDetection,
  previous: GeneratedFile[],
): Promise<GeneratedArtifacts> {
  if (options.orm === "drizzle") {
    const schema = previous.find(
      (file) =>
        file.purpose === "Drizzle xp table declarations" ||
        file.purpose === "Drizzle schema contribution requiring manual integration",
    );
    if (!schema) throw new Error("Cannot locate the v1 Drizzle xp schema in the setup manifest.");
    return generateDrizzle(options, project, schema.path);
  }
  const generated = generateModels(options);
  for (const model of generated.files) model.merge = true;
  if (options.orm === "prisma") {
    for (const file of previous.filter(
      (file) => file.path.endsWith(".prisma") || file.path.endsWith(".prisma.snippet"),
    )) {
      const block = prismaBlocks(file.content).find(
        (block) => block.kind === "model" && block.name === "XpExperiment",
      );
      if (!block) continue;
      const field =
        options.database === "mssql"
          ? 'Boolean @default(true, map: "experiments_enabled_df")'
          : "Boolean @default(true)";
      const content =
        file.content.slice(0, block.bodyStart) +
        "\n  enabled " +
        field +
        file.content.slice(block.bodyStart);
      generated.files.push({
        ...file,
        content: content.replace("// xp storage schema v1.", "// xp storage schema v2."),
        merge: true,
      });
    }
    if (!generated.files.length)
      throw new Error("Cannot locate the v1 XpExperiment model in the generated Prisma schema.");
    if (isSql(options.database)) {
      generated.files.push({
        path: path.join(
          options.migrationsDir,
          migrationStamp() + "_xp_storage_v2",
          "migration.sql",
        ),
        purpose: "Add experiment availability",
        content: renderAvailabilityUpgrade(options).up.join("\n") + "\n",
      });
      generated.nextSteps.push(
        "Deploy the generated Prisma migration before starting xp, then regenerate your Prisma client.",
      );
    }
  } else if (isSql(options.database)) {
    const migration = generateSql(options, project, true);
    generated.files.push(...migration.files);
    generated.nextSteps.push(...migration.nextSteps);
    generated.prerequisites.push(...migration.prerequisites);
    generated.warnings.push(...migration.warnings);
  }
  if (!isSql(options.database)) {
    generated.nextSteps.push(
      options.database === "mongodb"
        ? "Existing experiments default to enabled. If your application added a collection validator, allow the optional boolean enabled field before deploying xp."
        : "Existing experiments default to enabled. The DynamoDB table and item keys require no changes.",
    );
  }
  return generated;
}
