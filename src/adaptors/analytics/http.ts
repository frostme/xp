import type { CohortJoinedV1 } from "~/entities/analytics";
import type { DeliveryResult } from "~/interfaces/analytics";

export interface HttpOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}
export interface JsonRequest {
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly body: unknown;
}
export const accepted = { status: "accepted" } as const;
export const invalidResponse = { status: "retry", reason: "invalid-response" } as const;
export const invalidEvent = { status: "rejected", reason: "invalid-event" } as const;

export function eventProperties(event: CohortJoinedV1) {
  return {
    xp_experiment_slug: event.experimentSlug,
    xp_cohort_slug: event.cohortSlug,
    xp_assignment_source: event.source,
    xp_event_version: event.version,
  };
}
export function credential(value: string, name: string) {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/.test(value))
    throw new TypeError(`Invalid analytics ${name}`);
  return value;
}
export function regionalHost(region: "US" | "EU" | undefined, us: string, eu: string) {
  if (region !== undefined && region !== "US" && region !== "EU")
    throw new TypeError("Unsupported analytics region");
  return region === "EU" ? eu : us;
}
export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const maxResponse = 32 * 1024;
async function readBody(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const bytes: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > maxResponse) {
        void reader.cancel().catch(() => {});
        throw new RangeError("Analytics response exceeds size limit");
      }
      bytes.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const raw = Buffer.concat(bytes, size).toString("utf8");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function withRetryAfter(result: DeliveryResult, response: Response): DeliveryResult {
  if (result.status !== "retry") return result;
  const value = response.headers.get("Retry-After");
  if (!value) return result;
  const ms = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isNaN(ms)
    ? result
    : { ...result, retryAfterMs: Math.max(result.retryAfterMs ?? 0, ms) };
}

/** One JSON POST per membership. Response bytes and credentials stay inside the adaptor. */
export function createSender(options: HttpOptions) {
  const request = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10000;
  if (
    typeof request !== "function" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 60000
  )
    throw new TypeError("Analytics HTTP requires fetch and a timeout from 100 to 60000 ms");
  return async (
    data: JsonRequest,
    signal: AbortSignal,
    acknowledge: (status: number, body: unknown) => DeliveryResult,
    rejection?: (status: number, body: unknown) => DeliveryResult | undefined,
    statusPolicy?: (status: number) => DeliveryResult | undefined,
  ): Promise<DeliveryResult> => {
    const timed = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    let response: Response;
    try {
      response = await request(data.url, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json", ...data.headers },
        body: JSON.stringify(data.body),
        signal: timed,
      });
    } catch {
      return { status: "retry", reason: timed.aborted ? "timeout" : "network" };
    }
    if (!response.ok) {
      const override = statusPolicy?.(response.status);
      if (override) {
        void response.body?.cancel().catch(() => {});
        return withRetryAfter(override, response);
      }
      if (rejection && (response.status === 400 || response.status === 409)) {
        try {
          const result = rejection(response.status, await readBody(response));
          return withRetryAfter(result ?? invalidEvent, response);
        } catch {
          return invalidEvent;
        }
      }
      // Rejection bodies can echo credentials and identities.
      void response.body?.cancel().catch(() => {});
      if (
        response.status === 408 ||
        response.status === 425 ||
        response.status === 429 ||
        response.status >= 500
      )
        return withRetryAfter(
          {
            status: "retry",
            reason: response.status === 429 ? "rate-limited" : "provider-unavailable",
          },
          response,
        );
      if (response.status === 401 || response.status === 403)
        return { status: "rejected", reason: "unauthorized" };
      return invalidEvent;
    }
    try {
      return withRetryAfter(acknowledge(response.status, await readBody(response)), response);
    } catch {
      return timed.aborted ? { status: "retry", reason: "timeout" } : invalidResponse;
    }
  };
}
