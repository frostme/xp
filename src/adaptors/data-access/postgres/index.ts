import type { Client } from "pg";

import type { IDataAccessAdaptor, IUserDAO } from "~/interfaces";

import CohortDAO from "./cohortDAO";
import ExperimentDAO from "./experimentDAO";
import UserDAO from "./userDAO";

export default class PostgresAdaptor implements IDataAccessAdaptor {
  public userDAO: IUserDAO;
  public experimentDAO: ExperimentDAO;
  public cohortDAO: CohortDAO;
  constructor(protected client: Client) {
    this.userDAO = new UserDAO(client);
    this.experimentDAO = new ExperimentDAO(client);
    this.cohortDAO = new CohortDAO(client);
  }
}
