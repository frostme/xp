import * as z from "zod";

import { CohortTypeSchema } from "~/entities";

import ZodValidator from "../validator";

export const createSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*_[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: "Expected <experiment-slug>_<cohort-name>",
  }),
  description: z.string(),
  percentage: z.number().min(0).max(100),
  type: CohortTypeSchema,
  value: z.json().default(null),
});

export default new ZodValidator(createSchema);
