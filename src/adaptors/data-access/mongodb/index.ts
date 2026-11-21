import type { MongoClient } from "mongodb";

import type { IDataAccessAdaptor } from "~/interfaces";

import MongoAnalyticsStore from "./analytics";
import MongoCohortDAO from "./cohortDAO";
import MongoExperimentDAO from "./experimentDAO";
import MongoStore from "./store";
import MongoUserDAO from "./userDAO";

export default class MongoDBAdaptor implements IDataAccessAdaptor {
  readonly experimentDAO: MongoExperimentDAO;
  readonly cohortDAO: MongoCohortDAO;
  readonly userDAO: MongoUserDAO;
  readonly analytics: MongoAnalyticsStore;

  constructor(client: MongoClient, databaseName: string) {
    const store = new MongoStore(client, databaseName);
    this.experimentDAO = new MongoExperimentDAO(store);
    this.cohortDAO = new MongoCohortDAO(store);
    this.analytics = new MongoAnalyticsStore(client.db(databaseName));
    this.userDAO = new MongoUserDAO(store, this.analytics);
  }
}
