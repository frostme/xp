import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createGraphQLLoader, createRestLoader } from "@frostme/xp/client";
import { Cohort, Experiment, XPProvider, useCohort } from "@frostme/xp/react";
import { JSDOM } from "jsdom";
import { act, createElement as h } from "react";

const dom = new JSDOM("<!doctype html><main></main>",{url:"http://shop.test/"});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const {createRoot} = await import("react-dom/client");

function Decision() {
  const result = useCohort();
  return h("output", {"data-status": result.status, "data-error":String(Boolean(result.error)), "data-slug":result.slug ?? ""});
}

export function mountClient(transport, {holdSession} = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let token;
  let release;
  let received;
  const heldResponse = new Promise(resolve=>{ received=resolve; });
  const releaseResponse = new Promise(resolve=>{ release=resolve; });
  const requests = [];
  const hostFetch = async (input, init) => {
    const session = token;
    const headers = new Headers(init?.headers);
    if (session) headers.set("authorization",`Bearer ${session}`);
    // For the account-switch case, model a transport that delivers an obsolete
    // response even though React has already unsubscribed from that session.
    const response = await fetch(input,{...init, headers, ...(holdSession === session && holdSession ? {signal: null} : {})});
    const body = await response.clone().json();
    requests.push({session, status:response.status, body});
    if (holdSession && session === holdSession) {
      received();
      await releaseResponse;
    }
    return response;
  };
  const factory = transport.protocol === "rest" ? createRestLoader : createGraphQLLoader;
  const load = factory({endpoint:transport.endpoint,fetch:hostFetch});
  let heldLoad;
  const loader = (slug, options) => {
    const request = load(slug,options);
    if (holdSession && token === holdSession) heldLoad = request;
    return request;
  };

  return {
    requests, heldResponse,
    async show(session, slug = "delivery-copy") {
      token = session;
      await act(async () => {
        root.render(h(XPProvider,{loader,sessionKey:session ?? "guest"},
          h(Experiment,{slug,loading:h("span",null,"pending")},
            h(Decision),
            ...["control","short","detailed"].map(choice=>h(Cohort,{slug:choice,key:choice},h("strong",null,choice))),
            h(Cohort,{default:true},h("strong",null,"default")))));
      });
    },
    async decision(status) {
      const deadline = Date.now()+10000;
      let output = container.querySelector("output");
      while (output?.dataset.status !== status && Date.now()<deadline) {
        await act(async () => { await delay(5); });
        output = container.querySelector("output");
      }
      assert.equal(output?.dataset.status,status, `Expected ${status} from ${transport.name}: ${container.innerHTML}`);
      return {slug: output.dataset.slug || null, error: output.dataset.error === "true", branch:container.querySelector("strong")?.textContent};
    },
    async releaseHeldRequest() {
      // Wait for the stale response's decode and subscription callbacks before asserting the visible branch.
      await act(async () => { release(); await heldLoad; });
    },
    async close() {
      release();
      await act(async () => { root.unmount(); });
      container.remove();
    },
  };
}

export function closeBrowser() { dom.window.close(); }
