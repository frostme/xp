import { describe, expect, it } from "vitest";

import {
  experimentInput,
  registerStorageContract,
  selectedDatabase,
} from "~/__tests__/storage/contract";

import { setupMssql } from "./fixture";

registerStorageContract("mssql", setupMssql);

describe.skipIf(selectedDatabase() !== "mssql")("SQL Server connection ownership", () => {
  it("rolls back a failed create and returns the transaction connection to the caller's pool", async () => {
    const fixture = await setupMssql();
    try {
      const existing = await fixture.adaptor.experimentDAO.create(experimentInput());
      const failing = experimentInput("failed-experiment");
      failing.cohorts[1]!.slug = existing.cohorts[0]!.slug;
      await expect(fixture.adaptor.experimentDAO.create(failing)).rejects.toThrow();
      expect(await fixture.adaptor.experimentDAO.findBySlug(failing.slug)).toBeNull();
      expect(await fixture.adaptor.cohortDAO.findBySlug(failing.cohorts[0]!.slug)).toBeNull();
      expect(fixture.pool.borrowed).toBe(0);
      expect((await fixture.pool.request().query("SELECT 1 AS alive")).recordset).toEqual([
        { alive: 1 },
      ]);
      const created = await fixture.adaptor.experimentDAO.create(
        experimentInput("recovered-experiment"),
      );
      expect(created.cohorts).toHaveLength(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it("stores quoted Unicode text and decimal percentages using bound parameters", async () => {
    const fixture = await setupMssql();
    try {
      const input = experimentInput();
      input.description = "Unicode 🧪 'quotes'; -- @p1";
      input.cohorts[0]!.percentage = 12.5;
      input.cohorts[1]!.percentage = 87.5;
      input.cohorts[0]!.value = 'JSON string "quoted" 🧪';
      const created = await fixture.adaptor.experimentDAO.create(input);
      expect(created.description).toBe(input.description);
      const control = created.cohorts.find((cohort) => cohort.type === "control")!;
      expect(control.percentage).toBe(12.5);
      expect(control.value).toBe(input.cohorts[0]!.value);
      await fixture.adaptor.experimentDAO.update(created.id, {
        description: "Updated 'description' 🧪",
      });
      expect((await fixture.adaptor.experimentDAO.getById(created.id)).description).toBe(
        "Updated 'description' 🧪",
      );
    } finally {
      await fixture.cleanup();
    }
  });
});
