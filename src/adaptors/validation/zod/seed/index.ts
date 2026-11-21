import * as z from "zod";

import type { ExperimentDefinition } from "~/entities/rollout";
import type { SetupDatabase } from "~/interfaces/setup";

import { isSlugPart } from "~/entities/slug";
import { ValidationError } from "~/errors";
import { SQL_SLUG_LENGTH } from "~/interfaces/config";

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
  database?: SetupDatabase,
): ExperimentDefinition {
  const { slug: experimentSlug, rollout } = input;
  const managed = rollout === "off-first";
  const maxLength =
    database === "mysql" || database === "mssql" ? SQL_SLUG_LENGTH[database] : undefined;
  if (maxLength !== undefined && experimentSlug.length + (managed ? 4 : 0) > maxLength)
    invalid(
      `${path}.slug`,
      managed
        ? `The experiment slug plus "_off" must fit in ${maxLength} characters.`
        : `The experiment slug must fit in ${maxLength} characters.`,
    );
  const names = new Set<string>();
  for (const [index, name] of input.cohorts.entries()) {
    if (names.has(name)) invalid(`${path}.cohorts[${index}]`, `Duplicate local name '${name}'`);
    if (maxLength !== undefined && experimentSlug.length + 1 + name.length > maxLength)
      invalid(
        `${path}.cohorts[${index}]`,
        `The qualified cohort slug must fit in ${maxLength} characters.`,
      );
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
  if (database === "dynamodb" && cohorts.length > 32)
    invalid(`${path}.cohorts`, "DynamoDB supports at most 32 initial cohorts");

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

export function parseManagedDefinition(input: unknown, database?: SetupDatabase) {
  const values = parse(definition, input);
  return normalize({ ...values, rollout: "off-first" }, "$", database);
}

export function parseSeedConfig(value: unknown, database?: SetupDatabase) {
  const parsed = parse(config, value);
  const seen = new Set<string>();
  const experiments = parsed.experiments.map((input, index) => {
    const path = `$.experiments[${index}]`;
    if (seen.has(input.slug)) invalid(`${path}.slug`, `Duplicate experiment '${input.slug}'`);
    seen.add(input.slug);
    return normalize(input, path, database);
  });
  return { allowCreate: parsed.management?.allowCreate ?? false, experiments };
}
