import { expect, it, vi } from "vitest";

import { createAmplitudeAdaptor } from "../amplitude";
import { membership } from "./fixture";

const signal = new AbortController().signal;
const success = () => Response.json({ code: 200, events_ingested: 1 });
const options = { apiKey: "fixture-project-key" };

it.each([
  ["US", "api2.amplitude.com"],
  ["EU", "api.eu.amplitude.com"],
] as const)("sends a stable one-event upload to the %s region", async (region, host) => {
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => success());
  const adaptor = createAmplitudeAdaptor({ ...options, region, fetch });
  for (const attempt of [1, 2]) {
    expect(await adaptor.deliver(membership, signal, { attempt })).toEqual({ status: "accepted" });
  }
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe(`https://${host}/2/httpapi`);
  expect(init).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" } });
  expect(init!.body).toBe(fetch.mock.calls[1]![1]!.body);
  expect(JSON.parse(String(init!.body))).toEqual({
    api_key: options.apiKey,
    events: [
      {
        event_type: "xp.cohort.joined",
        user_id: "external-shopper",
        insert_id: membership.event.id,
        time: 1793534401234,
        event_properties: {
          xp_experiment_slug: "checkout",
          xp_cohort_slug: "checkout_control",
          xp_assignment_source: "automatic",
          xp_event_version: 1,
        },
      },
    ],
  });
});

it("validates the project settings and applies the configured user ID minimum", async () => {
  expect(() => createAmplitudeAdaptor({ apiKey: "" })).toThrow();
  expect(() => createAmplitudeAdaptor({ ...options, region: "other" as never })).toThrow();
  for (const minIdLength of [0, 1.1, 1025, NaN]) {
    expect(() => createAmplitudeAdaptor({ ...options, minIdLength })).toThrow();
  }
  const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => success());
  const delivery = { ...membership, subjectId: "🙂👤" };
  expect(
    await createAmplitudeAdaptor({ ...options, fetch }).deliver(delivery, signal, { attempt: 1 }),
  ).toEqual({ status: "rejected", reason: "invalid-event" });
  expect(fetch).not.toHaveBeenCalled();
  await createAmplitudeAdaptor({ ...options, fetch, minIdLength: 2 }).deliver(delivery, signal, {
    attempt: 1,
  });
  expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toMatchObject({
    options: { min_id_length: 2 },
    events: [{ user_id: delivery.subjectId }],
  });
});

it.each([
  [200, { code: 200, events_ingested: 0 }],
  [200, { code: 400, events_ingested: 1 }],
  [201, { code: 200, events_ingested: 1 }],
  [200, { code: 200, events_ingested: 2 }],
  [200, "unexpected page"],
])("requires confirmation for the individual event", async (status, body) => {
  const adaptor = createAmplitudeAdaptor({
    ...options,
    fetch: async () => Response.json(body, { status }),
  });
  expect(await adaptor.deliver(membership, signal, { attempt: 1 })).toEqual({
    status: "retry",
    reason: "invalid-response",
  });
});

it.each([
  [400, { error: "Invalid API key" }, { status: "rejected", reason: "unauthorized" }],
  [
    400,
    { error: "Invalid field values on some events" },
    { status: "rejected", reason: "invalid-event" },
  ],
  [
    400,
    { throttled_events: [0] },
    { status: "retry", reason: "rate-limited", retryAfterMs: 30000 },
  ],
  [401, {}, { status: "rejected", reason: "unauthorized" }],
  [413, {}, { status: "rejected", reason: "invalid-event" }],
  [429, {}, { status: "retry", reason: "rate-limited", retryAfterMs: 60000 }],
  [503, {}, { status: "retry", reason: "provider-unavailable" }],
])(
  "classifies HTTP %i without returning echoed identities or keys",
  async (status, body, result) => {
    const adaptor = createAmplitudeAdaptor({
      ...options,
      fetch: async () =>
        Response.json({ ...body, echo: membership.subjectId, api_key: options.apiKey }, { status }),
    });
    expect(await adaptor.deliver(membership, signal, { attempt: 1 })).toEqual(result);
  },
);

it("honors Retry-After", async () => {
  const adaptor = createAmplitudeAdaptor({
    ...options,
    fetch: async () => new Response(null, { status: 429, headers: { "Retry-After": "120" } }),
  });
  expect(await adaptor.deliver(membership, signal, { attempt: 1 })).toEqual({
    status: "retry",
    reason: "rate-limited",
    retryAfterMs: 120000,
  });
});

it("retries a network failure with a redacted reason", async () => {
  const adaptor = createAmplitudeAdaptor({
    ...options,
    fetch: async () => {
      throw new Error(options.apiKey);
    },
  });
  expect(await adaptor.deliver(membership, signal, { attempt: 1 })).toEqual({
    status: "retry",
    reason: "network",
  });
});

it("stops a stalled receiver at its configured request timeout", async () => {
  const adaptor = createAmplitudeAdaptor({
    ...options,
    timeoutMs: 100,
    fetch: async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  });
  expect(await adaptor.deliver(membership, signal, { attempt: 1 })).toEqual({
    status: "retry",
    reason: "timeout",
  });
});
