import { expect, it, vi } from "vitest";

import { createXpRequest } from "../preload";

it("loads unique names concurrently, shares in-flight and settled results, and serializes only requested entries", async () => {
  const loader = vi.fn(async (slug: string) => {
    if (slug === "bad") throw new Error("secret");
    return slug === "empty" ? null : slug + "_on";
  });
  const request = createXpRequest(loader);
  const pending = request.resolve("constructor");
  expect(request.resolve("constructor")).toBe(pending);
  const payload = await request.preload(["constructor", "bad", "constructor", "empty"]);
  expect(payload).toEqual({
    initialAssignments: { constructor: "constructor_on", empty: null },
    initialErrors: ["bad"],
  });
  expect(JSON.stringify(payload)).not.toContain("secret");
  expect((await request.resolve("bad")).error?.message).toBe("secret");
  expect(await request.preload(["empty"])).toEqual({
    initialAssignments: { empty: null },
    initialErrors: [],
  });
  expect(loader).toHaveBeenCalledTimes(3);
  await createXpRequest(loader).resolve("bad");
  expect(loader).toHaveBeenCalledTimes(4);
});

it("validates the whole allowlist before loading, and converts wrong experiment results to failure", async () => {
  const loader = vi.fn(async () => "other_on");
  const request = createXpRequest(loader);
  await expect(request.preload(["one", "bad!"])).rejects.toThrow();
  expect(loader).not.toHaveBeenCalled();
  expect(await request.preload(["one"])).toEqual({
    initialAssignments: {},
    initialErrors: ["one"],
  });
});

it("propagates request cancellation even when a loader ignores its signal", async () => {
  const work = Promise.withResolvers<string | null>();
  const controller = new AbortController();
  const loader = vi.fn(async (_slug: string, { signal }: { signal: AbortSignal }) => {
    expect(signal).toBe(controller.signal);
    return work.promise;
  });
  const request = createXpRequest(loader, { signal: controller.signal });
  const pending = request.preload(["one"]);
  await Promise.resolve();
  controller.abort();
  await expect(pending).rejects.toHaveProperty("name", "AbortError");
  work.resolve("one_on");
  await expect(request.preload(["one"])).rejects.toHaveProperty("name", "AbortError");
});
