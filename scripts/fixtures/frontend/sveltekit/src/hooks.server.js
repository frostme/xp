import { authenticate } from "../fixture-shared/svelte/server-cases.js";
export async function handle({ event, resolve }) {
  event.locals.xp = authenticate(event.request.headers.get("cookie"));
  event.setHeaders({ "cache-control": "private, no-store" });
  return resolve(event);
}
