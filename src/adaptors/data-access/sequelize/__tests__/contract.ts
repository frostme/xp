import { describe, expect, it } from "vitest";

import type { SequelizeDialect } from "~/interfaces/config";

import { experimentInput, registerStorageContract } from "~/__tests__/storage/contract";

import { setupSequelize } from "./fixture";

export function registerSequelizeContract(dialect: SequelizeDialect) {
  describe(`Sequelize 6 with ${dialect}`, () => {
    registerStorageContract(
      dialect,
      () => setupSequelize(dialect),
      () => setupSequelize(dialect, 1),
    );

    it("keeps the caller's instance usable after rollback and binds quoted Unicode values", async () => {
      const fixture = await setupSequelize(dialect);
      try {
        const { experimentDAO, cohortDAO } = fixture.adaptor;
        const input = experimentInput();
        input.description = "Bannière 🧪 — 'quoted'; $p1";
        input.cohorts[0]!.value = 'JSON string "été" 🧪';
        const original = await experimentDAO.create(input);
        expect(original.description).toBe(input.description);
        expect((await cohortDAO.findBySlug(input.cohorts[0]!.slug))?.value).toBe(
          input.cohorts[0]!.value,
        );

        const failing = experimentInput("failed-create");
        failing.cohorts[1]!.slug = original.cohorts[0]!.slug;
        await expect(experimentDAO.create(failing)).rejects.toThrow();
        expect(await experimentDAO.findBySlug(failing.slug)).toBeNull();
        expect(await cohortDAO.findBySlug(failing.cohorts[0]!.slug)).toBeNull();
        const [rows] = await fixture.startupOptions.connection.query("SELECT 1 AS alive");
        expect(rows).toEqual([{ alive: 1 }]);
      } finally {
        await fixture.cleanup();
      }
    });
  });
}
