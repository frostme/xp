import { describe, expect, it, vi } from "vitest";

import { createSegmentAdaptor } from "../segment";
import { membership } from "./fixture";

const writeKey = "synthetic-write-key";
const signal = new AbortController().signal;

describe("Segment HTTP Track", () => {
  it.each([
    ["US", "api.segment.io"],
    ["EU", "eu1.api.segmentapis.com"],
  ] as const)(
    "posts one mapped Track event with stable credentials, identity and time in %s",
    async (region, host) => {
      const request = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => Response.json({ success: true }));
      const adaptor = createSegmentAdaptor({ writeKey, region, fetch: request });
      expect(request).not.toHaveBeenCalled();
      expect(adaptor.provider).toBe("segment");
      for (const attempt of [1, 2])
        expect(await adaptor.deliver(membership, signal, { attempt })).toEqual({
          status: "accepted",
        });
      const [[url, options], [, replay]] = request.mock.calls as [
        Parameters<typeof fetch>,
        Parameters<typeof fetch>,
      ];
      expect(url).toBe(`https://${host}/v1/track`);
      expect(options).toMatchObject({
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: "Basic " + Buffer.from(writeKey + ":").toString("base64"),
          "Content-Type": "application/json",
        },
      });
      expect(JSON.parse(String(options?.body))).toEqual({
        userId: "external-shopper",
        event: "xp.cohort.joined",
        timestamp: "2026-11-01T12:00:01.234Z",
        messageId: "69d67977-3038-42ef-ad64-a75fb460bd49",
        properties: {
          xp_assignment_source: "automatic",
          xp_experiment_slug: "checkout",
          xp_cohort_slug: "checkout_control",
          xp_event_version: 1,
        },
      });
      expect(replay?.body).toBe(options?.body);
    },
  );
  it.each([
    [400, "rejected", "invalid-event"],
    [401, "rejected", "unauthorized"],
    [403, "rejected", "unauthorized"],
    [429, "retry", "rate-limited"],
    [503, "retry", "provider-unavailable"],
    [202, "retry", "invalid-response"],
  ] as const)(
    "classifies HTTP %i without exposing response details",
    async (code, status, reason) => {
      const request = vi.fn<typeof fetch>().mockResolvedValue(
        new Response("private body", {
          status: code,
          headers: code === 429 ? { "Retry-After": "60" } : {},
        }),
      );
      const adaptor = createSegmentAdaptor({ writeKey, fetch: request });
      expect(await adaptor.deliver(membership, signal, { attempt: 1 })).toEqual({
        status,
        reason,
        ...(code === 429 ? { retryAfterMs: 60000 } : {}),
      });
      expect(request.mock.calls[0]?.[0]).toBe("https://api.segment.io/v1/track");
    },
  );

  it("requires an unambiguous regional source credential", () => {
    for (const key of ["", "bad\nkey", "key:password"])
      expect(() => createSegmentAdaptor({ writeKey: key })).toThrow();
    expect(() => createSegmentAdaptor({ writeKey, region: "XX" as "EU" })).toThrow();
  });
  it("rejects an oversized UTF-8 event before sending", async () => {
    const request = vi.fn<typeof fetch>();
    const adaptor = createSegmentAdaptor({ writeKey, fetch: request });
    expect(
      await adaptor.deliver(
        { ...membership, event: { ...membership.event, cohortSlug: "猫".repeat(12000) } },
        signal,
        { attempt: 1 },
      ),
    ).toEqual({ status: "rejected", reason: "invalid-event" });
    expect(request).not.toHaveBeenCalled();
  });
  it("bounds the response and retries an explicit failure on HTTP 200", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ success: false }))
      .mockResolvedValueOnce(new Response("x".repeat(32769)))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const adaptor = createSegmentAdaptor({ writeKey, fetch: request });
    for (const attempt of [1, 2])
      expect(await adaptor.deliver(membership, signal, { attempt })).toEqual({
        status: "retry",
        reason: "invalid-response",
      });
    expect(await adaptor.deliver(membership, signal, { attempt: 3 })).toEqual({
      status: "accepted",
    });
  });
});
