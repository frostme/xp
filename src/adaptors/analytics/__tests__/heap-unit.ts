import { describe, expect, it, vi } from "vitest";

import { createHeapAdaptor } from "../heap";
import { membership } from "./fixture";

const appId = "19384000";
const signal = new AbortController().signal;

describe("Heap server Track", () => {
  it.each([
    [undefined, "heapanalytics.com"],
    ["EU", "c.eu.heap-api.com"],
  ] as const)(
    "sends an identified event to the configured region %s with a stable idempotency key",
    async (region, host) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation(async () => Response.json({}));
      const adaptor = createHeapAdaptor({ appId, ...(region ? { region } : {}), fetch });
      expect(fetch).not.toHaveBeenCalled();
      expect(adaptor.provider).toBe("heap");
      for (const attempt of [1, 2])
        expect(await adaptor.deliver(membership, signal, { attempt })).toEqual({
          status: "accepted",
        });
      const [[url, first], [, replay]] = fetch.mock.calls as [
        Parameters<typeof fetch>,
        Parameters<typeof fetch>,
      ];
      expect(url).toBe(`https://${host}/api/track`);
      expect(first).toMatchObject({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        redirect: "error",
      });
      expect(JSON.parse(String(first?.body))).toEqual({
        app_id: appId,
        identity: "external-shopper",
        event: "xp.cohort.joined",
        timestamp: "2026-11-01T12:00:01.234Z",
        idempotency_key: "69d67977-3038-42ef-ad64-a75fb460bd49",
        properties: {
          xp_experiment_slug: "checkout",
          xp_cohort_slug: "checkout_control",
          xp_assignment_source: "automatic",
          xp_event_version: 1,
        },
      });
      expect(replay?.body).toBe(first?.body);
    },
  );
  it("always uses external identity, including a numeric-looking external identifier", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({}));
    const adaptor = createHeapAdaptor({ appId, fetch });
    await adaptor.deliver({ ...membership, subjectId: "0" }, signal, { attempt: 1 });
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body));
    expect(body.identity).toBe("0");
    expect(body).not.toHaveProperty("user_id");
  });
  it("enforces the documented identity and property lengths in Unicode characters", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => Response.json({}));
    const adaptor = createHeapAdaptor({ appId, fetch });
    async function send(identity: string, slug: string) {
      return adaptor.deliver(
        { ...membership, subjectId: identity, event: { ...membership.event, cohortSlug: slug } },
        signal,
        { attempt: 1 },
      );
    }
    expect(await send("🛍".repeat(255), "x".repeat(1023))).toEqual({ status: "accepted" });
    for (const [id, slug] of [
      ["🛍".repeat(256), "a"],
      ["user", "x".repeat(1024)],
      [" ", "a"],
    ] as const)
      expect(await send(id, slug)).toEqual({ status: "rejected", reason: "invalid-event" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    [200, "", "retry", "invalid-response"],
    [200, "false", "retry", "invalid-response"],
    [200, "x".repeat(32769), "retry", "invalid-response"],
    [202, "{}", "retry", "invalid-response"],
    [400, "private rejection", "rejected", "invalid-event"],
    [403, "private rejection", "rejected", "unauthorized"],
    [429, "private rejection", "retry", "rate-limited"],
    [502, "private rejection", "retry", "provider-unavailable"],
  ] as const)(
    "classifies a %s response with a bounded, redacted result",
    async (code, body, status, reason) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        new Response(body, {
          status: code,
          headers: code === 429 ? { "Retry-After": "30" } : {},
        }),
      );
      const adaptor = createHeapAdaptor({ appId, fetch });
      expect(await adaptor.deliver(membership, signal, { attempt: 1 })).toEqual({
        status,
        reason,
        ...(code === 429 ? { retryAfterMs: 30000 } : {}),
      });
    },
  );
  it("validates configuration before delivery", () => {
    expect(() => createHeapAdaptor({ appId: " " })).toThrow();
    expect(() => createHeapAdaptor({ appId, region: "XX" as "EU" })).toThrow();
  });
});
