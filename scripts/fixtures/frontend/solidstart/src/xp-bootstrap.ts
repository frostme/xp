import { createXpRequest } from "@frostme/xp/client";
import { query } from "@solidjs/router";
import { getRequestEvent } from "solid-js/web";

export const xpBootstrap = query(async () => {
  "use server";
  const event = getRequestEvent()!;
  const alice = event.request.headers.get("cookie")?.includes("fixture-account=alice");
  const request = createXpRequest(async (slug) => {
    if (slug === "initial-error") throw new Error("fixture-private");
    return alice && slug === "checkout-banner" ? "checkout-banner_on" : null;
  });
  return {
    ...(await request.preload(["checkout-banner", "explicit-null", "initial-error"])),
    sessionKey: alice ? "first" : "second",
  };
}, "fixture-xp");
