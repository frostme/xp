import { expect, it } from "vitest";

import type { StorageFixture } from "~/__tests__/storage/contract";

import { analyticsContract } from "~/__tests__/storage/analyticsContract";

export function registerSqlAnalyticsContract(
  setup: () => Promise<StorageFixture & { applyAnalytics(): Promise<void> }>,
) {
  it("stores cohort joins and fences analytics delivery in the real database", async () => {
    const fixture = await setup();
    try {
      await analyticsContract(fixture);
    } finally {
      await fixture.cleanup();
    }
  });

  it("reserves destination keys consistently across concurrent deployments", async () => {
    const fixture = await setup();
    try {
      await fixture.applyAnalytics();
      const store = fixture.adaptor.analytics!;
      const first = { key: "first", provider: "amplitude" };
      const second = { key: "second", provider: "segment" };
      await Promise.all([store.ready([first, second]), store.ready([second, first])]);
      const novel = { key: "aaa", provider: "posthog" };
      await expect(store.ready([novel, { ...second, provider: "heap" }])).rejects.toThrow(
        /different provider/,
      );
      expect(await store.destinations(null, 10)).toEqual([first, second]);
    } finally {
      await fixture.cleanup();
    }
  });
}
