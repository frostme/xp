import { createConnection } from "mysql2/promise";
import { describe, expect, it } from "vitest";

import {
  experimentInput,
  registerStorageContract,
  selectedDatabase,
} from "~/__tests__/storage/contract";
import server from "~/server";

import MysqlAdaptor from "..";
import { setupMysql } from "./fixture";

registerStorageContract("mysql", setupMysql);

describe.skipIf(selectedDatabase() !== "mysql")("MySQL connection ownership and JSON", () => {
  it("releases its only pool connection after both rollback and success", async () => {
    const fixture = await setupMysql({ connectionLimit: 1 });
    try {
      const created = await fixture.adaptor.experimentDAO.create(experimentInput());
      const conflicting = experimentInput("rollback-experiment");
      conflicting.cohorts[1]!.slug = created.cohorts[0]!.slug;
      await expect(fixture.adaptor.experimentDAO.create(conflicting)).rejects.toThrow();
      const [rows] = await fixture.pool.query("SELECT 1 AS alive");
      expect(rows).toEqual([{ alive: 1 }]);
      expect(await fixture.adaptor.experimentDAO.list()).toHaveLength(1);
      expect(await fixture.adaptor.experimentDAO.findBySlug(conflicting.slug)).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it("serializes operations across xp instances sharing a standalone connection", async () => {
    const fixture = await setupMysql();
    const connection = await createConnection(fixture.connectionConfig);
    try {
      const adaptor = new MysqlAdaptor(connection);
      const api = server(connection);
      const existing = await adaptor.experimentDAO.create(experimentInput());
      const conflicting = experimentInput("connection-rollback");
      conflicting.cohorts[1]!.slug = existing.cohorts[0]!.slug;
      const [failed, successful] = await Promise.allSettled([
        adaptor.experimentDAO.create(conflicting),
        api.createExperiment(experimentInput("connection-success")),
      ]);
      expect(failed.status).toBe("rejected");
      expect(successful.status).toBe("fulfilled");
      expect(await adaptor.experimentDAO.findBySlug(conflicting.slug)).toBeNull();
      expect(await adaptor.experimentDAO.list()).toHaveLength(2);
      const [rows] = await connection.query("SELECT 1 AS alive");
      expect(rows).toEqual([{ alive: 1 }]);
    } finally {
      await connection.end();
      await fixture.cleanup();
    }
  });

  it("preserves JSON scalars and objects when mysql2 jsonStrings is enabled", async () => {
    const fixture = await setupMysql({ jsonStrings: true });
    try {
      const input = experimentInput();
      input.cohorts[0]!.value = '{"looks":"like JSON"}';
      input.cohorts[1]!.value = { id: "value-id", nested: [false, 0, null, "text"] };
      const created = await fixture.adaptor.experimentDAO.create(input);
      const loaded = await fixture.adaptor.experimentDAO.getById(created.id);
      expect(loaded.cohorts.map((cohort) => cohort.value)).toEqual(
        input.cohorts.map((cohort) => cohort.value),
      );
      expect((await fixture.adaptor.cohortDAO.getById(created.cohorts[0]!.id)).value).toBe(
        input.cohorts[0]!.value,
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
