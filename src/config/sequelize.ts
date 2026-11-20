import type { Sequelize } from "sequelize";

import type { IConfig } from "~/interfaces";
import type { SequelizeDialect } from "~/interfaces/config";

import { random } from "~/adaptors/bucketers";
import { sequelizeAdaptor } from "~/adaptors/data-access/sequelize";
import ZodValidation from "~/adaptors/validation/zod";

export default function sequelizeConfig(client: Sequelize, dialect: SequelizeDialect): IConfig {
  return {
    dao: sequelizeAdaptor(client, dialect),
    validation: ZodValidation,
    bucketer: random,
  };
}
