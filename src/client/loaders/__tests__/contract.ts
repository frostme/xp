import { describe, it, expect, vi } from "vitest";

import type { CohortLoader, LoaderOptions } from "../shared";

export function loaderContract(
  name: string,
  create: (options: LoaderOptions) => CohortLoader,
  wrap: (decision: unknown) => unknown,
) {
  describe(name + " cohort loader", () => {
    it.each(["checkout_a", null])("returns a validated decision %s", async (value) => {
      const request = vi.fn(async () => Response.json(wrap({ slug: value })));
      const signal = new AbortController().signal;
      const loader = create({
        fetch: request,
        experimentHost: "/mount/",
        headers: { "X-Session": "1" },
        credentials: "include",
      });
      expect(await loader("checkout", { signal })).toBe(value);
      expect(request).toHaveBeenCalledWith(
        name === "REST" ? "/mount/xp" : "/mount/graphql",
        expect.objectContaining({ method: "POST", signal, credentials: "include" }),
      );
      const init = request.mock.calls[0]![1] as RequestInit;
      expect(new Headers(init.headers).get("X-Session")).toBe("1");
      const body = JSON.parse(String(init.body));
      expect(name === "REST" ? body : body.variables).toEqual({ slug: "checkout" });
      if (name !== "REST") expect(body.query).toContain("mutation XpResolveCohort($slug: String!)");
    });
    it.each([
      {},
      { slug: "elsewhere_a" },
      { slug: "checkout_" },
      { slug: "checkout_a_b" },
      { slug: false },
    ])("rejects an invalid decision %j", async (invalid) => {
      const loader = create({ fetch: async () => Response.json(wrap(invalid)) });
      await expect(loader("checkout")).rejects.toThrow();
    });
    it("rejects malformed JSON, HTTP auth failures, native aborts and network failures", async () => {
      await expect(
        create({ fetch: async () => new Response("broken") })("checkout"),
      ).rejects.toThrow();
      await expect(
        create({ fetch: async () => new Response(null, { status: 401 }) })("checkout"),
      ).rejects.toThrow("401");
      const failure = new TypeError("network failure");
      await expect(
        create({
          fetch: async () => {
            throw failure;
          },
        })("checkout"),
      ).rejects.toBe(failure);
      const signal = AbortSignal.abort();
      const loader = create({
        fetch: async (_url, init) => {
          init?.signal?.throwIfAborted();
          return new Response();
        },
      });
      await expect(loader("checkout", { signal })).rejects.toBe(signal.reason);
    });
  });
}
