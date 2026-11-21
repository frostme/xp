import { afterEach, describe, expect, it, vi } from "vitest";

import { createPostHogAdaptor } from "../posthog";
import { membership } from "./fixture";

const token = "phc_fixture";
const { id, occurredAt } = membership.event;
const signal = new AbortController().signal;
const verdict = (result: string) => ({
  results: { [id]: { result, details: "fixture-private-details" } },
});

describe("PostHog Capture v1", () => {
  afterEach(() => vi.useRealTimers());

  it("sends one event with the original time and a stable batch identity across retries", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(verdict("retry"), { headers: { "Retry-After": "7" } }))
      .mockResolvedValueOnce(Response.json(verdict("ok")));
    const adaptor = createPostHogAdaptor({ projectToken: token, fetch: request });
    expect(await adaptor.deliver(membership, signal, { attempt: 1 })).toEqual({
      status: "retry",
      reason: "provider-unavailable",
      retryAfterMs: 7000,
    });
    vi.setSystemTime(new Date("2026-11-02T10:00:07Z"));
    expect(await adaptor.deliver(membership, signal, { attempt: 2 })).toEqual({
      status: "accepted",
    });
    const [[url, first], [, second]] = request.mock.calls;
    expect(url).toBe("https://us.i.posthog.com/i/v1/analytics/events");
    expect(first?.method).toBe("POST");
    expect(first?.body).toBe(second?.body);
    expect(JSON.parse(String(first?.body))).toEqual({
      created_at: occurredAt,
      batch: [
        {
          event: "xp.cohort.joined",
          uuid: id,
          distinct_id: "external-shopper",
          timestamp: occurredAt,
          properties: {
            xp_experiment_slug: "checkout",
            xp_cohort_slug: "checkout_control",
            xp_assignment_source: "automatic",
            xp_event_version: 1,
          },
          options: { disable_skew_correction: true },
        },
      ],
    });
    for (const [i, sent] of [first, second].entries()) {
      const headers = new Headers(sent?.headers);
      expect(headers.get("Authorization")).toBe("Bearer " + token);
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(headers.get("User-Agent")).toBe(headers.get("PostHog-Sdk-Info"));
      expect(headers.get("PostHog-Sdk-Info")).toMatch(/^@frostme\/xp\/\d+/);
      expect(headers.get("PostHog-Request-Id")).toBe(id);
      expect(headers.get("PostHog-Attempt")).toBe(String(i + 1));
      expect(headers.get("PostHog-Request-Timestamp")).toBe(
        i ? "2026-11-02T10:00:07.000Z" : "2026-11-02T10:00:00.000Z",
      );
    }
  });

  it.each([
    [verdict("ok"), { status: "accepted" }],
    [verdict("warning"), { status: "accepted" }],
    [verdict("new-outcome"), { status: "accepted" }],
    [{ results: {} }, { status: "accepted" }],
    [verdict("drop"), { status: "rejected", reason: "invalid-event" }],
    [{}, { status: "rejected", reason: "invalid-response" }],
    [{ results: null }, { status: "rejected", reason: "invalid-response" }],
    [{ results: [verdict("ok")] }, { status: "rejected", reason: "invalid-response" }],
    [{ results: { [id]: null } }, { status: "rejected", reason: "invalid-response" }],
  ])("interprets the UUID-keyed result under a 200 response", async (body, expected) => {
    const sink = createPostHogAdaptor({
      projectToken: token,
      fetch: async () => Response.json(body),
    });
    expect(await sink.deliver(membership, signal, { attempt: 1 })).toEqual(expected);
  });

  it.each([
    [401, "rejected", "unauthorized"],
    [402, "rejected", "invalid-event"],
    [404, "retry", "provider-unavailable"],
    [408, "retry", "provider-unavailable"],
    [429, "retry", "rate-limited"],
    [500, "retry", "provider-unavailable"],
    [501, "rejected", "invalid-event"],
    [503, "retry", "provider-unavailable"],
  ])(
    "classifies whole-request HTTP %i and discards rejection bodies",
    async (code, status, reason) => {
      const sink = createPostHogAdaptor({
        projectToken: token,
        fetch: async () => new Response("fixture-secret", { status: Number(code) }),
      });
      expect(await sink.deliver(membership, signal, { attempt: 1 })).toEqual({ status, reason });
    },
  );

  it.each([
    [{ region: "EU" as const }, "https://eu.i.posthog.com"],
    [{ host: "https://posthog.example/ingestion/" }, "https://posthog.example/ingestion"],
  ])("routes to the matching ingestion host", async (opts, base) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(verdict("ok")));
    const sink = createPostHogAdaptor({ projectToken: token, ...opts, fetch: request });
    await sink.deliver(membership, signal, { attempt: 1 });
    expect(request.mock.calls[0]?.[0]).toBe(base + "/i/v1/analytics/events");
  });

  it("marks oversized success responses unreadable without repeating their contents", async () => {
    const sink = createPostHogAdaptor({
      projectToken: token,
      fetch: async () => new Response("x".repeat(33 * 1024)),
    });
    expect(await sink.deliver(membership, signal, { attempt: 1 })).toEqual({
      status: "rejected",
      reason: "invalid-response",
    });
  });

  it("validates tokens, regions and self-host settings at construction", () => {
    expect(() => createPostHogAdaptor({ projectToken: "phx_personal" })).toThrow();
    expect(() => createPostHogAdaptor({ projectToken: token, region: "XX" as "US" })).toThrow();
    expect(() =>
      createPostHogAdaptor({ projectToken: token, host: "https://posthog.example", region: "US" }),
    ).toThrow();
    for (const host of [
      "broken",
      "https://user:pass@posthog.example",
      "https://posthog.example?token=private",
      "file:///somewhere",
    ]) {
      expect(() => createPostHogAdaptor({ projectToken: token, host })).toThrow(/PostHog/);
    }
  });
});
