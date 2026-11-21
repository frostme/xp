import { describe, expect, it, vi } from "vitest";

import { JoinCapture } from "../capture";

const destinations = [
  { key: "amplitude-prod", provider: "amplitude" },
  { key: "warehouse", provider: "custom:warehouse" },
];
const join = { source: "automatic", experimentSlug: "banner", cohortSlug: "banner_off" } as const;

describe("destination-specific cohort join capture", () => {
  it("gives every consenting destination one immutable occurrence and its own mapped subject", async () => {
    const capture = new JoinCapture({
      destinations,
      mapIdentity: ({ userId, destination }) => {
        expect(userId).toBe(0);
        return destination.key + "-external";
      },
    });
    const [first, second] = await capture.prepare(0, join);
    expect(first).toEqual({
      destinationKey: "amplitude-prod",
      provider: "amplitude",
      subjectId: "amplitude-prod-external",
      event: {
        ...join,
        version: 1,
        name: "xp.cohort.joined",
        id: expect.stringMatching(/^[\da-f-]{36}$/),
        occurredAt: expect.stringMatching(/Z$/),
      },
    });
    expect(second.subjectId).toBe("warehouse-external");
    expect(second.event).toBe(first.event);
    expect(Object.isFrozen(first.event)).toBe(true);
    expect((await capture.prepare(0, join))[0].event.id).not.toBe(first.event.id);
  });

  it("allows null independently and preserves string and numeric host identities", async () => {
    const capture = new JoinCapture({
      destinations,
      mapIdentity: ({ destination, userId }) =>
        destination.key === "warehouse" && userId === "0" ? "consented" : null,
    });
    expect(await capture.prepare(0, join)).toEqual([]);
    expect(await capture.prepare("0", { ...join, source: "manual" })).toMatchObject([
      { destinationKey: "warehouse", subjectId: "consented", event: { source: "manual" } },
    ]);
  });

  it.each([undefined, 0, "", "   ", "x".repeat(1025), "\0", "\ud800"])(
    "rejects unusable mapper results",
    async (bad) => {
      const capture = new JoinCapture({ destinations, mapIdentity: () => bad as string });
      await expect(capture.prepare(0, join)).rejects.toThrow("Mapped analytics identity");
    },
  );

  it("redacts mapper failures and aborts work that exceeds the mapping deadline", async () => {
    await expect(
      new JoinCapture({
        destinations,
        mapIdentity: () => {
          throw new Error("private");
        },
      }).prepare(0, join),
    ).rejects.toThrow(/^Analytics identity mapping failed$/);
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const capture = new JoinCapture({
        destinations,
        mappingTimeoutMs: 5,
        mapIdentity: ({ signal }) => {
          signals.push(signal);
          return new Promise(() => {});
        },
      });
      const check = expect(capture.prepare(0, join)).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(5);
      await check;
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("validates configuration and snapshots routing before accepting a join", async () => {
    const mutable = [{ key: "prod", provider: "heap" }];
    const capture = new JoinCapture({ destinations: mutable, mapIdentity: () => "subject" });
    mutable[0].provider = "segment";
    expect((await capture.prepare("user", join))[0].provider).toBe("heap");
    for (const invalid of [
      { destinations, mapIdentity: null },
      { destinations: [...destinations, ...destinations] },
      { destinations: [{ key: "Prod", provider: "segment" }] },
      { destinations: [{ key: "prod", provider: "unknown" }] },
      {
        destinations: Array.from({ length: 33 }, (_, i) => ({ key: "key" + i, provider: "heap" })),
      },
      { destinations, mappingTimeoutMs: 0 },
    ]) {
      expect(
        () => new JoinCapture({ mapIdentity: () => "subject", ...invalid } as never),
      ).toThrow();
    }
  });
});
