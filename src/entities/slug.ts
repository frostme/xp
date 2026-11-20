/** Experiment slugs and the local part of cohort slugs share this grammar. */
export function isSlugPart(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}
