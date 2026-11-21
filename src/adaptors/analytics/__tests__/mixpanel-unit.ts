import { describe, expect, it, vi } from "vitest";

import { createMixpanelAdaptor } from "../mixpanel";
import { membership } from "./fixture";

const config = { projectId: "42", username: "fixture-account", password: "fixture-password" };
const ok = { code: 200, status: "OK", num_records_imported: 1 };
const signal = new AbortController().signal;

describe("Mixpanel strict one-event import", () => {
  it.each([
    ["US", "api"],
    ["EU", "api-eu"],
    ["IN", "api-in"],
  ] as const)(
    "uses %s residency and preserves the original event on retry",
    async (region, subdomain) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 503 }))
        .mockResolvedValueOnce(Response.json(ok));
      const adaptor = createMixpanelAdaptor({ ...config, region, fetch: request });
      expect(await adaptor.deliver(membership, signal, { attempt: 1 })).toEqual({
        status: "retry",
        reason: "provider-unavailable",
      });
      expect(await adaptor.deliver(membership, signal, { attempt: 2 })).toEqual({
        status: "accepted",
      });
      const [[url, first], [, retry]] = request.mock.calls;
      expect(String(url)).toBe(`https://${subdomain}.mixpanel.com/import?strict=1&project_id=42`);
      expect(first?.method).toBe("POST");
      expect(new Headers(first?.headers).get("Authorization")).toEqual(
        "Basic " + Buffer.from("fixture-account:fixture-password").toString("base64"),
      );
      expect(first?.body).toEqual(retry?.body);
      expect(JSON.parse(String(first?.body))).toEqual([
        {
          event: "xp.cohort.joined",
          properties: {
            distinct_id: "external-shopper",
            time: 1793534401234,
            $insert_id: membership.event.id,
            xp_experiment_slug: "checkout",
            xp_cohort_slug: "checkout_control",
            xp_event_version: 1,
            xp_assignment_source: "automatic",
            ip: 0,
          },
        },
      ]);
    },
  );

  it.each([
    [200, {}, "retry", "invalid-response"],
    [200, { ...ok, num_records_imported: 0 }, "retry", "invalid-response"],
    [200, { ...ok, failed_records: [{ index: 0 }] }, "retry", "invalid-response"],
    [
      400,
      {
        code: 400,
        num_records_imported: 0,
        failed_records: [{ index: 0, insert_id: membership.event.id, message: "fixture subject" }],
      },
      "rejected",
      "invalid-event",
    ],
    [
      400,
      { code: 400, num_records_imported: 1, failed_records: [{ index: 1 }] },
      "retry",
      "invalid-response",
    ],
    [
      400,
      {
        code: 400,
        num_records_imported: 0,
        failed_records: [{ index: 0, $insert_id: "different" }],
      },
      "retry",
      "invalid-response",
    ],
    [401, { error: "fixture password" }, "rejected", "unauthorized"],
    [413, {}, "rejected", "invalid-event"],
  ])(
    "classifies %s and its individual result without exposing the response",
    async (code, body, status, reason) => {
      const adaptor = createMixpanelAdaptor({
        ...config,
        fetch: async () => Response.json(body, { status: Number(code) }),
      });
      expect(await adaptor.deliver(membership, signal, { attempt: 1 })).toEqual({ status, reason });
    },
  );

  it("preserves Retry-After on rate limits", async () => {
    const adaptor = createMixpanelAdaptor({
      ...config,
      fetch: async () => new Response(null, { status: 429, headers: { "Retry-After": "7" } }),
    });
    expect(await adaptor.deliver(membership, signal, { attempt: 1 })).toEqual({
      status: "retry",
      reason: "rate-limited",
      retryAfterMs: 7000,
    });
  });

  it("checks service credentials and supported regions before delivery", () => {
    expect(() => createMixpanelAdaptor({ ...config, password: "" })).toThrow();
    expect(() => createMixpanelAdaptor({ ...config, username: "name:bad" })).toThrow();
    expect(() => createMixpanelAdaptor({ ...config, region: "XX" as "US" })).toThrow();
  });
});
