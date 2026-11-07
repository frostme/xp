import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

import type { IDataAccessAdaptor, ICohortDAO, IExperimentDAO, IUserDAO } from "~/interfaces";

import DynamoDBStore from "./store";

export default class DynamoDBAdaptor implements IDataAccessAdaptor {
  public readonly experimentDAO: IExperimentDAO;
  public readonly cohortDAO: ICohortDAO;
  public readonly userDAO: IUserDAO;

  constructor(client: DynamoDBDocumentClient, tableName: string) {
    const store = new DynamoDBStore(client, tableName);
    this.experimentDAO = {
      getById: (id) => store.getExperiment(id),
      findBySlug: (slug) => store.findExperiment(slug),
      list: () => store.listExperiments(),
      create: (input) => store.createExperiment(input),
      update: (id, updates, winnerCohortId) => store.updateExperiment(id, updates, winnerCohortId),
      remove: (id) => store.removeExperiment(id),
    };
    this.cohortDAO = {
      getById: (id) => store.getCohort(id),
      findBySlug: (slug) => store.findCohort(slug),
      getByExperimentId: (id) => store.getCohorts(id),
      create: (input) => store.createCohort(input),
      update: (id, updates) => store.updateCohort(id, updates),
      remove: (id) => store.removeCohort(id),
    };
    this.userDAO = {
      findById: (id) => store.getUser(id),
      findUserCohort: (userId, experimentId) => store.findMembership(userId, experimentId),
      addUserCohort: (userId, experimentId, cohortId) =>
        store.addMembership(userId, experimentId, cohortId),
      removeUserCohort: (userId, experimentId) => store.removeMembership(userId, experimentId),
    };
  }
}
