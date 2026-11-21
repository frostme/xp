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

interface SegmentOptions extends HttpOptions {
  readonly writeKey: string;
  readonly region?: "US" | "EU";
}

export function createSegmentAdaptor(options: SegmentOptions): AnalyticsAdaptor {
  const key = credential(options.writeKey, "Segment source write key");
  if (key.includes(":"))
    throw new TypeError("A Segment Basic Auth write key cannot contain a colon");
  const authorization = "Basic " + Buffer.from(key + ":", "utf8").toString("base64");
  const url = regionalHost(
    options.region,
    "https://api.segment.io/v1/track",
    "https://eu1.api.segmentapis.com/v1/track",
  );
  const send = createSender(options);
  return {
    provider: "segment",
    async deliver({ subjectId, event }, signal) {
      const body = {
        userId: subjectId,
        event: event.name,
        properties: eventProperties(event),
        timestamp: event.occurredAt,
        messageId: event.id,
      };
      if (Buffer.byteLength(JSON.stringify(body), "utf8") > 32 * 1024) return invalidEvent;
      return send(
        { url, headers: { Authorization: authorization }, body },
        signal,
        (status, response) => {
          if (
            status !== 200 ||
            (object(response) && (response["success"] === false || response["error"]))
          )
            return invalidResponse;
          return accepted;
        },
      );
    },
  };
}
