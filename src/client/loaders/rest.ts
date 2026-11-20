import { jsonLoader, record, type LoaderOptions } from "./shared";

export interface RestLoaderOptions extends LoaderOptions {
  decode?: (payload: unknown) => unknown;
}

export function createRestLoader(options: RestLoaderOptions = {}) {
  return jsonLoader(
    options,
    "/xp",
    (slug) => ({ slug }),
    options.decode ?? ((payload) => (record(payload) ? payload["slug"] : undefined)),
  );
}
