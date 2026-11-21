import { describe, expect, it, vi } from "vitest";

import type { AnalyticsAdaptor } from "~/interfaces/analytics";

import { createAmplitudeAdaptor } from "../amplitude";
import { createFullstoryAdaptor } from "../fullstory";
import { createHeapAdaptor } from "../heap";
import { createMixpanelAdaptor } from "../mixpanel";
import { createPostHogAdaptor } from "../posthog";
import { createSegmentAdaptor } from "../segment";
import { membership } from "./fixture";

const cases: [string, (request: typeof fetch) => AnalyticsAdaptor, unknown][] = [
  [
    "amplitude",
    (fetch) => createAmplitudeAdaptor({ apiKey: "fixture-api-key", fetch }),
    { code: 200, events_ingested: 1 },
  ],
  [
    "segment",
    (fetch) => createSegmentAdaptor({ writeKey: "fixture-write-key", fetch }),
    { success: true },
  ],
  [
    "mixpanel",
    (fetch) =>
      createMixpanelAdaptor({ projectId: "42", username: "test", password: "fixture", fetch }),
    { code: 200, status: "OK", num_records_imported: 1 },
  ],
  ["fullstory", (fetch) => createFullstoryAdaptor({ apiKey: "fixture-api-key", fetch }), {}],
  ["heap", (fetch) => createHeapAdaptor({ appId: "12345", fetch }), {}],
  [
    "posthog",
    (fetch) => createPostHogAdaptor({ projectToken: "phc_fixture", fetch }),
    { results: { [membership.event.id]: { result: "ok" } } },
  ],
];

describe.each(cases)("%s delivery contract", (provider, make, success) => {
  it("retries a transient response and sends one stable membership to the same endpoint", async () => {
    const post = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("private failure", { status: 429, headers: { "Retry-After": "65" } }),
      )
      .mockResolvedValueOnce(Response.json(success));
    const adaptor = make(post);
    const signal = new AbortController().signal;
    expect(adaptor.provider).toBe(provider);
    expect(await adaptor.deliver(membership, signal, { attempt: 1 })).toMatchObject({
      status: "retry",
      retryAfterMs: 65000,
    });
    expect(await adaptor.deliver(membership, signal, { attempt: 2 })).toEqual({
      status: "accepted",
    });
    const [[firstURL, first], [secondURL, second]] = post.mock.calls;
    expect(secondURL).toEqual(firstURL);
    expect(second!.method).toBe("POST");
    expect(second!.body).toEqual(first!.body);
    const body = String(second!.body);
    expect(body).toContain(membership.subjectId);
    expect(body).toContain(membership.event.name);
    expect(body).toContain(membership.event.cohortSlug);
    expect(body).toContain("xp_assignment_source");
    expect(body + JSON.stringify(second!.headers)).toContain(membership.event.id);
  });
});
