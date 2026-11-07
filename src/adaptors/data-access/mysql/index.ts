import type {
  Connection,
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";

import type { IDataAccessAdaptor } from "~/interfaces";

import { relationalAdaptor, type Row, type SqlSession } from "../relational";
import { serializeClient } from "../serializeClient";

function parameterValue(value: unknown): string | number | boolean | null {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return value;
  throw new TypeError("Unsupported SQL parameter");
}

function session(client: Connection | PoolConnection): SqlSession {
  const query = async (sql: string, values: unknown[] = []): Promise<Row[]> => {
    // Explicit JSON text avoids ambiguity with JSON scalar strings.
    const statement = sql.replace(
      /SELECT \* FROM cohorts/g,
      "SELECT id, experiment_id, slug, description, percentage, type, CAST(value AS CHAR) AS value FROM cohorts",
    );
    const [result] = await client.execute<RowDataPacket[]>(statement, values.map(parameterValue));
    return Array.isArray(result) ? result : [];
  };
  return {
    query,
    parameter: () => "?",
    lock: (table, where, values) =>
      query(`SELECT * FROM ${table} WHERE ${where} FOR UPDATE`, values),
    insert: async (table, fields) => {
      const entries = Object.entries(fields);
      const [result] = await client.execute<ResultSetHeader>(
        `INSERT INTO ${table} (${entries.map(([key]) => `\`${key}\``).join(", ")}) VALUES (${entries.map(() => "?").join(", ")})`,
        entries.map(([, value]) => parameterValue(value)),
      );
      return (await query(`SELECT * FROM ${table} WHERE id = ?`, [result.insertId]))[0]!;
    },
  };
}
export default class MysqlAdaptor implements IDataAccessAdaptor {
  userDAO: IDataAccessAdaptor["userDAO"];
  experimentDAO: IDataAccessAdaptor["experimentDAO"];
  cohortDAO: IDataAccessAdaptor["cohortDAO"];
  constructor(client: Connection | Pool) {
    const run = async <T>(
      work: (s: SqlSession) => Promise<T>,
      transaction: boolean,
    ): Promise<T> => {
      const execute = async (connection: Connection | PoolConnection): Promise<T> => {
        if (transaction) await connection.beginTransaction();
        try {
          const result = await work(session(connection));
          if (transaction) await connection.commit();
          return result;
        } catch (error) {
          if (transaction) {
            try {
              await connection.rollback();
            } catch (rollbackError) {
              throw new AggregateError([error, rollbackError], "Transaction and rollback failed", {
                cause: rollbackError,
              });
            }
          }
          throw error;
        }
      };
      if ("getConnection" in client) {
        const connection = await client.getConnection();
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
