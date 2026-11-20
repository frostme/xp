import { preload } from "../../fixture-shared/vue/preload.mjs";
export default defineEventHandler(async (event) => {
  setResponseHeader(event, "Cache-Control", "private, no-store");
  return preload(getCookie(event, "variant") === "b");
});
