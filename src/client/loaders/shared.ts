import { isSlugPart } from "~/entities/slug";

export interface LoaderOptions {
  experimentHost?: string;
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit;
  credentials?: RequestCredentials;
}

export type CohortLoader = (
  experimentSlug: string,
  options?: { signal?: AbortSignal },
) => Promise<string | null>;

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate both the experiment prefix and the complete local cohort name. */
export function decodeAssignment(value: unknown, experiment: string): string | null {
  if (value === null) return null;
  const prefix = experiment + "_";
  if (
    typeof value !== "string" ||
    !value.startsWith(prefix) ||
    !isSlugPart(value.slice(prefix.length))
  ) {
    throw new TypeError("Expected a qualified cohort slug for " + experiment + " or null");
  }
  return value;
}

export function jsonLoader(
  options: LoaderOptions,
  path: string,
  body: (slug: string) => unknown,
  decode: (payload: unknown) => unknown,
): CohortLoader {
  const endpoint = options.endpoint ?? (options.experimentHost ?? "").replace(/\/+$/, "") + path;
  return async (slug, { signal } = {}) => {
    if (!isSlugPart(slug)) throw new TypeError("Expected a nonempty kebab-case experiment slug");
    const headers = new Headers(options.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    const fetcher = options.fetch ?? globalThis.fetch;
    const response = await fetcher(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body(slug)),
      ...(signal ? { signal } : {}),
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    });
    if (!response.ok) throw new Error(`xp request failed with HTTP ${response.status}`);
    const payload: unknown = await response.json();
    return decodeAssignment(decode(payload), slug);
  };
}
