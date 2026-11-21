import { describe, expect, it, vi } from "vitest";

import { accepted, createSender, invalidResponse, object } from "../http";

const signal = new AbortController().signal;
const data = {
  url: "https://collector.example/events",
  headers: { Authorization: "private header" },
  body: { credential: "private key" },
};
const ack = (status: number, body: unknown) =>
  status === 200 && object(body) && body["success"] === true ? accepted : invalidResponse;

describe("server analytics HTTP", () => {
  it("sends one POST and prevents credential-bearing redirects", async () => {
    const request = vi.fn(async () => Response.json({ success: true }));
    const send = createSender({ fetch: request as never });
    expect(await send(data, signal, ack)).toEqual(accepted);
    expect(request).toHaveBeenCalledWith(
      data.url,
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        body: JSON.stringify(data.body),
      }),
    );
  });
  it.each([408, 425, 429, 500, 503])(
    "classifies HTTP %s without exposing its response body",
    async (status) => {
      const send = createSender({
        fetch: async () =>
          new Response("private account", { status, headers: { "Retry-After": "2" } }),
      });
      expect(await send(data, signal, ack)).toEqual({
        status: "retry",
        reason: status === 429 ? "rate-limited" : "provider-unavailable",
        retryAfterMs: 2000,
      });
    },
  );
  it("respects a Retry-After HTTP date", async () => {
    const now = Date.UTC(2026, 10, 1);
    const spy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const send = createSender({
        fetch: async () =>
          new Response(null, {
            status: 429,
            headers: { "Retry-After": new Date(now + 3000).toUTCString() },
          }),
      });
      expect(await send(data, signal, ack)).toMatchObject({ retryAfterMs: 3000 });
    } finally {
      spy.mockRestore();
    }
  });
  it("bounds streamed success and validation responses and sanitizes network failures", async () => {
    const long = "x".repeat(32769);
    const send = (status: number) =>
      createSender({ fetch: async () => new Response(long, { status }) });
    expect(await send(200)(data, signal, ack)).toEqual(invalidResponse);
    expect(await send(400)(data, signal, ack, () => undefined)).toEqual({
      status: "rejected",
      reason: "invalid-event",
    });
    const offline = createSender({
      fetch: async () => {
        throw new Error("private account");
      },
    });
    expect(await offline(data, signal, ack)).toEqual({ status: "retry", reason: "network" });
  });
});
