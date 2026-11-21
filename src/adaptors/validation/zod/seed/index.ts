import * as z from "zod";

import type { ExperimentDefinition } from "~/entities/rollout";

import { isSlugPart } from "~/entities/slug";
import { ValidationError } from "~/errors";

const slug = z.string().refine(isSlugPart, "Expected a nonempty kebab-case name");
const definition = z.strictObject({ slug, cohorts: z.array(slug).min(1) });
const declaration = definition.extend({ rollout: z.literal("off-first").optional() });
const config = z.strictObject({
  management: z.strictObject({ allowCreate: z.boolean().optional() }).optional(),
  experiments: z.array(declaration),
});

function invalid(field: string, message: string): never {
  throw new ValidationError(`${field}: ${message}`, [{ field, message }]);
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0]!;
  const parts = issue.code === "unrecognized_keys" ? [...issue.path, issue.keys[0]!] : issue.path;
  const path = parts.reduce<string>(
    (result, part) => result + (typeof part === "number" ? `[${part}]` : `.${String(part)}`),
    "$",
  );
  return invalid(path, issue.message);
}

function normalize(
  input: z.output<typeof declaration>,
  path: string,
  maxInitialCohorts?: number,
): ExperimentDefinition {
  const { slug: experimentSlug, rollout } = input;
  const managed = rollout === "off-first";
  const names = new Set<string>();
  for (const [index, name] of input.cohorts.entries()) {
    if (names.has(name)) invalid(`${path}.cohorts[${index}]`, `Duplicate local name '${name}'`);
    names.add(name);
  }
  const cohorts = managed
    ? ["off", ...input.cohorts.filter((name) => name !== "off")]
    : input.cohorts;
  if (cohorts.length < 2)
    invalid(
      `${path}.cohorts`,
      managed ? "Supply at least one treatment" : "Supply at least two cohorts",
    );
  if (maxInitialCohorts !== undefined && cohorts.length > maxInitialCohorts)
    invalid(`${path}.cohorts`, `DynamoDB supports at most ${maxInitialCohorts} initial cohorts`);

  let allocated = 0;
  const storedCohorts = cohorts.map((name, index) => {
    const uniform = index === cohorts.length - 1 ? 100 - allocated : 100 / cohorts.length;
    const percentage = managed ? (index === 0 ? 100 : 0) : uniform;
    allocated += percentage;
    return {
      slug: `${experimentSlug}_${name}`,
      description: "",
      value: null,
      type: index === 0 ? "control" : "treatment",
      percentage,
    };
  });
  const type =
    cohorts.length > 2
      ? "multivariate"
      : cohorts.includes("off") && cohorts.includes("on")
        ? "flag"
        : "simple";
  return {
    slug: experimentSlug,
    name: experimentSlug.charAt(0).toUpperCase() + experimentSlug.slice(1).replaceAll("-", " "),
    description: "",
    type,
    cohorts: storedCohorts,
    ...(managed ? { rollout } : {}),
  } as ExperimentDefinition;
}

export function parseManagedDefinition(input: unknown, maxInitialCohorts?: number) {
  const values = parse(definition, input);
  return normalize({ ...values, rollout: "off-first" }, "$", maxInitialCohorts);
}

export function parseSeedConfig(value: unknown, maxInitialCohorts?: number) {
  const parsed = parse(config, value);
  const seen = new Set<string>();
  const experiments = parsed.experiments.map((input, index) => {
    const path = `$.experiments[${index}]`;
    if (seen.has(input.slug)) invalid(`${path}.slug`, `Duplicate experiment '${input.slug}'`);
    seen.add(input.slug);
    return normalize(input, path, maxInitialCohorts);
  });
  return { allowCreate: parsed.management?.allowCreate ?? false, experiments };
}
