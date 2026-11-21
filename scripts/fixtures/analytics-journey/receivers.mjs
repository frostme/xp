import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { once } from "node:events";
import { createServer } from "node:http";
import { URL } from "node:url";

const endpoints = {
  amplitude: ["https://api2.amplitude.com", "/2/httpapi"],
  segment: ["https://api.segment.io", "/v1/track"],
  mixpanel: ["https://api.mixpanel.com", "/import"],
  fullstory: ["https://api.fullstory.com", "/v2/events"],
  heap: ["https://heapanalytics.com", "/api/track"],
  posthog: ["https://us.i.posthog.com", "/i/v1/analytics/events"],
};

function reply(response, status, value, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(value));
}

export async function startReceivers(t) {
  const origins = {};
  const attempts = {};
  let repaired = false;
  for (const [provider, [origin, path]] of Object.entries(endpoints)) {
    const receipts = [];
    attempts[provider] = receipts;
    const receiver = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      const body = JSON.parse(raw);
      receipts.push({
        raw,
        body,
        headers: request.headers,
        url: request.url,
        method: request.method,
        receivedAt: Date.now(),
      });
      if (receipts.length === 1 && provider === "segment")
        return reply(response, 429, {}, { "Retry-After": "1" });
      if (receipts.length === 1 && provider === "mixpanel") return reply(response, 503, {});
      if (receipts.length === 1 && provider === "heap") return; // HTTP connection stays open until worker timeout.
      if (!repaired && provider === "fullstory")
        return reply(response, 401, { code: "unauthorized", message: "fixture secret" });
      if (provider === "posthog") {
        const result = repaired ? { result: "ok" } : { result: "drop", details: "invalid_options" };
        return reply(response, 200, { results: { [body.batch[0].uuid]: result } });
      }
      const success = {
        amplitude: {
          code: 200,
          events_ingested: 1,
          payload_size_bytes: Buffer.byteLength(raw),
          server_upload_time: Date.now(),
        },
        segment: { success: true },
        mixpanel: { code: 200, num_records_imported: 1, status: "OK" },
        fullstory: {},
        heap: {},
      };
      reply(response, 200, success[provider]);
    });
    receiver.listen(0, "127.0.0.1");
    await once(receiver, "listening");
    origins[provider] = "http://127.0.0.1:" + receiver.address().port;
    t.after(async () => {
      receiver.closeAllConnections();
      await new Promise((resolve) => receiver.close(resolve));
    });
    // Check the production URL and protocol received through the local transport.
    t.after(() => {
      for (const { headers, url, method } of receipts) {
        assert.equal(headers["x-fixture-original-origin"], origin);
        assert.equal(new URL(url, origin).pathname, path);
        assert.equal(method, "POST");
      }
    });
  }
  return {
    origins,
    attempts,
    repair: () => {
      repaired = true;
    },
  };
}

function eventFields(provider, { body, headers, url }) {
  switch (provider) {
    case "amplitude": {
      assert.equal(body.api_key, "amplitude-fixture");
      assert.equal(body.events.length, 1);
      const e = body.events[0];
      return [e.event_type, e.user_id, e.insert_id, e.time, e.event_properties];
    }
    case "segment":
      assert.equal(
        headers.authorization,
        "Basic " + Buffer.from("segment-fixture:").toString("base64"),
      );
      return [body.event, body.userId, body.messageId, Date.parse(body.timestamp), body.properties];
    case "mixpanel": {
      const params = new URL(url, endpoints.mixpanel[0]).searchParams;
      assert.equal(params.get("strict"), "1");
      assert.equal(params.get("project_id"), "42");
      assert.equal(
        headers.authorization,
        "Basic " + Buffer.from("fixture-account:fixture-password").toString("base64"),
      );
      assert.equal(body.length, 1);
      const { event, properties } = body[0];
      const time = properties.time;
      return [
        event,
        properties.distinct_id,
        properties.$insert_id,
        time < 10 ** 12 ? time * 1000 : time,
        properties,
      ];
    }
    case "fullstory":
      assert.equal(headers.authorization, "Basic fullstory-fixture");
      return [
        body.name,
        body.user.uid,
        headers["idempotency-key"],
        Date.parse(body.timestamp),
        body.properties,
      ];
    case "heap":
      assert.equal(body.app_id, "12345");
      assert.equal(body.user_id, undefined);
      return [
        body.event,
        body.identity,
        body.idempotency_key,
        Date.parse(body.timestamp),
        body.properties,
      ];
    case "posthog": {
      assert.equal(headers.authorization, "Bearer phc_fixture");
      assert.ok(headers["posthog-sdk-info"].includes("/"));
      assert.ok(headers["user-agent"]);
      assert.ok(Number.isFinite(Date.parse(headers["posthog-request-timestamp"])));
      assert.equal(body.batch.length, 1);
      const e = body.batch[0];
      return [e.event, e.distinct_id, e.uuid, Date.parse(e.timestamp), e.properties];
    }
    default:
      throw new Error("Unknown fixture provider");
  }
}

export function checkReceipts(attempts, id, occurredAt, cohort) {
  const stamp = new Date(occurredAt).getTime();
  assert.ok(Number.isFinite(stamp));
  for (const [provider, receipts] of Object.entries(attempts)) {
    assert.equal(receipts.length, 2, provider + " made two attempts");
    for (const receipt of receipts) {
      const [name, subject, uuid, time, props] = eventFields(provider, receipt);
      assert.equal(name, "xp.cohort.joined");
      assert.equal(subject, "external-" + provider + "-shop");
      assert.equal(uuid, id);
      assert.equal(
        time,
        provider === "mixpanel" && time % 1000 === 0 ? Math.floor(stamp / 1000) * 1000 : stamp,
      );
      assert.equal(props.xp_experiment_slug, "delivery-copy");
      assert.equal(props.xp_cohort_slug, cohort);
      assert.equal(props.xp_assignment_source, "automatic");
      assert.equal(props.xp_event_version, 1);
      assert.doesNotMatch(receipt.raw, /shopper|session-1|Bearer /);
      for (const other of Object.keys(attempts)) {
        if (provider !== other) assert.ok(!receipt.raw.includes("external-" + other + "-shop"));
      }
    }
  }
  for (const provider of ["amplitude", "fullstory"]) {
    assert.equal(
      attempts[provider][1].raw,
      attempts[provider][0].raw,
      provider + " replays the original bytes",
    );
  }
  assert.equal(
    attempts.posthog[0].headers["posthog-request-id"],
    attempts.posthog[1].headers["posthog-request-id"],
  );
  assert.ok(
    attempts.segment[1].receivedAt - attempts.segment[0].receivedAt >= 950,
    "Retry-After postponed the second Segment request",
  );
}
