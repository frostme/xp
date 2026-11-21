import type { AnalyticsStore } from "./analytics";
import type { ICohortDAO } from "./cohort";
import type { IExperimentDAO } from "./experiment";
import type { IUserDAO } from "./user";

export default interface IDataAccessAdaptor {
  readonly analytics?: AnalyticsStore;
  userDAO: IUserDAO;
  experimentDAO: IExperimentDAO;
  cohortDAO: ICohortDAO;
}
