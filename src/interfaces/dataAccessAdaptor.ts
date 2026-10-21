import type { ICohortDAO } from "./cohort";
import type { IExperimentDAO } from "./experiment";
import type { IUserDAO } from "./user";

export default interface IDataAccessAdaptor {
  userDAO: IUserDAO;
  experimentDAO: IExperimentDAO;
  cohortDAO: ICohortDAO;
}
