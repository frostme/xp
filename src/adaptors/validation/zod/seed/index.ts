import * as z from "zod";

import type { CreationPayload, Experiment } from "~/entities";

import { isSlugPart } from "~/entities/slug";
import { ValidationError } from "~/errors";

const slug = z.string().refine(isSlugPart, "Expected a nonempty kebab-case name");
const declarations = z.strictObject({
  experiments: z.array(z.strictObject({ slug, cohorts: z.array(slug).min(2) })),
});

function formatPath(path: PropertyKey[]) {
  return path.reduce<string>(
    (result, part) => result + (typeof part === "number" ? `[${part}]` : `.${String(part)}`),
    "$",
  );
}

export function parseSeedConfig(
  value: unknown,
  maxInitialCohorts?: number,
): CreationPayload<Experiment>[] {
  const parsed = declarations.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const path = issue.code === "unrecognized_keys" ? [...issue.path, issue.keys[0]!] : issue.path;
    throw new ValidationError(`${formatPath(path)}: ${issue.message}`);
  }

  const seen = new Set<string>();
  return parsed.data.experiments.map(({ slug: experimentSlug, cohorts }, index) => {
    const path = `$.experiments[${index}]`;
    if (seen.has(experimentSlug))
      throw new ValidationError(`${path}.slug: Duplicate experiment '${experimentSlug}'`);
    seen.add(experimentSlug);
    if (maxInitialCohorts !== undefined && cohorts.length > maxInitialCohorts) {
      throw new ValidationError(
        `${path}.cohorts: DynamoDB supports at most ${maxInitialCohorts} initial cohorts`,
      );
    }
    const localNames = new Set<string>();
    const share = 100 / cohorts.length;
    let allocated = 0;
    const storedCohorts = cohorts.map((name, cohortIndex) => {
      if (localNames.has(name)) {
        throw new ValidationError(
          `${path}.cohorts[${cohortIndex}]: Duplicate local name '${name}'`,
        );
      }
      localNames.add(name);
      const percentage = cohortIndex === cohorts.length - 1 ? 100 - allocated : share;
      allocated += percentage;
      return {
        slug: `${experimentSlug}_${name}`,
        description: "",
        value: null,
        type: cohortIndex === 0 ? "control" : "treatment",
        percentage,
      };
    });

    const type =
      cohorts.length > 2
        ? "multivariate"
        : localNames.has("off") && localNames.has("on")
          ? "flag"
          : "simple";
    const name =
      experimentSlug.charAt(0).toUpperCase() + experimentSlug.slice(1).replaceAll("-", " ");
    // Storage accepts the canonical names validated above, including short display names.
    return {
      slug: experimentSlug,
      name,
      description: "",
      type,
      cohorts: storedCohorts,
    } as CreationPayload<Experiment>;
  });
}
