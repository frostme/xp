import type IBucketer from "./bucketer";
import type IDataAccessAdaptor from "./dataAccessAdaptor";
import type { IValidatorAdaptor } from "./validator";
export default interface IConfig {
  dao: IDataAccessAdaptor;
  validation: IValidatorAdaptor;
  bucketer: IBucketer;
}

export interface IConfigGenerator<T> {
  (client: T): IConfig;
}
