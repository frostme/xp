import dynamodb from "./dynamodb";
import mongodb from "./mongodb";
import mssql from "./mssql";
import mysql from "./mysql";
import postgres from "./postgres";

const config = {
  postgres,
  mysql,
  mssql,
  mongodb,
  dynamodb,
};

export default config;
