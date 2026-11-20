import { createGraphQLLoader, createRestLoader } from "@frostme/xp/client";
import { defineMiddleware } from "astro:middleware";

import { createHostLoader } from "./xp/request";

export const onRequest = defineMiddleware(async (ctx, next) => {
  if (ctx.url.pathname === "/early") return new Response("auth rejected", { status: 403 });
  const calls = new Map<string, number>();
  ctx.locals.calls = calls;
  const token = ctx.isPrerendered ? undefined : ctx.cookies.get("xp_session")?.value;
  const endpoint = process.env.XP_JOURNEY_ENDPOINT;
  ctx.locals.xpHost = {
    sessionKey: token === "session-2" ? 2 : 1,
    load:
      endpoint && !ctx.isPrerendered
        ? createHostLoader({ endpoint, headers: token ? { authorization: `Bearer ${token}` } : {} })
        : async (slug, { signal }) => {
            if (ctx.isPrerendered)
              throw new Error("personalized loader reached while prerendering");
            signal.throwIfAborted();
            calls.set(slug, (calls.get(slug) ?? 0) + 1);
            await new Promise((resolve) => setTimeout(resolve, 8));
            if (slug === "failed") throw new Error("private host exception");
            if (slug === "empty") return null;
            return `${slug}_${token === "session-2" ? "off" : "on"}`;
          },
  };
  if (ctx.url.pathname === "/transport") {
    const protocol = ctx.url.searchParams.get("kind");
    if (protocol !== "rest" && protocol !== "graphql")
      return new Response("Unknown transport", { status: 400 });
    const factory = protocol === "rest" ? createRestLoader : createGraphQLLoader;
    ctx.locals.xpHost = {
      load: factory({ endpoint: process.env.XP_ASTRO_TEST_ORIGIN + "/probe/" + protocol }),
    };
  }
  const response = await next();
  response.headers.set("x-host-header", "preserved");
  return response;
});
