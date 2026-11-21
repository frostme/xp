import type { AnalyticsAdaptor, DeliveryResult } from "~/interfaces/analytics";

import {
  accepted,
  createSender,
  credential,
  eventProperties,
  invalidEvent,
  invalidResponse,
  object,
  regionalHost,
  type HttpOptions,
} from "./http";

interface AmplitudeOptions extends HttpOptions {
  readonly apiKey: string;
  readonly region?: "US" | "EU";
  readonly minIdLength?: number;
}

function classifyBadRequest(status: number, body: unknown): DeliveryResult | undefined {
  if (status !== 400 || !object(body)) return undefined;
  if (body["error"] === "Invalid API key") return { status: "rejected", reason: "unauthorized" };
  if (Array.isArray(body["throttled_events"]) && body["throttled_events"].includes(0)) {
    return { status: "retry", reason: "rate-limited", retryAfterMs: 30_000 };
  }
  return undefined;
}

export function createAmplitudeAdaptor(options: AmplitudeOptions): AnalyticsAdaptor {
  const apiKey = credential(options.apiKey, "Amplitude project API key");
  const minIdLength = options.minIdLength ?? 5;
  if (!Number.isInteger(minIdLength) || minIdLength < 1 || minIdLength > 1024) {
    throw new RangeError("Amplitude minIdLength must be an integer from 1 to 1024");
  }
  const url =
    regionalHost(options.region, "https://api2.amplitude.com", "https://api.eu.amplitude.com") +
    "/2/httpapi";
  const send = createSender(options);
  return {
    provider: "amplitude",
    async deliver({ subjectId, event }, signal) {
      if (Array.from(subjectId).length < minIdLength) return invalidEvent;
      const result = await send(
        {
          url,
          body: {
            api_key: apiKey,
            events: [
              {
                user_id: subjectId,
                event_type: event.name,
                time: Date.parse(event.occurredAt),
                insert_id: event.id,
                event_properties: eventProperties(event),
              },
            ],
            ...(minIdLength === 5 ? {} : { options: { min_id_length: minIdLength } }),
          },
        },
        signal,
        (status, body) =>
          status === 200 && object(body) && body["code"] === 200 && body["events_ingested"] === 1
            ? accepted
            : invalidResponse,
        classifyBadRequest,
      );
      // A project-wide 429 can require a longer pause than a single-user limit.
      if (
        result.status === "retry" &&
        result.reason === "rate-limited" &&
        result.retryAfterMs === undefined
      ) {
        return { ...result, retryAfterMs: 60_000 };
      }
      return result;
    },
  };
}
