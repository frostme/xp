import type { Client, Pool, PoolClient } from "pg";

import type { IDataAccessAdaptor } from "~/interfaces";

import { relationalAdaptor, type Row, type SqlSession } from "../relational";
import { serializeClient } from "../serializeClient";

function session(client: Client | PoolClient): SqlSession {
  const query = async (sql: string, values: unknown[] = []): Promise<Row[]> => {
    const result = await client.query(sql, values);
    return result.rows.map((row: Row) =>
      Object.hasOwn(row, "value") ? { ...row, value: JSON.stringify(row["value"] ?? null) } : row,
    );
  };
  return {
    query,
    parameter: (index) => `$${index}`,
    lock: (table, where, values) =>
      query(`SELECT * FROM ${table} WHERE ${where} FOR UPDATE`, values),
    insert: async (table, fields) => {
      const entries = Object.entries(fields);
      const rows = await query(
        `INSERT INTO ${table} (${entries.map(([key]) => key).join(", ")}) VALUES (${entries.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
        entries.map(([, value]) => value),
      );
      return rows[0]!;
    },
  };
}
export default class PostgresAdaptor implements IDataAccessAdaptor {
  userDAO: IDataAccessAdaptor["userDAO"];
  experimentDAO: IDataAccessAdaptor["experimentDAO"];
  cohortDAO: IDataAccessAdaptor["cohortDAO"];
  constructor(client: Client | Pool) {
    const run = async <T>(
      work: (s: SqlSession) => Promise<T>,
      transaction: boolean,
    ): Promise<T> => {
      const execute = async (connection: Client | PoolClient): Promise<T> => {
        if (transaction) await connection.query("BEGIN");
        try {
          const result = await work(session(connection));
          if (transaction) await connection.query("COMMIT");
          return result;
        } catch (error) {
          if (transaction) {
            try {
              await connection.query("ROLLBACK");
            } catch (rollbackError) {
              throw new AggregateError([error, rollbackError], "Transaction and rollback failed", {
                cause: rollbackError,
              });
            }
          }
          throw error;
        }
      };
      if ("totalCount" in client) {
        const connection = await client.connect();
        try {
          return await execute(connection);
        } finally {
          connection.release();
        }
      }
      return serializeClient(client, () => execute(client));
    };
    const adaptor = relationalAdaptor({
      read: (work) => run(work, false),
      transaction: (work) => run(work, true),
    });
    this.userDAO = adaptor.userDAO;
    this.experimentDAO = adaptor.experimentDAO;
    this.cohortDAO = adaptor.cohortDAO;
  }
}
