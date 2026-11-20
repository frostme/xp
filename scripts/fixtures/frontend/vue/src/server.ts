import { renderToString } from "@vue/server-renderer";

import { makeApp } from "./universal";
export const render = (url: URL, data: Parameters<typeof makeApp>[1]) =>
  renderToString(makeApp(url, data));
