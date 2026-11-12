import { Client } from "pg";
import { describe, expect, it } from "vitest";

import {
  experimentInput,
  registerStorageContract,
  selectedDatabase,
} from "~/__tests__/storage/contract";
import { setupOptions } from "~/__tests__/storage/setup";
import { renderSql } from "~/adaptors/setup/storage";
import server from "~/server";

import PostgresAdaptor from "..";
import { setupPostgres } from "./fixture";

registerStorageContract("postgres", setupPostgres);

describe.skipIf(selectedDatabase() !== "postgres")("PostgreSQL connection ownership", () => {
  it("keeps a caller-owned pool usable after rollback and successful operations", async () => {
    const fixture = await setupPostgres();
    try {
      const created = await fixture.adaptor.experimentDAO.create(experimentInput());
      const conflicting = experimentInput("rollback-experiment");
      conflicting.cohorts[1]!.slug = created.cohorts[0]!.slug;
      await expect(fixture.adaptor.experimentDAO.create(conflicting)).rejects.toThrow();
      expect((await fixture.pool.query("SELECT 1 AS alive")).rows[0]).toEqual({ alive: 1 });
      expect(fixture.pool.idleCount).toBe(fixture.pool.totalCount);
      expect(await fixture.adaptor.experimentDAO.list()).toHaveLength(1);
      expect(await fixture.adaptor.experimentDAO.findBySlug(conflicting.slug)).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it("serializes concurrent xp operations on an externally owned standalone client", async () => {
    const fixture = await setupPostgres();
    const client = new Client(fixture.connectionConfig);
    await client.connect();
    try {
      const adaptor = new PostgresAdaptor(client);
      const api = server(client);
      const existing = await adaptor.experimentDAO.create(experimentInput());
      const conflicting = experimentInput("client-rollback");
      conflicting.cohorts[1]!.slug = existing.cohorts[0]!.slug;
      const [failed, successful] = await Promise.allSettled([
        adaptor.experimentDAO.create(conflicting),
        api.createExperiment(experimentInput("client-success")),
      ]);
      expect(failed.status).toBe("rejected");
      expect(successful.status).toBe("fulfilled");
      expect(await adaptor.experimentDAO.findBySlug(conflicting.slug)).toBeNull();
      expect(await adaptor.experimentDAO.list()).toHaveLength(2);
      expect((await client.query("SELECT 1 AS alive")).rows[0]).toEqual({ alive: 1 });
    } finally {
      await client.end();
      await fixture.cleanup();
    }
  });
});

describe.skipIf(selectedDatabase() !== "postgres")("generated setup migration", () => {
  it("rolls back xp storage while preserving application users and supports reapplication", async () => {
    const fixture = await setupPostgres();
    try {
      await fixture.seedUser("retained-user");
      const schema = renderSql({ ...setupOptions("postgres"), userStorage: "reuse" });
      for (const statement of schema.down) {
        await fixture.pool.query(statement);
      }
      expect((await fixture.pool.query("SELECT id FROM users")).rows).toEqual([
        { id: "retained-user" },
      ]);
      for (const statement of schema.up) {
        await fixture.pool.query(statement);
      }
      const experiment = await fixture.adaptor.experimentDAO.create(experimentInput());
      expect(experiment.cohorts).toHaveLength(2);
    } finally {
      await fixture.cleanup();
    }
  });
});
