import type { Connection, Pool } from "mysql2/promise";

import type { IConfigGenerator } from "~/interfaces";

import * as bucketers from "~/adaptors/bucketers";
import MysqlAdaptor from "~/adaptors/data-access/mysql";
import ZodValidation from "~/adaptors/validation/zod";
const mysqlConfig: IConfigGenerator<Connection | Pool> = (client) => ({
  dao: new MysqlAdaptor(client),
  validation: ZodValidation,
  bucketer: bucketers.random,
});
export default mysqlConfig;
