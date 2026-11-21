import path from "node:path";

import type {
  GeneratedArtifacts,
  GeneratedFile,
  ProjectDetection,
  ResolvedSetup,
} from "~/interfaces/setup";

import { isSql, renderStorageUpgrade } from "../storage";
import { migrationStamp } from "./common";
import { generateDrizzle } from "./drizzle";
import { generateModels } from "./models";
import { prismaRolloutFields } from "./prisma";
import { maskComments, prismaBlocks } from "./schema-utils";
import { generateSql } from "./sql";

/** Upgrade only files whose recorded fingerprints have already been verified. */
export async function generateUpgrade(
  options: ResolvedSetup,
  project: ProjectDetection,
  previous: GeneratedFile[],
  fromVersion: number,
): Promise<GeneratedArtifacts> {
  if (options.orm === "drizzle") {
    const schema = previous.find(
      (file) =>
        file.purpose === "Drizzle xp table declarations" ||
        file.purpose === "Drizzle schema contribution requiring manual integration",
    );
    if (!schema) throw new Error("Cannot locate the Drizzle xp schema in the setup manifest.");
    return generateDrizzle(options, project, { path: schema.path, fromVersion });
  }
  const generated = generateModels(options);
  for (const model of generated.files) model.merge = true;
  if (options.orm === "prisma") {
    let foundExperiment = false;
    for (const file of previous.filter(
      (file) => file.path.endsWith(".prisma") || file.path.endsWith(".prisma.snippet"),
    )) {
      const block = prismaBlocks(file.content).find(
        (block) => block.kind === "model" && block.name === "XpExperiment",
      );
      if (!block) continue;
      const body = maskComments(block.body);
      const conflictingField =
        /^\s*(?:rolloutPhase|rolloutRevision|rollout_phase|rollout_revision)\s|@map\s*\(\s*"(?:rollout_phase|rollout_revision)"\s*\)/m.test(
          body,
        );
      if (
        foundExperiment ||
        conflictingField ||
        !/@@map\s*\(\s*"experiments"\s*\)/.test(body) ||
        (fromVersion === 1 && /^\s*enabled\s|@map\s*\(\s*"enabled"\s*\)/m.test(body))
      ) {
        throw new Error(
          `Cannot add rollout fields to the existing XpExperiment definition in ${file.path}. Reconcile its field and table mappings before upgrading.`,
        );
      }
      foundExperiment = true;
      const field =
        options.database === "mssql"
          ? 'Boolean @default(true, map: "experiments_enabled_df")'
          : "Boolean @default(true)";
      const datasource = /@([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z]/.exec(body)?.[1];
      const additions =
        (fromVersion === 1 ? "  enabled " + field + "\n" : "") +
        prismaRolloutFields(options.database, datasource);
      const content =
        file.content.slice(0, block.bodyStart) +
        "\n" +
        additions +
        file.content.slice(block.bodyStart);
      generated.files.push({
        ...file,
        content: content.replace(
          `// xp storage schema v${fromVersion}.`,
          "// xp storage schema v3.",
        ),
        merge: true,
      });
    }
    if (!foundExperiment)
      throw new Error("Cannot locate the XpExperiment model in the generated Prisma schema.");
    if (isSql(options.database)) {
      generated.files.push({
        path: path.join(
          options.migrationsDir,
          migrationStamp() + "_xp_storage_v3",
          "migration.sql",
        ),
        purpose: "Upgrade xp experiment storage to v3",
        content: renderStorageUpgrade(options, fromVersion).up.join("\n") + "\n",
      });
      generated.nextSteps.push(
        "Deploy the generated Prisma migration before starting xp, then regenerate your Prisma client.",
      );
    }
  } else if (isSql(options.database)) {
    const migration = generateSql(options, project, fromVersion);
    generated.files.push(...migration.files);
    generated.nextSteps.push(...migration.nextSteps);
    generated.prerequisites.push(...migration.prerequisites);
    generated.warnings.push(...migration.warnings);
  }
  if (!isSql(options.database)) {
    generated.nextSteps.push(
      options.database === "mongodb"
        ? "Allow the optional enabled boolean, rollout_phase string and rollout_revision integer in host collection validators. Existing documents need no backfill."
        : "DynamoDB stores rollout_phase and rollout_revision as attributes on the experiment parent. The table and item keys need no migration.",
    );
  }
  return generated;
}
