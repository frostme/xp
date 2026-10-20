import type { Client } from "pg";

import type { IUserDAO } from "~/interfaces";

import UserDAO from "./userDAO";

export default class PostgresAdaptor {
  public userDAO: IUserDAO;
  constructor(protected client: Client) {
    this.userDAO = new UserDAO(client);
  }
}
