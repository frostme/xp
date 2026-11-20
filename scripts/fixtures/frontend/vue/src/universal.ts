import { createSSRApp, shallowRef } from "vue";

import App from "./App.vue";
import { routeKey } from "./route";
import { xpBootstrap, type XpHost } from "./xp/options";

export function makeApp(url: URL, data: XpHost) {
  const app = createSSRApp(App);
  const bootstrap = shallowRef(data);
  app.provide(xpBootstrap, bootstrap);
  app.provide(routeKey, {
    slug: url.searchParams.get("slug") ?? "delivery-copy",
    journey: url.pathname === "/journey",
    rotate() {
      bootstrap.value = { sessionKey: Number(bootstrap.value.sessionKey ?? 0) + 1 };
    },
  });
  return app;
}
