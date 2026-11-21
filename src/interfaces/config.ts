import type IBucketer from "./bucketer";
import type IDataAccessAdaptor from "./dataAccessAdaptor";
import type { IValidatorAdaptor } from "./validator";
export const SQL_SLUG_LENGTH = { mysql: 191, mssql: 255 } as const;
export type SequelizeDialect = "postgres" | "mysql" | "mssql";

export default interface IConfig {
  dao: IDataAccessAdaptor;
  validation: IValidatorAdaptor;
  bucketer: IBucketer;
}

export interface IConfigGenerator<T> {
  (client: T): IConfig;
}
