# Heap

Use the environment ID from the Heap project that will receive cohort joins. Set `region: "EU"` for data in Heap's EU datacenter. The production Track endpoints are `https://heapanalytics.com/api/track` for US environments and `https://c.eu.heap-api.com/api/track` for EU environments. [Heap server-side APIs](https://developers.heap.io/reference/server-side-apis-overview)

Supply the case-sensitive external identity used in your Heap environment. Heap can create a user when it first sees a new identity. Return `null` when the host has no eligible identity. Heap reserves its alternate `user_id` field for numeric IDs assigned by its SDK. The adaptor sends mapped identities, including numeric-looking strings, in `identity`. [Heap Track](https://developers.heap.io/reference/track-1)

```ts
import { initializeXp } from "@frostme/xp/server";

const xp = await initializeXp({
  connection,
  analytics: {
    destinations: [{ key: "heap-prod", provider: "heap" }],
    async mapIdentity({ userId, destination }) {
      const profile = await hostAnalyticsProfile(userId);
      return profile?.allows(destination.key) ? profile.heapIdentity : null;
    },
  },
});
```

In the worker process, select the same destination key and supply the Heap environment ID as `appId`.

```ts
import { createAnalyticsWorker } from "@frostme/xp/analytics";
import { createHeapAdaptor } from "@frostme/xp/analytics/heap";

const worker = createAnalyticsWorker({
  connection,
  adaptors: {
    "heap-prod": createHeapAdaptor({ appId: secrets.heapAppId, region: "US" }),
  },
});
await worker.run({ signal: shutdown.signal });
```

## Track request

```json
{
  "app_id": "19384000",
  "identity": "external-shopper",
  "event": "xp.cohort.joined",
  "timestamp": "2026-11-01T12:00:01.234Z",
  "properties": {
    "xp_experiment_slug": "checkout",
    "xp_cohort_slug": "checkout_control",
    "xp_assignment_source": "automatic",
    "xp_event_version": 1
  },
  "idempotency_key": "69d67977-3038-42ef-ad64-a75fb460bd49"
}
```

The worker sends a single event with its original ISO 8601 UTC timestamp. Heap permits up to 255 characters for identity, 1,024 for the event name and 1,023 per property key or string value. Track allows 30 requests per 30 seconds per identity and environment. The worker reschedules a 429 and honors `Retry-After` when present. In Heap, analyze `xp.cohort.joined` with an `xp_experiment_slug` filter and group by `xp_cohort_slug`. [Heap Track limits](https://developers.heap.io/reference/track-1)

The adaptor acknowledges HTTP 200 with a bounded JSON object and no explicit error. Heap's OpenAPI example is `{}`. This confirms the Track request reached the endpoint. Heap hashes `idempotency_key` into its event ID space and leaves existing data intact when the key repeats. xp reuses the UUID when a worker crashes after acceptance. Heap's Track reference gives no fixed retention period for that key. [Heap Track response and idempotency](https://developers.heap.io/reference/track-1.md)
