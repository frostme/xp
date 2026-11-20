import { createXpRequest } from "@frostme/xp/client";
import { renderToString } from "react-dom/server";

import { App } from "./App";

export async function renderPage(account: string) {
  const decisions = createXpRequest(async (slug) => {
    if (slug === "failed") throw new Error("private host error");
    if (slug === "guest") return null;
    return slug + (account === "A" ? "_on" : "_off");
  });
  const bootstrap = {
    sessionKey: account,
    ...(await decisions.preload(["offer", "guest", "failed"])),
  };
  return (
    '<!doctype html><div id="root">' +
    renderToString(<App bootstrap={bootstrap} />) +
    '</div><script type="application/json" id="data">' +
    JSON.stringify(bootstrap).replaceAll("<", "\\u003c") +
    '</script><script type="module" src="/hydrate.js"></script>'
  );
}
