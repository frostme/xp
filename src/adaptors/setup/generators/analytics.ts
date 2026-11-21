import type {
  GeneratedArtifacts,
  GeneratedFile,
  ProjectDetection,
  ResolvedSetup,
} from "~/interfaces/setup";

import { renderAnalyticsSql } from "../analyticsStorage";
import { generateAnalyticsModels } from "./analytics-models";
import { migrationStamp, outputPath } from "./common";
import { generateAnalyticsIndex } from "./dynamodb";
import { generateMongoMigration } from "./mongodb";
import { extendPrismaAnalytics } from "./prisma";
import { generateSql } from "./sql";

/** Drizzle produces its SQL, snapshots and journal in one staged generation. */
export async function addAnalytics(
  options: ResolvedSetup,
  project: ProjectDetection,
  generated: GeneratedArtifacts,
  previous?: GeneratedFile[],
): Promise<void> {
  const parts: GeneratedArtifacts[] = [generateAnalyticsModels(options)];
  if (options.database === "dynamodb") parts.push(generateAnalyticsIndex(options));
  else if (options.database === "mongodb")
    parts.push(generateMongoMigration(options, project, true));
  else if (options.orm === "prisma") {
    const path = outputPath(
      options.migrationsDir,
      migrationStamp(new Date(Date.now() + 1000)) + "_xp_analytics_v1/migration.sql",
    );
    generated.files.push({
      path,
      purpose: "Prisma analytics outbox v1 migration",
      content: renderAnalyticsSql(options.database).up.join("\n\n") + "\n",
    });
    generated.nextSteps.push(
      "Apply the analytics migration with prisma migrate deploy, then regenerate the client.",
    );
  } else if (options.orm !== "drizzle") parts.push(generateSql(options, project, "analytics"));
  if (options.orm === "prisma" && previous) {
    const staged = new Map(previous.map((file) => [file.path, file]));
    for (const file of generated.files) staged.set(file.path, file);
    parts.push(await extendPrismaAnalytics(options, project, [...staged.values()]));
  }
  for (const part of parts) {
    // A staged schema may receive both the availability field and the analytics models.
    for (const file of part.files) {
      const i = generated.files.findIndex((existing) => existing.path === file.path);
      if (i === -1) {
        // A MikroORM config contribution may be patched only when an earlier setup owns it.
        if (
          file.path === ".xp/mikroorm-schema-options.json" &&
          !previous?.some((entry) => entry.path === file.path)
        )
          file.merge = false;
        generated.files.push(file);
      } else if (file.merge)
        generated.files[i] = { ...file, merge: generated.files[i]!.merge ?? false };
      else throw new Error(`Analytics setup produced a duplicate output: ${file.path}`);
    }
    generated.prerequisites.push(...part.prerequisites);
    generated.warnings.push(...part.warnings);
    generated.nextSteps.push(...part.nextSteps);
  }
  generated.nextSteps = [...new Set(generated.nextSteps)];
}
