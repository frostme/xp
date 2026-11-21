import { createRequire } from "node:module";

import type { AnalyticsAdaptor, DeliveryResult } from "~/interfaces/analytics";

import {
  accepted,
  createSender,
  credential,
  eventProperties,
  invalidEvent,
  object,
  regionalHost,
  type HttpOptions,
} from "./http";

interface PostHogOptions extends HttpOptions {
  readonly projectToken: string;
  readonly region?: "US" | "EU";
  readonly host?: string;
}

const { version } = createRequire(import.meta.url)("../../../package.json") as { version: string };
const sdkInfo = "@frostme/xp/" + version;
const retry = { status: "retry", reason: "provider-unavailable" } as const;
const unreadable = { status: "rejected", reason: "invalid-response" } as const;
const retryCodes = new Set([404, 408, 500, 502, 503, 504]);

function captureEndpoint({ host, region }: PostHogOptions): string {
  if (host !== undefined && region !== undefined)
    throw new TypeError("Choose a PostHog region or a self-hosted base URL");
  let base: URL;
  try {
    base = new URL(
      host ?? regionalHost(region, "https://us.i.posthog.com", "https://eu.i.posthog.com"),
    );
  } catch {
    throw new TypeError("Invalid PostHog host or region");
  }
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new TypeError(
      "PostHog host must be an HTTP(S) base URL without embedded credentials, query or fragment",
    );
  }
  base.pathname = base.pathname.replace(/\/+$/, "") + "/i/v1/analytics/events";
  return base.href;
}

function classifyStatus(status: number): DeliveryResult {
  if (retryCodes.has(status)) return retry;
  if (status === 429) return { status: "retry", reason: "rate-limited" };
  if (status === 401 || status === 403) return { status: "rejected", reason: "unauthorized" };
  return invalidEvent;
}

function eventResult(uuid: string, body: unknown): DeliveryResult {
  if (!object(body) || !object(body["results"])) return unreadable;
  const results = body["results"];
  // Capture v1 defines an omitted entry and future verdict names as delivered.
  if (!Object.hasOwn(results, uuid)) return accepted;
  const entry = results[uuid];
  if (!object(entry) || typeof entry["result"] !== "string" || !entry["result"]) return unreadable;
  if (entry["result"] === "drop") return invalidEvent;
  if (entry["result"] === "retry") return retry;
  return accepted;
}

export function createPostHogAdaptor(options: PostHogOptions): AnalyticsAdaptor {
  const token = credential(options.projectToken, "PostHog project token");
  if (/[^!-~]/.test(token) || token.startsWith("phx_"))
    throw new TypeError("Invalid PostHog project token");
  const url = captureEndpoint(options);
  const send = createSender(options);
  return {
    provider: "posthog",
    async deliver({ event, subjectId }, signal, { attempt }) {
      const uuid = event.id.toLowerCase();
      const body = {
        created_at: event.occurredAt,
        batch: [
          {
            event: event.name,
            uuid,
            distinct_id: subjectId,
            timestamp: event.occurredAt,
            options: { disable_skew_correction: true },
            properties: eventProperties(event),
          },
        ],
      };
      const result = await send(
        {
          url,
          body,
          headers: {
            Authorization: "Bearer " + token,
            "User-Agent": sdkInfo,
            "PostHog-Sdk-Info": sdkInfo,
            "PostHog-Request-Id": uuid,
            "PostHog-Attempt": String(attempt),
            "PostHog-Request-Timestamp": new Date().toISOString(),
          },
        },
        signal,
        (_status, response) => eventResult(uuid, response),
        undefined,
        classifyStatus,
      );
      return result.status === "retry" && result.reason === "invalid-response"
        ? unreadable
        : result;
    },
  };
}
