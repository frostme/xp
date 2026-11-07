import type { ConnectionPool, Transaction } from "mssql";

import type { IDataAccessAdaptor } from "~/interfaces";

import { loadDriver } from "../optionalDriver";
import { relationalAdaptor, type Row, type SqlSession } from "../relational";

type Driver = typeof import("mssql");

function session(connection: ConnectionPool | Transaction, sql: Driver): SqlSession {
  const parameter = (index: number) => `@p${index}`;
  const query = async (statement: string, values: unknown[] = []): Promise<Row[]> => {
    const request = connection.request();
    values.forEach((value, index) => {
      const name = `p${index + 1}`;
      if (typeof value === "number") {
        const type =
          Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647
            ? sql.Int
            : sql.Float;
        request.input(name, type, value);
      } else if (typeof value === "boolean") {
        request.input(name, sql.Bit, value);
      } else {
        request.input(name, sql.NVarChar(sql.MAX), value ?? null);
      }
    });
    const result = await request.query<Row>(statement);
    return result.recordset ?? [];
  };
  return {
    query,
    parameter,
    lock: (table, where, values) =>
      query(`SELECT * FROM ${table} WITH (UPDLOCK, HOLDLOCK) WHERE ${where}`, values),
    insert: async (table, fields) => {
      const entries = Object.entries(fields);
      const rows = await query(
        `INSERT INTO ${table} (${entries.map(([key]) => `[${key}]`).join(", ")}) OUTPUT INSERTED.* VALUES (${entries.map((_, index) => parameter(index + 1)).join(", ")})`,
        entries.map(([, value]) => value),
      );
      return rows[0]!;
    },
  };
}

export default class MssqlAdaptor implements IDataAccessAdaptor {
  userDAO: IDataAccessAdaptor["userDAO"];
  experimentDAO: IDataAccessAdaptor["experimentDAO"];
  cohortDAO: IDataAccessAdaptor["cohortDAO"];

  constructor(pool: ConnectionPool) {
    const sql = loadDriver<Driver>("mssql");
    const adaptor = relationalAdaptor({
      read: (work) => work(session(pool, sql)),
      transaction: async (work) => {
        const transaction = new sql.Transaction(pool);
        let rolledBack = false;
        transaction.on("rollback", () => {
          rolledBack = true;
        });
        await transaction.begin();
        try {
          const result = await work(session(transaction, sql));
          await transaction.commit();
          return result;
        } catch (error) {
          if (!rolledBack) {
            try {
              await transaction.rollback();
            } catch (rollbackError) {
              throw new AggregateError([error, rollbackError], "Transaction and rollback failed", {
                cause: rollbackError,
              });
            }
          }
          throw error;
        }
      },
    });
    this.userDAO = adaptor.userDAO;
    this.experimentDAO = adaptor.experimentDAO;
    this.cohortDAO = adaptor.cohortDAO;
  }
}
