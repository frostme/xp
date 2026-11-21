import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const hooks = registerHooks({
  load(url, context, nextLoad) {
    assert.doesNotMatch(
      url,
      /\/dist\/client\/(?:grpc-web|soap)\//,
      "Protocol module loaded during SSR",
    );
    return nextLoad(url, context);
  },
});
const fetch = globalThis.fetch;
globalThis.fetch = () => assert.fail("Fetched during SSR");
const { App } = await import("./browser.js");

const host = createRequire(import.meta.url);
const xp = createRequire(host.resolve("@frostme/xp/react"));
assert.equal(xp("react"), host("react"), "xp must use the host's React instance");
assert.equal(renderToStaticMarkup(createElement(App)), "<span>checkout_on</span>");

const { XPProvider, Cohort, Experiment, useCohort } = await import("@frostme/xp/react");
function Status() {
  return createElement("output", null, useCohort().status);
}
for (const loader of ["grpc-web", "soap"]) {
  // DOMParser is absent in this Node consumer. An invalid RPC endpoint would
  // also fail if the transport were constructed during server rendering.
  const render = (props) =>
    renderToStaticMarkup(
      createElement(
        XPProvider,
        { loader, endpoint: ":", ...props },
        createElement(
          Experiment,
          { slug: "checkout" },
          createElement(Status),
          createElement(Cohort, { default: true }, "guest"),
          createElement(Cohort, { slug: "on" }, "assigned"),
        ),
      ),
    );
  assert.equal(render({}), "<output>loading</output>");
  assert.equal(render({ initialAssignments: { checkout: null } }), "<output>ready</output>guest");
  assert.equal(
    render({ initialAssignments: { checkout: "checkout_on" } }),
    "<output>ready</output>assigned",
  );
}
globalThis.fetch = fetch;
hooks.deregister();
