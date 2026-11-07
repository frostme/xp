import type { ConnectionPool } from "mssql";

import type { IConfigGenerator } from "~/interfaces";

import { random } from "~/adaptors/bucketers";
import MssqlAdaptor from "~/adaptors/data-access/mssql";
import ZodValidation from "~/adaptors/validation/zod";

const mssqlConfig: IConfigGenerator<ConnectionPool> = (client) => ({
  dao: new MssqlAdaptor(client),
  validation: ZodValidation,
  bucketer: random,
});

export default mssqlConfig;
