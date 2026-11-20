import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { App } from "./browser.js";

const host = createRequire(import.meta.url);
const xp = createRequire(host.resolve("@frostme/xp/react"));
assert.equal(xp("react"), host("react"), "xp must use the host's React instance");
assert.equal(renderToStaticMarkup(createElement(App)), "<span>checkout_on</span>");
