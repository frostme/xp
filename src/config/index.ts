import dynamodb from "./dynamodb";
import mongodb from "./mongodb";
import mssql from "./mssql";
import mysql from "./mysql";
import postgres from "./postgres";
import sequelize from "./sequelize";

const config = {
  sequelize,
  postgres,
  mysql,
  mssql,
  mongodb,
  dynamodb,
};

export default config;
