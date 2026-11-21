# Amplitude HTTP V2

Configure the producer with a stable destination key and a consent-aware identity mapper. Use the same external user ID your application sends to Amplitude.

```ts
import { initializeXp } from "@frostme/xp/server";

const xp = await initializeXp({
  connection,
  analytics: {
    destinations: [{ key: "amplitude-shop", provider: "amplitude" }],
    async mapIdentity({ userId, destination }) {
      const profile = await hostAnalyticsProfile(userId);
      return profile?.allows(destination.key) ? profile.amplitudeUserId : null;
    },
  },
});
```

In the worker process, use the project's API key and its data residency region. US is the default. EU projects ingest at `api.eu.amplitude.com`. Amplitude normally requires at least five characters for an identified user. Set `minIdLength: 1` through `1024` for a different minimum. xp checks the mapped ID before sending and passes the override in the HTTP V2 options. [HTTP V2 API](https://amplitude.com/docs/apis/analytics/http-v2)

```ts
import { createAnalyticsWorker } from "@frostme/xp/analytics";
import { createAmplitudeAdaptor } from "@frostme/xp/analytics/amplitude";

const worker = createAnalyticsWorker({
  connection,
  adaptors: {
    "amplitude-shop": createAmplitudeAdaptor({
      apiKey: secrets.amplitudeProjectKey,
      region: "US",
    }),
  },
});
await worker.run({ signal: shutdown.signal });
```

The example below is a single HTTP V2 upload to `POST https://api2.amplitude.com/2/httpapi`. The timestamp is the membership's occurrence time in milliseconds since the Unix epoch.

```json
{
  "api_key": "fixture-project-key",
  "events": [
    {
      "event_type": "xp.cohort.joined",
      "user_id": "external-shopper",
      "time": 1793534401234,
      "insert_id": "69d67977-3038-42ef-ad64-a75fb460bd49",
      "event_properties": {
        "xp_experiment_slug": "checkout",
        "xp_cohort_slug": "checkout_control",
        "xp_assignment_source": "automatic",
        "xp_event_version": 1
      }
    }
  ]
}
```

xp acknowledges this occurrence when the endpoint returns HTTP 200, JSON `code: 200` and `events_ingested: 1`. Network failures, throttling and server errors can trigger retries. The worker retains the occurrence UUID, mapped identity and time. A process exit after ingestion and before local acknowledgment can repeat the upload. Amplitude deduplicates matching insert IDs in the same app for seven days, with the same device ID when present. For these user-only events Amplitude derives the device ID from the user ID. Replays outside that window can count again. [HTTP V2 responses and deduplication](https://amplitude.com/docs/apis/analytics/http-v2)

In Event Segmentation, select `xp.cohort.joined`, filter the event property `xp_experiment_slug` to `checkout` and group by `xp_cohort_slug`.
