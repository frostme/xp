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

interface MixpanelOptions extends HttpOptions {
  readonly projectId: string;
  readonly username: string;
  readonly password: string;
  readonly region?: "US" | "EU" | "IN";
}

export function createMixpanelAdaptor(options: MixpanelOptions): AnalyticsAdaptor {
  const projectId = credential(options.projectId, "Mixpanel project ID");
  const username = credential(options.username, "Mixpanel service account username");
  const password = credential(options.password, "Mixpanel service account password");
  if (username.includes(":")) throw new TypeError("Invalid Mixpanel service account username");
  const host =
    options.region === "IN"
      ? "https://api-in.mixpanel.com"
      : regionalHost(options.region, "https://api.mixpanel.com", "https://api-eu.mixpanel.com");
  const url = new URL("/import", host);
  url.searchParams.set("strict", "1");
  url.searchParams.set("project_id", projectId);
  const headers = {
    Authorization: "Basic " + Buffer.from(username + ":" + password).toString("base64"),
  };
  const send = createSender(options);
  return {
    provider: "mixpanel",
    deliver({ event, subjectId }, signal) {
      const body = [
        {
          event: event.name,
          properties: {
            ...eventProperties(event),
            distinct_id: subjectId,
            time: Date.parse(event.occurredAt),
            $insert_id: event.id,
            ip: 0,
          },
        },
      ];
      return send(
        { url: url.href, headers, body },
        signal,
        (status, reply) => {
          if (status !== 200 || !object(reply)) return invalidResponse;
          const failures = reply["failed_records"];
          return reply["code"] === 200 &&
            reply["num_records_imported"] === 1 &&
            reply["status"] === "OK" &&
            (failures === undefined || (Array.isArray(failures) && failures.length === 0))
            ? accepted
            : invalidResponse;
        },
        (status, reply) => {
          if (status !== 400 || !object(reply) || !Array.isArray(reply["failed_records"]))
            return invalidEvent;
          const [failure] = reply["failed_records"];
          if (
            reply["code"] !== 400 ||
            reply["num_records_imported"] !== 0 ||
            !object(failure) ||
            failure["index"] !== 0
          )
            return invalidResponse;
          const id = failure["insert_id"] ?? failure["$insert_id"];
          return id === undefined || id === event.id ? invalidEvent : invalidResponse;
        },
      );
    },
  };
}
