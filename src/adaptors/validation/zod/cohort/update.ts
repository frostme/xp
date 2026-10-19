import * as z from "zod";

import ZodValidator from "../validator";

const updateSchema = z.object({
  description: z.string().optional(),
  percentage: z.number().min(0).max(100).optional(),
});

export default new ZodValidator(updateSchema);
