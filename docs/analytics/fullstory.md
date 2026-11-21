# Fullstory server events

Map each consenting user to the application-specific UID you already use to identify that person in Fullstory. Fullstory accepts up to 256 characters in `user.uid`. xp sends a user-associated event without a session reference. It counts toward the account's server event quota. [Event association](https://developer.fullstory.com/server/events/introduction/) · [Create Event](https://developer.fullstory.com/server/events/create-event/)

```ts
import { initializeXp } from "@frostme/xp/server";

const xp = await initializeXp({
  connection,
  analytics: {
    destinations: [{ key: "fullstory-shop", provider: "fullstory" }],
    async mapIdentity({ userId, destination }) {
      const profile = await hostAnalyticsProfile(userId);
      return profile?.allows(destination.key) ? profile.fullstoryUid : null;
    },
  },
});
```

Use a Fullstory account API key with permission to create events. The worker sends the key verbatim after the `Basic` authentication scheme. Both regions use `api.fullstory.com`. Fullstory routes the request according to the API key. Supply `region` if the worker should check the key against the expected residency. EU keys begin with `eu1.`. US keys begin with `na1.` or use the older key format. [Authentication](https://developer.fullstory.com/server/authentication/) · [Data residency](https://developer.fullstory.com/server/getting-started/#data-residency)

```ts
import { createAnalyticsWorker } from "@frostme/xp/analytics";
import { createFullstoryAdaptor } from "@frostme/xp/analytics/fullstory";

const worker = createAnalyticsWorker({
  connection,
  adaptors: {
    "fullstory-shop": createFullstoryAdaptor({ apiKey: secrets.fullstoryKey, region: "US" }),
  },
});
await worker.run({ signal: shutdown.signal });
```

The worker posts this example to `/v2/events` with `Idempotency-Key: 69d67977-3038-42ef-ad64-a75fb460bd49`. The ISO timestamp records when the membership was established.

```json
{
  "name": "xp.cohort.joined",
  "user": { "uid": "external-shopper" },
  "timestamp": "2026-11-01T12:00:01.234Z",
  "properties": {
    "xp_experiment_slug": "checkout",
    "xp_cohort_slug": "checkout_control",
    "xp_assignment_source": "automatic",
    "xp_event_version": 1
  }
}
```

Fullstory documents HTTP 200 with a JSON object for a successful Create Event request and shows `{}` as its example. xp records delivery on that acknowledgment. To view assignments, filter `xp.cohort.joined` by the event property `xp_experiment_slug` and group results by `xp_cohort_slug`. [Create Event](https://developer.fullstory.com/server/events/create-event/)

A worker interrupted after acceptance retries the same occurrence with an identical request body and idempotency key. Fullstory caches the result of an executed request and checks that the body matches on replay. Throttling and retryable server errors allow a fresh attempt. The key expires after 24 hours. Replaying after expiration can create another event. [Idempotent requests](https://developer.fullstory.com/server/idempotent-requests/)
