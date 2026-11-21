# Mixpanel cohort joins

Register the destination in the app and return the consented Mixpanel distinct ID for each account. Use the same identified-user string your application already sends to this project. Check Mixpanel's list of reserved IDs when mapping accounts, including `"0"`, `"anonymous"` and `"unknown"`. [Import Events](https://docs.mixpanel.com/reference/import-events)

```ts
import { initializeXp } from "@frostme/xp/server";

const xp = await initializeXp({
  connection,
  analytics: {
    destinations: [{ key: "mixpanel-shop", provider: "mixpanel" }],
    async mapIdentity({ userId, destination }) {
      const profile = await hostAnalyticsProfile(userId);
      return profile?.allows(destination.key) ? profile.mixpanelId : null;
    },
  },
});
```

The worker needs the project ID and the username and password of an Owner or Admin service account for that project. Select the project's data residency with `region`. US uses `api.mixpanel.com` by default, EU uses `api-eu.mixpanel.com`, and IN uses `api-in.mixpanel.com`. The adaptor sends HTTP Basic authentication over HTTPS. [Import Events](https://docs.mixpanel.com/reference/import-events)

```ts
import { createAnalyticsWorker } from "@frostme/xp/analytics";
import { createMixpanelAdaptor } from "@frostme/xp/analytics/mixpanel";

const worker = createAnalyticsWorker({
  connection,
  adaptors: {
    "mixpanel-shop": createMixpanelAdaptor({
      projectId: secrets.mixpanelProjectId,
      username: secrets.mixpanelUsername,
      password: secrets.mixpanelPassword,
      region: "US",
    }),
  },
});
await worker.run({ signal: shutdown.signal });
```

Each request posts a one-element JSON array to `/import?strict=1&project_id=42`. The `time` property carries the original UTC occurrence time in milliseconds since the Unix epoch. Setting `ip` to zero disables geolocation from the worker's network address. In Mixpanel Insights, select `xp.cohort.joined`, filter by `xp_experiment_slug`, and break down by `xp_cohort_slug`. [Import Events](https://docs.mixpanel.com/reference/import-events)

```json
[
  {
    "event": "xp.cohort.joined",
    "properties": {
      "distinct_id": "external-shopper",
      "$insert_id": "69d67977-3038-42ef-ad64-a75fb460bd49",
      "time": 1793534401234,
      "xp_experiment_slug": "checkout",
      "xp_cohort_slug": "checkout_control",
      "xp_assignment_source": "automatic",
      "xp_event_version": 1,
      "ip": 0
    }
  }
]
```

xp records delivery when HTTP 200 reports code 200, status `OK`, one imported record and zero reported failures. With strict validation, a 400 can include both imported and rejected records in a larger batch. Each xp request contains one join, so a rejection at index zero identifies that delivery. xp retains a sanitized failure code. [Import Events](https://docs.mixpanel.com/reference/import-events)

Retries preserve the event name, distinct ID, time and insert ID. Mixpanel uses these four fields for query-time deduplication. Raw exports can contain duplicate rows. Storage compaction runs on a variable schedule and can group events occurring on the same calendar day. A rejoin gets a new insert ID. [Event deduplication](https://docs.mixpanel.com/reference/event-deduplication)
