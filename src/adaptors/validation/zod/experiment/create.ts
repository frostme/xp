import { uniq } from "es-toolkit/array";
import { sumBy } from "es-toolkit/math";
import { kebabCase } from "es-toolkit/string";
import * as z from "zod";

import { ExperimentNameSchema, ExperimentTypeSchema, CohortNameSchema } from "~/entities";

import { createSchema as cohortCreateSchema } from "../cohort/create";
import ZodValidator from "../validator";

const createSchema = z
  .object({
    name: ExperimentNameSchema.min(5),
    slug: z.string().refine((val) => val === kebabCase(val), {
      message: "String must be in kebab-case",
    }),
    description: z.string(),
    type: ExperimentTypeSchema,
    cohorts: z.array(cohortCreateSchema).min(2, "At least two cohorts are required"),
  })
  .superRefine((data, ctx) => {
    const expectedSlug = kebabCase(data.name);
    if (data.slug !== expectedSlug) {
      ctx.addIssue({
        code: "custom",
        message: `The slug must be the kebab-case version of the name. Expected: ${expectedSlug}`,
        path: ["slug"],
      });
    }

    // cohort percentages must sum to 100
    const totalPercentage = sumBy(data.cohorts, (cohort) => cohort.percentage);
    if (totalPercentage !== 100) {
      ctx.addIssue({
        code: "custom",
        message: `The sum of cohort percentages must equal 100. Current sum: ${totalPercentage}`,
        path: ["cohorts"],
      });
    }

    data.cohorts.forEach((cohort, index) => {
      if (!cohort.slug.startsWith(`${data.slug}_`)) {
        ctx.addIssue({
          code: "custom",
          message: `Cohort slug must start with the experiment slug followed by an underscore. Expected prefix: ${data.slug}_`,
          path: ["cohorts", index, "slug"],
        });
      }

      const cohortName = cohort.slug.split("_")[1];
      if (!CohortNameSchema.safeParse(cohortName).success) {
        ctx.addIssue({
          code: "custom",
          message: `Cohort slug must be of the form \`${data.slug}_<cohort-name>\` where <cohort-name> is either "on", "off", or a kebab-case string.`,
          path: ["cohorts", index, "slug"],
        });
      }
    });

    if (uniq(data.cohorts.map((cohort) => cohort.slug)).length !== data.cohorts.length) {
      ctx.addIssue({
        code: "custom",
        message: "Cohort slugs must be unique within the experiment.",
      });
    }
  });

export default new ZodValidator(createSchema);
