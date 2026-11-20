import { createXpRequest } from "@frostme/xp/client";

export const slugs = ["assigned", "empty", "failed"];

export function authenticate(cookie) {
  const sessionKey = cookie?.includes("viewer=other") ? "other" : "first";
  return {
    sessionKey,
    slugs,
    async load(slug) {
      if (slug === "failed") throw new Error("private diagnosis");
      return slug === "assigned" && sessionKey === "first" ? "assigned_on" : null;
    },
  };
}

export async function bootstrap(cookie) {
  const auth = authenticate(cookie);
  return { ...(await createXpRequest(auth.load).preload(auth.slugs)), sessionKey: auth.sessionKey };
}
