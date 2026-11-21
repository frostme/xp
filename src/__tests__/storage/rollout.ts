import { describe, expect, it } from "vitest";

import type { PKey, UserCohort } from "~/entities";
import type { IUserDAO } from "~/interfaces";
import type { RolloutCommand } from "~/use-cases/experiment/rollout";

import { parseManagedDefinition } from "~/adaptors/validation/zod/seed";
import { RolloutConflictError } from "~/errors/rolloutConflictError";
import server from "~/server";
import { GetGroup } from "~/use-cases";

import type { StorageFixture } from "./contract";

const slug = "checkout-copy";
const off = slug + "_off";
const short = slug + "_short";
const detailed = slug + "_detailed";
const alice = "alice" as PKey<"User">;
const bob = "bob" as PKey<"User">;

function split(type: "launch" | "adjust", offShare: number, shortShare: number): RolloutCommand {
  return {
    type,
    allocation: [
      { cohort: off, percentage: offShare },
      { cohort: short, percentage: shortShare },
      { cohort: detailed, percentage: 100 - offShare - shortShare },
    ],
  };
}

async function setup(fixture: StorageFixture) {
  const { connection, ...options } = fixture.startupOptions;
  const runtime = server(connection, { ...options, random: () => 0 });
  const experiment = await fixture.adaptor.experimentDAO.create(
    parseManagedDefinition({ slug, cohorts: ["short", "detailed"] }),
  );
  await fixture.seedUser(alice);
  await fixture.seedUser(bob);
  return {
    runtime,
    experiment,
    apply: (revision: number, command: RolloutCommand) =>
      runtime.management.apply(slug, revision, command),
    stored: (user: PKey<"User">) => fixture.adaptor.userDAO.findUserCohort(user, experiment.id),
  };
}

/** Put the competing command precisely between sampling a cohort and attempting its insert. */
function interceptInsert(
  fixture: StorageFixture,
  before: () => Promise<void>,
  committed: UserCohort[],
  draw = 0,
) {
  const { userDAO, experimentDAO, cohortDAO } = fixture.adaptor;
  const users: IUserDAO = {
    findById: userDAO.findById.bind(userDAO),
    findUserCohort: userDAO.findUserCohort.bind(userDAO),
    removeUserCohort: userDAO.removeUserCohort.bind(userDAO),
    async addUserCohort(...args) {
      await before();
      const membership = await userDAO.addUserCohort(...args);
      committed.push(membership);
      return membership;
    },
  };
  return new GetGroup(
    users,
    experimentDAO,
    cohortDAO,
    async () => {
      throw new Error("A managed decision called the legacy bucketer");
    },
    () => draw,
  );
}

export function registerRolloutContract(current: () => StorageFixture) {
  describe("managed rollout", () => {
    it("separates stored membership from the pinned, paused, sticky and winning decisions", async () => {
      const fixture = current();
      const { runtime, experiment, apply, stored } = await setup(fixture);
      const shortCohort = experiment.cohorts.find((c) => c.slug === short)!;
      await expect(runtime.resolveCohort(alice, slug)).resolves.toEqual({ slug: null });
      await expect(runtime.getGroup(alice, slug)).resolves.toBe(off);
      await expect(stored(alice)).resolves.toBeNull();
      const explicit = await runtime.joinCohort(bob, slug, short);
      await expect(runtime.resolveCohort(bob, slug)).resolves.toEqual({ slug: null });
      await expect(stored(bob)).resolves.toEqual(explicit);
      await expect(
        runtime.finalizeExperiment(experiment.id, shortCohort.id),
      ).rejects.toBeInstanceOf(RolloutConflictError);
      await expect(runtime.removeCohort(shortCohort.id)).rejects.toBeInstanceOf(
        RolloutConflictError,
      );
      await expect(runtime.updateCohort(shortCohort.id, { percentage: 10 })).rejects.toBeInstanceOf(
        RolloutConflictError,
      );
      await expect(
        runtime.addCohortToExperiment(experiment.id, {
          slug: slug + "_another",
          type: "treatment",
          description: "",
          value: null,
          percentage: 0,
        }),
      ).rejects.toBeInstanceOf(RolloutConflictError);

      const launch = split("launch", 100, 0);
      await apply(1, launch);
      await apply(1, launch);
      await expect(runtime.resolveCohort(alice, slug)).resolves.toEqual({ slug: null });
      const automatic = await stored(alice);
      expect(automatic?.cohort_id).toEqual(experiment.cohorts.find((c) => c.slug === off)?.id);
      await expect(runtime.resolveCohort(bob, slug)).resolves.toEqual({ slug: short });
      const adjust = split("adjust", 0, 0);
      await expect(apply(1, adjust)).rejects.toBeInstanceOf(RolloutConflictError);
      await apply(2, adjust);
      await apply(2, adjust);
      expect(await runtime.getGroup(alice, slug)).toBe(off);
      await runtime.pauseExperiment(slug);
      await apply(3, { type: "pause" });
      await expect(runtime.getGroup(bob, slug)).resolves.toBeNull();
      await runtime.resumeExperiment(slug);
      expect(await runtime.getGroup(bob, slug)).toBe(short);
      await apply(5, { type: "finalize", cohort: off });
      await apply(5, { type: "finalize", cohort: off });
      const reopened = fixture.reopen();
      expect(await reopened.getGroup(bob, slug)).toBe(off);
      await expect(runtime.resolveCohort(bob, slug)).resolves.toEqual({ slug: null });
      await expect(stored(alice)).resolves.toEqual(automatic);
      await expect(stored(bob)).resolves.toEqual(explicit);
      expect(await fixture.adaptor.experimentDAO.getById(experiment.id)).toMatchObject({
        revision: 6,
        rolloutPhase: "winner-selected",
        enabled: true,
        winner: off,
      });
    });

    it.each(["adjust", "pause", "finalize"] as const)(
      "re-resolves after a competing %s between sampling and insertion",
      async (action) => {
        const fixture = current();
        const { apply, experiment, stored } = await setup(fixture);
        await apply(1, split("launch", 0, 100));
        const committed: UserCohort[] = [];
        let attempts = 0;
        const group = interceptInsert(
          fixture,
          async () => {
            attempts++;
            if (attempts !== 1) return;
            if (action === "adjust") await apply(2, split("adjust", 100, 0));
            if (action === "pause") await apply(2, { type: "pause" });
            if (action === "finalize") await apply(2, { type: "finalize", cohort: detailed });
          },
          committed,
        );
        const decision = await group.resolveCohort(alice, slug);
        expect(decision).toEqual({ slug: action === "finalize" ? detailed : null });
        if (action === "adjust") {
          expect(attempts).toBe(2);
          expect(committed).toHaveLength(1);
          expect(committed[0]?.cohort_id).toBe(experiment.cohorts.find((c) => c.slug === off)?.id);
          await expect(stored(alice)).resolves.toEqual(committed[0]);
        } else {
          expect(attempts).toBe(1);
          expect(committed).toHaveLength(0);
          await expect(stored(alice)).resolves.toBeNull();
        }
      },
    );

    it("both concurrent decisions use the one successful membership", async () => {
      const fixture = current();
      const { apply, stored, experiment } = await setup(fixture);
      await apply(1, split("launch", 0, 50));
      const bothReady = Promise.withResolvers<void>();
      let arrivals = 0;
      const rendezvous = async () => {
        if (++arrivals === 2) bothReady.resolve();
        await bothReady.promise;
      };
      const committed: UserCohort[] = [];
      const decisions = await Promise.all(
        [0, 0.9999].map((draw) =>
          interceptInsert(fixture, rendezvous, committed, draw).resolveCohort(alice, slug),
        ),
      );
      expect(committed).toHaveLength(1);
      const selected = experiment.cohorts.find((c) => c.id === committed[0]?.cohort_id);
      expect(selected).toBeDefined();
      expect(decisions).toEqual([{ slug: selected!.slug }, { slug: selected!.slug }]);
      await expect(stored(alice)).resolves.toEqual(committed[0]);
    });
  });
}
