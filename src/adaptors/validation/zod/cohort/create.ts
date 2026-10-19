import { kebabCase } from "es-toolkit/string";
import * as z from "zod";

import { CohortTypeSchema } from "~/entities";

import ZodValidator from "../validator";

export const createSchema = z.object({
  slug: z.string().refine((val) => val === kebabCase(val), {
    message: "String must be in kebab-case",
  }),
  description: z.string(),
  percentage: z.number().min(0).max(100),
  type: CohortTypeSchema,
});

export default new ZodValidator(createSchema);
