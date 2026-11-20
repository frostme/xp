import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CohortRuntime } from "~/interfaces/runtime";

import { parseSeedConfig } from "~/adaptors/validation/zod/seed";
import { ExperimentSlugConflictError, NotFoundError, ValidationError } from "~/errors";
import { ExperimentNotFoundError } from "~/errors/experimentNotFoundError";
import { seedExperiments } from "~/use-cases/experiment/seed";
import GetGroup from "~/use-cases/user/getGroup";

import { readSeedConfig } from "../readSeedConfig";
import { readIdentity, validateExperimentSlug } from "../request";
import { createRuntimeSelector } from "../runtimeSelector";

const flag = { slug: "cta", cohorts: ["off", "on"] };
const names = (count: number) => Array.from({ length: count }, (_, index) => `choice-${index}`);

describe("seed configuration", () => {
  it.each([
    [{ slug: "", cohorts: ["aa", "bb"] }, "$.experiments[0].slug"],
    [{ ...flag, cohorts: ["a"] }, "$.experiments[0].cohorts"],
    [{ ...flag, cohorts: ["off", "cta_on"] }, "$.experiments[0].cohorts[1]"],
    [{ ...flag, cohorts: ["off", ""] }, "$.experiments[0].cohorts[1]"],
    [{ ...flag, cohorts: ["a", "a"] }, "$.experiments[0].cohorts[1]"],
    [{ ...flag, enabled: false }, "$.experiments[0].enabled"],
  ])("reports the failing field in %j", (entry, path) => {
    expect(() => parseSeedConfig({ experiments: [entry] })).toThrow(path as string);
  });

  it("validates top-level keys, repeated declarations, and the provider's limit", () => {
    expect(() => parseSeedConfig({ experiments: [], credentials: {} })).toThrow("$.credentials");
    expect(() => parseSeedConfig({ experiments: [flag, flag] })).toThrow("$.experiments[1].slug");
    const config = { experiments: [flag, { slug: "many", cohorts: names(33) }] };
    expect(() => parseSeedConfig(config, 32)).toThrow("$.experiments[1].cohorts");
    expect(parseSeedConfig(config)[1]!.cohorts).toHaveLength(33);
  });

  it("derives metadata and stores seven equal shares with the rounding remainder on the last", () => {
    const [cta, reverse, simple, many] = parseSeedConfig({
      experiments: [
        flag,
        { slug: "reverse", cohorts: ["on", "off"] },
        { slug: "delivery-copy", cohorts: ["control", "short"] },
        { slug: "many", cohorts: names(7) },
      ],
    });
    expect(cta).toMatchObject({
      name: "Cta",
      slug: "cta",
      description: "",
      type: "flag",
      cohorts: [
        { slug: "cta_off", type: "control", value: null, description: "", percentage: 50 },
        { slug: "cta_on", type: "treatment", value: null, description: "", percentage: 50 },
      ],
    });
    expect(reverse?.type).toBe("flag");
    expect(simple).toMatchObject({ type: "simple", name: "Delivery copy" });
    expect(many?.type).toBe("multivariate");
    expect(many!.cohorts.reduce((total, cohort) => total + cohort.percentage, 0)).toBe(100);
    for (const cohort of many!.cohorts) expect(cohort.percentage).toBeCloseTo(100 / 7);
  });

  it("only accepts a duplicate parent-slug claim confirmed by a complete live read", async () => {
    const input = parseSeedConfig({ experiments: [flag] });
    const error = new ExperimentSlugConflictError("cta");
    const dao = { findBySlug: vi.fn(), create: vi.fn() };
    const attempt = async (failure: Error, stored: unknown) => {
      dao.findBySlug.mockResolvedValueOnce(null).mockResolvedValueOnce(stored);
      dao.create.mockRejectedValueOnce(failure);
      return seedExperiments(input, dao as never);
    };
    await expect(attempt(error, input[0])).resolves.toEqual({ created: [], skipped: ["cta"] });
    await expect(attempt(error, null)).rejects.toBe(error);
    await expect(attempt(error, { ...input[0], cohorts: [] })).rejects.toBe(error);
    dao.findBySlug.mockResolvedValue(null);
    dao.create.mockRejectedValue(new ExperimentSlugConflictError("other"));
    await expect(seedExperiments(input, dao as never)).rejects.toThrow();
    const outage = new Error("storage unavailable");
    dao.create.mockRejectedValue(outage);
    await expect(seedExperiments(input, dao as never)).rejects.toBe(outage);
  });
});

describe("startup file selection", () => {
  let cwd: string;
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), "xp-config-"));
  });
  afterEach(async () => {
    await rm(cwd, { force: true, recursive: true });
  });

  it("distinguishes an absent conventional config from an explicitly requested file", async () => {
    await expect(readSeedConfig(cwd, undefined)).resolves.toEqual([]);
    await expect(readSeedConfig(cwd, "custom.json")).rejects.toThrow(join(cwd, "custom.json"));
    await writeFile(join(cwd, "custom.json"), '{"experiments":[]}');
    await expect(readSeedConfig(cwd, "custom.json")).resolves.toEqual([]);
    await writeFile(join(cwd, "xp.config.json"), "{!!");
    await expect(readSeedConfig(cwd, undefined)).rejects.toThrow(join(cwd, "xp.config.json"));
  });
});

describe("host runtime and identity selection", () => {
  const pg: CohortRuntime = { driverKind: "postgres", resolveCohort: vi.fn() };
  const orm: CohortRuntime = { driverKind: "sequelize", dialect: "mysql", resolveCohort: vi.fn() };

  it("keeps registrations request-local, honors explicit overrides and validates driver hints", () => {
    const select = createRuntimeSelector();
    expect(select(orm)).toBe(orm);
    expect(select(pg)).toBe(pg);
    expect(() => select(undefined)).toThrow("initializeXp");
    expect(createRuntimeSelector({ connection: orm })(pg)).toBe(orm);
    const selectOrm = createRuntimeSelector({ connection: "sequelize" });
    expect(selectOrm(orm)).toBe(orm);
    expect(() => selectOrm(pg)).toThrow("sequelize");
    expect(() => createRuntimeSelector({ connection: {} })).toThrow("Unsupported database client");
  });

  it("uses only the selected identity source, preserving finite numbers and resolver errors", async () => {
    const header = vi.fn(() => "proxy-id"),
      fallback = vi.fn(() => "host-id");
    await expect(
      readIdentity({}, { userId: async () => 0, header: "trusted" }, header, fallback),
    ).resolves.toBe(0);
    await expect(
      readIdentity({}, { userId: async () => undefined, header: "trusted" }, header, fallback),
    ).resolves.toBeNull();
    expect(header).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
    await expect(readIdentity({}, { header: "trusted" }, header, fallback)).resolves.toBe(
      "proxy-id",
    );
    expect(header).toHaveBeenCalledWith("trusted");
    await expect(readIdentity({}, {}, header, fallback)).resolves.toBe("host-id");
    await expect(
      readIdentity(
        {},
        {
          userId: () => {
            throw new Error("bad resolver");
          },
        },
        header,
        fallback,
      ),
    ).rejects.toThrow("bad resolver");
  });

  it("validates first and scopes guest fallback to the authenticated user lookup", async () => {
    expect(() => validateExperimentSlug("A B")).toThrow(ValidationError);
    const users = { findById: vi.fn(), findUserCohort: vi.fn() };
    const experiments = { findBySlug: vi.fn() };
    const cohorts = { getById: vi.fn() };
    const groups = new GetGroup(users as never, experiments as never, cohorts as never, vi.fn());
    await expect(groups.resolveCohort(null, " not-a-slug")).rejects.toThrow(ValidationError);
    for (const id of [null, undefined, " ", Infinity, NaN]) {
      await expect(groups.resolveCohort(id, "cta")).resolves.toEqual({ slug: null });
    }
    expect(users.findById).not.toHaveBeenCalled();
    users.findById.mockRejectedValueOnce(new NotFoundError());
    await expect(groups.resolveCohort("missing", "cta")).resolves.toEqual({ slug: null });
    expect(experiments.findBySlug).not.toHaveBeenCalled();
    users.findById.mockResolvedValue({ id: 0 });
    experiments.findBySlug.mockResolvedValueOnce(null);
    await expect(groups.resolveCohort(0, "cta")).rejects.toThrow(ExperimentNotFoundError);
    expect(users.findById).toHaveBeenLastCalledWith(0);
    experiments.findBySlug.mockResolvedValue({ id: 1, enabled: true, slug: "cta", type: "simple" });
    users.findUserCohort.mockResolvedValue({ cohort_id: 99 });
    const broken = new NotFoundError("Dangling cohort reference");
    cohorts.getById.mockRejectedValue(broken);
    await expect(groups.resolveCohort(0, "cta")).rejects.toBe(broken);
    cohorts.getById.mockResolvedValue({ slug: "cta_off" });
    await expect(groups.resolveCohort(0, "cta")).resolves.toEqual({ slug: "cta_off" });
  });
});
