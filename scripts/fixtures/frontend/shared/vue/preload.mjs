import { createXpRequest } from "@frostme/xp/client";

export async function preload(opposing) {
  const decisions = createXpRequest(async (slug) => {
    if (slug === "failed") throw new Error("private failure detail");
    if (slug === "guest") return null;
    return slug + (opposing ? "_off" : "_on");
  });
  return {
    ...(await decisions.preload(["initial", "guest", "failed"])),
    sessionKey: opposing ? "b" : "a",
  };
}
