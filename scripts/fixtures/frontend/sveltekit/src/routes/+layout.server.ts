import { redirect } from "@sveltejs/kit";

import type { LayoutServerLoad } from "./$types";
export const load: LayoutServerLoad = (event) => {
  event.depends("account:revision");
  if (event.url.searchParams.has("redirect")) redirect(303, "/next");
  return { title: "Existing shop" };
};
