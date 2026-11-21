import { expect, it, vi } from "vitest";

import { createFullstoryAdaptor } from "../fullstory";
import { membership } from "./fixture";

const signal = new AbortController().signal;

it.each([
  ["US", "na1.fixture-key"],
  ["US", "legacy-fixture"],
  ["EU", "eu1.fixture-key"],
] as const)(
  "sends the original event and external UID to the shared Fullstory host for %s",
  async (region, apiKey) => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({}));
    const adaptor = createFullstoryAdaptor({ apiKey, region, fetch });
    for (const attempt of [1, 2]) {
      expect(await adaptor.deliver(membership, signal, { attempt })).toEqual({
        status: "accepted",
      });
    }
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.fullstory.com/v2/events");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: `Basic ${apiKey}`,
        "Idempotency-Key": membership.event.id,
        "Content-Type": "application/json",
      },
    });
    expect(fetch.mock.calls[1]![1]?.headers).toEqual(init?.headers);
    expect(fetch.mock.calls[1]![1]?.body).toBe(init?.body);
    expect(JSON.parse(String(init!.body))).toEqual({
      name: membership.event.name,
      user: { uid: "external-shopper" },
      timestamp: membership.event.occurredAt,
      properties: {
        xp_assignment_source: "automatic",
        xp_cohort_slug: "checkout_control",
        xp_experiment_slug: "checkout",
        xp_event_version: 1,
      },
    });
  },
);

it("validates the key and configured account residency", () => {
  expect(() => createFullstoryAdaptor({ apiKey: "" })).toThrow();
  expect(() => createFullstoryAdaptor({ apiKey: "eu1.secret\r\n" })).toThrow();
  expect(() => createFullstoryAdaptor({ apiKey: "eu1.secret", region: "US" })).toThrow();
  expect(() => createFullstoryAdaptor({ apiKey: "na1.secret", region: "EU" })).toThrow();
});

it("enforces Fullstory's 256-character UID limit", async () => {
  const fetch = vi.fn(async () => Response.json({}));
  const adaptor = createFullstoryAdaptor({ apiKey: "fixture", fetch });
  for (const subjectId of ["", "🙂".repeat(257)]) {
    expect(await adaptor.deliver({ ...membership, subjectId }, signal, { attempt: 1 })).toEqual({
      status: "rejected",
      reason: "invalid-event",
    });
  }
  expect(fetch).not.toHaveBeenCalled();
  expect(
    await adaptor.deliver({ ...membership, subjectId: "🙂".repeat(256) }, signal, { attempt: 2 }),
  ).toEqual({ status: "accepted" });
});

it.each([
  [200, "login page", { status: "retry", reason: "invalid-response", retryAfterMs: 2000 }],
  [200, [], { status: "retry", reason: "invalid-response", retryAfterMs: 2000 }],
  [201, {}, { status: "retry", reason: "invalid-response", retryAfterMs: 2000 }],
  [400, { code: "required_field" }, { status: "rejected", reason: "invalid-event" }],
  [401, { code: "unauthorized" }, { status: "rejected", reason: "unauthorized" }],
  [404, { code: "resource_not_found" }, { status: "rejected", reason: "invalid-event" }],
  [
    429,
    { code: "too_many_requests" },
    { status: "retry", reason: "rate-limited", retryAfterMs: 2000 },
  ],
  [
    502,
    { message: "fixture-private" },
    { status: "retry", reason: "provider-unavailable", retryAfterMs: 2000 },
  ],
])("interprets HTTP %i without exposing the response", async (status, body, expected) => {
  const adaptor = createFullstoryAdaptor({
    apiKey: "fixture",
    fetch: async () => Response.json(body, { status, headers: { "Retry-After": "2" } }),
  });
  expect(await adaptor.deliver(membership, signal, { attempt: 1 })).toEqual(expected);
});
