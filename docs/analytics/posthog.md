# PostHog cohort joins

Use your existing identified-user string as the destination's mapped ID. Keep it within 200 UTF-8 bytes, and return `null` when the account has declined export. PostHog may disable person processing for placeholder identifiers. [Capture v1](https://posthog.com/docs/api/capture-v1)

```ts
import { initializeXp } from "@frostme/xp/server";

const xp = await initializeXp({
  connection,
  analytics: {
    destinations: [{ key: "posthog-shop", provider: "posthog" }],
    async mapIdentity({ userId, destination }) {
      const profile = await hostAnalyticsProfile(userId);
      return profile?.allows(destination.key) ? profile.posthogDistinctId : null;
    },
  },
});
```

Give the worker the project's ingestion token. The default US host is `https://us.i.posthog.com`. Select `region: "EU"` for `https://eu.i.posthog.com`. For self-hosted Capture v1, set `host` to the base URL of an instance running commit `1d6f4d0` (October 21, 2026) or later. A reverse proxy must forward the entire Capture v1 path, authorization and PostHog headers and return the ingestion response. [Capture v1 endpoints](https://posthog.com/docs/api/capture-v1)

```ts
import { createAnalyticsWorker } from "@frostme/xp/analytics";
import { createPostHogAdaptor } from "@frostme/xp/analytics/posthog";

const worker = createAnalyticsWorker({
  connection,
  adaptors: {
    "posthog-shop": createPostHogAdaptor({
      projectToken: secrets.posthogProjectToken,
      region: "US",
    }),
  },
});
await worker.run({ signal: shutdown.signal });
```

The worker posts this single-event batch to `/i/v1/analytics/events` with bearer authentication. It sends the occurrence UUID as the request ID, the installed xp version in the SDK and user-agent headers, the current claim attempt in `PostHog-Attempt`, and a fresh UTC send time in `PostHog-Request-Timestamp`. The batch and event keep the original RFC 3339 timestamp to millisecond precision. Disabling clock-skew correction preserves the occurrence time during replay. PostHog can still replace timestamps over 23 hours in the future. [Capture v1](https://posthog.com/docs/api/capture-v1)

```json
{
  "created_at": "2026-11-01T12:00:01.234Z",
  "batch": [
    {
      "event": "xp.cohort.joined",
      "uuid": "69d67977-3038-42ef-ad64-a75fb460bd49",
      "distinct_id": "external-shopper",
      "timestamp": "2026-11-01T12:00:01.234Z",
      "options": { "disable_skew_correction": true },
      "properties": {
        "xp_experiment_slug": "checkout",
        "xp_cohort_slug": "checkout_control",
        "xp_assignment_source": "automatic",
        "xp_event_version": 1
      }
    }
  ]
}
```

A 2xx response carries a `results` object keyed by UUID. The worker acknowledges `ok` and `warning`, retries `retry`, and records a terminal failure for `drop`. The Capture SDK contract also acknowledges unknown verdict names and UUIDs omitted from a readable results map. An unreadable results map produces a failure. PostHog can report `ok` for a well-formed token belonging to no project, so verify the configured token in the target project. [Capture v1](https://posthog.com/docs/api/capture-v1) · [Capture SDK response contract](https://github.com/PostHog/sdk-specs/blob/main/openspec/specs/capture/spec.md)

Create a Trends insight for `xp.cohort.joined`, filter by `xp_experiment_slug`, and break down by `xp_cohort_slug`. Background merges deduplicate repeated events with the same UUID, name, distinct ID and UTC occurrence date. Insights and SQL can temporarily count both. Downstream webhooks and exports can observe repeats. [PostHog event deduplication](https://posthog.com/docs/data/events)
