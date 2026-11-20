import { describe, expect, it, vi } from "vitest";

import { createXpSession } from "../session";

function deferred() {
  const requests: (ReturnType<typeof Promise.withResolvers<string | null>> & {
    signal: AbortSignal;
  })[] = [];
  const loader = vi.fn((_slug: string, { signal }: { signal: AbortSignal }) => {
    const request = Promise.withResolvers<string | null>();
    requests.push({ ...request, signal });
    return request.promise;
  });
  return { session: createXpSession({ loader }), requests };
}

describe("headless session", () => {
  it("reads without I/O, balances independent subscriptions of the same listener, and retains settled values", async () => {
    const { session, requests } = deferred();
    const read = () => session.getSnapshot("cart");
    expect(read()).toBe(session.getServerSnapshot("cart"));
    await session.refresh("cart");
    expect(requests).toHaveLength(0);
    const notify = vi.fn();
    const first = session.subscribe("cart", notify);
    const last = session.subscribe("cart", notify);
    first();
    first();
    await Promise.resolve();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.signal.aborted).toBe(false);
    requests[0]!.resolve("cart_on");
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    const settled = read();
    expect(settled.slug).toBe("cart_on");
    last();
    session.subscribe("cart", notify)();
    expect(read()).toBe(settled);
    expect(requests).toHaveLength(1);
    session.dispose();
  });

  it("shares refreshes and ignores replaced, abandoned and disposed work even when the loader ignores abort", async () => {
    const { session, requests } = deferred();
    const notify = vi.fn();
    const unsubscribe = session.subscribe("cart", notify);
    await Promise.resolve();
    const refresh = session.refresh("cart");
    expect(session.refresh("cart")).toBe(refresh);
    expect(requests[0]!.signal.aborted).toBe(true);
    await Promise.resolve();
    requests[1]!.resolve("other_on");
    await refresh;
    expect(session.getSnapshot("cart").status).toBe("error");
    requests[0]!.resolve("cart_on");
    await Promise.resolve();
    expect(session.getSnapshot("cart").status).toBe("error");
    const abandoned = session.refresh("cart");
    expect(session.getSnapshot("cart").status).toBe("loading");
    unsubscribe();
    await Promise.resolve();
    expect(requests[2]!.signal.aborted).toBe(true);
    requests[2]!.reject(new Error("late"));
    await abandoned;
    session.subscribe("cart", notify);
    await Promise.resolve();
    session.dispose();
    session.dispose();
    expect(requests[3]!.signal.aborted).toBe(true);
    requests[3]!.resolve(null);
    await Promise.resolve();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("validates reads, subscriptions and both preload fields", () => {
    const session = createXpSession({
      initialAssignments: { constructor: null },
      initialErrors: ["broken"],
    });
    expect(session.getSnapshot("constructor").status).toBe("ready");
    expect(session.getSnapshot("broken").error?.message).toBe("Failed to resolve cohort");
    expect(() => session.subscribe("not valid", vi.fn())).toThrow();
    expect(() => session.getServerSnapshot("")).toThrow();
    expect(() => createXpSession({ initialErrors: ["invalid!"] })).toThrow();
    expect(() => createXpSession({ initialAssignments: { one: "two_on" } })).toThrow();
    expect(() =>
      createXpSession({ initialAssignments: { one: null }, initialErrors: ["one"] }),
    ).toThrow();
  });
});
