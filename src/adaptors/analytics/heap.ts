import type { AnalyticsAdaptor } from "~/interfaces/analytics";

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

interface HeapOptions extends HttpOptions {
  readonly appId: string;
  readonly region?: "US" | "EU";
}

function exceedsCharacters(value: string, limit: number): boolean {
  // UTF-16 uses at most two code units per Unicode code point.
  return value.length > limit * 2 || (value.length > limit && [...value].length > limit);
}

export function createHeapAdaptor(options: HeapOptions): AnalyticsAdaptor {
  const appId = credential(options.appId, "Heap environment ID");
  const url = regionalHost(
    options.region,
    "https://heapanalytics.com/api/track",
    "https://c.eu.heap-api.com/api/track",
  );
  const send = createSender(options);
  return {
    provider: "heap",
    async deliver({ subjectId, event }, signal) {
      const properties = eventProperties(event);
      if (
        !subjectId.trim() ||
        exceedsCharacters(subjectId, 255) ||
        Object.values(properties).some(
          (value) => typeof value === "string" && exceedsCharacters(value, 1023),
        )
      )
        return invalidEvent;
      return send(
        {
          url,
          body: {
            app_id: appId,
            identity: subjectId,
            event: event.name,
            timestamp: event.occurredAt,
            properties,
            idempotency_key: event.id,
          },
        },
        signal,
        (status, body) =>
          status === 200 && object(body) && !body["error"] && body["success"] !== false
            ? accepted
            : invalidResponse,
      );
    },
  };
}
