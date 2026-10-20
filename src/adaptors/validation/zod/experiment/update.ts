import * as z from "zod";

import ZodValidator from "../validator";

const updateSchema = z.object({
  name: z.string().min(5).optional(),
  description: z.string().optional(),
});

export default new ZodValidator(updateSchema);
