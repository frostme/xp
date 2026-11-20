import { localSlugPattern } from "~/entities/slug";
import { ValidationError } from "~/errors";

export function validateExperimentSlug(value: unknown): string {
  if (typeof value !== "string" || !localSlugPattern.test(value)) {
    throw new ValidationError("Expected a nonempty kebab-case experiment slug");
  }
  return value;
}
