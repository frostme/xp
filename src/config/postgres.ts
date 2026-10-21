import type { Client } from "pg";

import type { IConfigGenerator } from "~/interfaces";

import * as bucketers from "~/adaptors/bucketers";
import * as daos from "~/adaptors/data-access";
import ZodValidation from "~/adaptors/validation/zod";

const postgresConfig: IConfigGenerator<Client> = (client) => {
  return {
    dao: new daos.postgres(client),
    validation: ZodValidation,
    bucketer: bucketers.random,
  };
};

export default postgresConfig;
