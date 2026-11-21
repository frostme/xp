import type { ExperimentDefinition } from "~/entities/rollout";
import type { IExperimentDAO } from "~/interfaces";
import type { SeedReport } from "~/interfaces/runtime";

import { ExperimentSlugConflictError } from "~/errors";

export async function seedExperiments(
  experiments: readonly ExperimentDefinition[],
  dao: IExperimentDAO,
): Promise<SeedReport> {
  const report: SeedReport = { created: [], skipped: [] };
  for (const input of experiments) {
    if (await dao.findBySlug(input.slug)) {
      report.skipped.push(input.slug);
      continue;
    }
    try {
      await dao.create(input);
      report.created.push(input.slug);
    } catch (error) {
      if (!(error instanceof ExperimentSlugConflictError) || error.slug !== input.slug) throw error;
      // A losing creator can observe another declaration of the same slug. An
      // unfinished deletion or partial definition cannot satisfy that claim.
      const stored = await dao.findBySlug(input.slug);
      if (!stored || stored.slug !== input.slug || stored.cohorts.length < 2) throw error;
      report.skipped.push(input.slug);
    }
  }
  return report;
}
