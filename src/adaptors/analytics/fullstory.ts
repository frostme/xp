import type { AnalyticsAdaptor } from "~/interfaces/analytics";

import {
  accepted,
  createSender,
  credential,
  eventProperties,
  invalidEvent,
  invalidResponse,
  object,
  type HttpOptions,
} from "./http";

interface FullstoryOptions extends HttpOptions {
  readonly apiKey: string;
  /** Fullstory routes by API key. Supply a region to verify its residency. */
  readonly region?: "US" | "EU";
}

export function createFullstoryAdaptor(options: FullstoryOptions): AnalyticsAdaptor {
  const apiKey = credential(options.apiKey, "Fullstory API key");
  const keyRegion = apiKey.startsWith("eu1.") ? "EU" : "US";
  if (options.region !== undefined && options.region !== keyRegion) {
    throw new TypeError("Fullstory API key does not match the configured region");
  }
  const send = createSender(options);
  return {
    provider: "fullstory",
    async deliver({ subjectId, event }, signal) {
      if (!subjectId || Array.from(subjectId).length > 256) return invalidEvent;
      return send(
        {
          url: "https://api.fullstory.com/v2/events",
          headers: { Authorization: `Basic ${apiKey}`, "Idempotency-Key": event.id },
          body: {
            name: event.name,
            user: { uid: subjectId },
            timestamp: event.occurredAt,
            properties: eventProperties(event),
          },
        },
        signal,
        (status, body) => (status === 200 && object(body) ? accepted : invalidResponse),
      );
    },
  };
}
