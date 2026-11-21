# Segment

Create an HTTP API source in Segment. The worker sends one Track request to `https://api.segment.io/v1/track` by default. Set `region: "EU"` for a source in an EU workspace. Its endpoint is `https://eu1.api.segmentapis.com/v1/track`. Use the source's write key as the HTTP Basic username with an empty password. [Segment HTTP API source](https://www.twilio.com/docs/segment/connections/sources/catalog/libraries/server/http-api)

The example uses a Segment source that forwards events to Mixpanel. Configure only the Segment destination in xp for this route. Adding a direct Mixpanel destination would send a second copy to the same project. The host reads its own consent records and returns the external ID used in Segment or `null` to skip the delivery.

```ts
import { initializeXp } from "@frostme/xp/server";

const xp = await initializeXp({
  connection,
  analytics: {
    destinations: [{ key: "segment-prod", provider: "segment" }],
    async mapIdentity({ userId, destination }) {
      const profile = await hostAnalyticsProfile(userId);
      return profile?.allows(destination.key) ? profile.segmentUserId : null;
    },
  },
});
```

Run a worker against the same database, with the source write key supplied by the host.

```ts
import { createAnalyticsWorker } from "@frostme/xp/analytics";
import { createSegmentAdaptor } from "@frostme/xp/analytics/segment";

const worker = createAnalyticsWorker({
  connection,
  adaptors: {
    "segment-prod": createSegmentAdaptor({ writeKey: secrets.segmentWriteKey, region: "US" }),
  },
});
await worker.run({ signal: shutdown.signal });
```

## Track request

```json
{
  "userId": "external-shopper",
  "event": "xp.cohort.joined",
  "properties": {
    "xp_experiment_slug": "checkout",
    "xp_cohort_slug": "checkout_control",
    "xp_assignment_source": "automatic",
    "xp_event_version": 1
  },
  "timestamp": "2026-11-01T12:00:01.234Z",
  "messageId": "69d67977-3038-42ef-ad64-a75fb460bd49"
}
```

The ISO timestamp records the original join in UTC. The adaptor rejects payloads over 32 KiB. A bounded HTTP 200 response with no explicit error acknowledges this request. Segment can return 200 before it filters a message or a downstream destination processes it. Use the Segment source debugger to trace a missing event. In the connected Mixpanel project, select `xp.cohort.joined`, filter `xp_experiment_slug` to `checkout` and break down by `xp_cohort_slug`. [Segment HTTP errors](https://www.twilio.com/docs/segment/connections/sources/catalog/libraries/server/http-api#errors)

Retries reuse the occurrence UUID as `messageId`. Segment describes roughly 99% deduplication over an approximately 24-hour look-back, across sources and workspaces. A repeat after a worker crash can still reach a destination, especially after that window. Two Segment outputs for the same join share a deduplication key even if they use different write keys. [Segment duplicate handling](https://www.twilio.com/docs/segment/guides/duplicate-data)
