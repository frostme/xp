import { createXpRequest } from "@frostme/xp/client";
import { generateHydrationScript, renderToString } from "@solidjs/web";

import { App } from "../fixture-shared/solid/App";

export async function documentFor(shell: string, account: string, journeySlug: string | null) {
  const request = createXpRequest(async (slug) => {
    if (slug === "initial-error") throw new Error("private fixture cause");
    return account === "alice" && slug === "checkout-banner" ? "checkout-banner_on" : null;
  });
  const preload = await request.preload(
    journeySlug ? [] : ["checkout-banner", "explicit-null", "initial-error"],
  );
  const bootstrap = { ...preload, sessionKey: account, ...(journeySlug ? { journeySlug } : {}) };
  const body = renderToString(() => <App bootstrap={bootstrap} />);
  const data = JSON.stringify(bootstrap).replaceAll("<", "\\u003c");
  return shell
    .replace("<!--app-->", String(body))
    .replace(
      "<!--state-->",
      generateHydrationScript() +
        '<script id="xp-data" type="application/json">' +
        data +
        "</script>",
    );
}
