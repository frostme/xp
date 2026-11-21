# Deliver cohort joins to analytics

Enable capture in the app that assigns cohorts and run a separate worker against the same xp database. The server writes the membership and its delivery snapshots in one transaction. The worker sends one HTTP request per destination and owns every retry. Applications choose their destinations, consent rules and external identities.

## Enable capture

1. Run `xp setup --analytics --dry-run` with your normal storage profile. Review the generated files, run setup again to write them, and apply the migrations with your application's deployment tooling. The wizard offers the same choice for backend setup. Existing v2 installations receive an additive analytics v1 extension. For v1 installations, apply the base availability upgrade before the analytics migration. Keep the existing setup manifest so the planner can check ownership and version history. [Setup profiles and migration tooling](cli.md)
2. Deploy the capture configuration to every process that can create a membership. Supply stable, lowercase destination keys and the provider identifier for each. An empty destination list is valid. A custom identifier uses `custom:<name>`. Configure at most 32 destinations. A key permanently identifies one provider in this database. Use a new key when switching vendors.
3. Start the worker with credentials for the configured keys. A worker can serve a subset. Omitted keys keep their backlog. Credentials can rotate independently of stored deliveries. MongoDB hosts pass `databaseName` and DynamoDB hosts pass `tableName` to both the producer and worker. Wait for the DynamoDB index to report ACTIVE before starting either.

```ts
import { initializeXp } from "@frostme/xp/server";

const xp = await initializeXp({
  connection,
  analytics: {
    destinations: [
      { key: "product-us", provider: "amplitude" },
      { key: "warehouse", provider: "custom:warehouse" },
    ],
    async mapIdentity({ userId, destination, signal }) {
      const account = await accounts.analyticsProfile(userId, { signal });
      if (!account?.allowsAnalytics(destination.key)) return null;
      return account.identifiedUser(destination.key);
    },
  },
});
```

The application supplies `accounts` and its connected database. The mapper sees the original string or numeric host ID, including zero. Return an external identified-user string for that destination, or `null` to decline it. Identity strings must contain non-whitespace text, be well-formed Unicode, contain no NUL and fit in 1,024 UTF-8 bytes. Individual vendor limits also apply. The mapper can run for competing candidates. Read consent and identity without side effects, honor its abort signal and avoid logging the argument. xp maps destinations together before entering the transaction. The default deadline for the group is 2,000 ms. Set `mappingTimeoutMs` to an integer from 1 through 30,000.

`initializeXp` checks storage and destination bindings before seeding or returning. With synchronous construction, use `const xp = server(connection, { analytics })` and await `xp.checkAnalyticsStorage()` before listening. A first eligible capture also checks readiness. An installation that omits `analytics` needs only its existing schema. Keep destination settings and credentials in host configuration. `xp.config.json` holds experiment declarations.

## Which action creates a delivery

| Action                                                                                                       | Result                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First successful automatic assignment via a decision transport, `resolveCohort` or `getGroup`                | One new occurrence with source `automatic`. A stored flag-off cohort counts even when the decision response has `slug: null`.                                    |
| Successful explicit `joinCohort`                                                                             | One new occurrence with source `manual`, including a join while an enabled experiment has a pinned winner.                                                       |
| Two callers race to assign the same user                                                                     | The successful insert owns the occurrence. Automatic callers resolve the existing assignment on a duplicate. Manual duplicate joins retain their existing error. |
| Guests, missing users, paused decisions, reads of sticky or winning cohorts, rejected or rolled-back inserts | Zero occurrences.                                                                                                                                                |
| Leave, experiment changes, page views, conversions or finalization                                           | Zero occurrences. A later successful rejoin gets a fresh UUID.                                                                                                   |

The event uses the stored, fully qualified cohort slug. Each consenting destination receives its own snapshot of the same UUID, UTC occurrence time, version and source, plus its own mapped subject. A later change of credentials, configuration, membership or experiment cannot change those facts. Capture begins with newly created memberships. A local mapper failure, invalid mapped value, timeout or outbox write failure rejects the attempted join. Retrying a decision after a lost commit acknowledgment finds the sticky membership. Provider outages affect the worker alone.

```json
{
  "name": "xp.cohort.joined",
  "version": 1,
  "id": "69d67977-3038-42ef-ad64-a75fb460bd49",
  "occurredAt": "2026-11-01T12:00:01.234Z",
  "experimentSlug": "checkout",
  "cohortSlug": "checkout_control",
  "source": "automatic"
}
```

## Run a worker

```ts
import { createAnalyticsWorker, type AnalyticsAdaptor } from "@frostme/xp/analytics";
import { createAmplitudeAdaptor } from "@frostme/xp/analytics/amplitude";

const warehouse: AnalyticsAdaptor = {
  provider: "custom:warehouse",
  async deliver({ event, subjectId }, signal) {
    const response = await fetch(process.env.WAREHOUSE_INGEST_URL!, {
      method: "POST",
      signal,
      headers: {
        Authorization: "Bearer " + process.env.WAREHOUSE_TOKEN!,
        "Content-Type": "application/json",
        "Idempotency-Key": event.id,
      },
      body: JSON.stringify({ event, subjectId }),
    });
    await response.body?.cancel();
    // This host endpoint returns 204 only after it durably accepts the event.
    if (response.status === 204) return { status: "accepted" };
    if (response.status === 429) return { status: "retry", reason: "rate-limited" };
    if (response.status >= 500) return { status: "retry", reason: "provider-unavailable" };
    return { status: "rejected", reason: "invalid-event" };
  },
};
const worker = createAnalyticsWorker({
  connection,
  adaptors: {
    "product-us": createAmplitudeAdaptor({ apiKey: process.env.AMPLITUDE_API_KEY!, region: "US" }),
    warehouse,
  },
});
const shutdown = new AbortController();
process.once("SIGTERM", () => shutdown.abort());
await worker.run({ signal: shutdown.signal });
```

The host owns the database connection and closes it after worker shutdown. Imports and constructors start no timers. For cron, call `await worker.drainOnce()` and read `claimed`, `delivered`, `rescheduled`, `failed` and `lost`. A lost claim indicates the acknowledgment missed its lease. A drain visits destinations in rotation, starts at most the configured number of concurrent sends and returns after at most one batch. Run multiple worker instances for more capacity. A single instance accepts one drain at a time.

| Worker option      |   Default | Accepted range                                                    |
| ------------------ | --------: | ----------------------------------------------------------------- |
| `batchSize`        |        32 | 1–128 claims per drain                                            |
| `parallelism`      |         4 | 1–32 concurrent attempts                                          |
| `requestTimeoutMs` |     5,000 | 100–60,000 ms                                                     |
| `leaseMs`          |    30,000 | 1,000–300,000 ms, at least 500 ms longer than the request timeout |
| `pollMs`           |     1,000 | 10–60,000 ms between empty drains                                 |
| `maxAttempts`      |         8 | 1–100 claims, including interrupted attempts                      |
| `baseDelayMs`      |     1,000 | 1 ms through `maxDelayMs`                                         |
| `maxDelayMs`       | 3,600,000 | `baseDelayMs` through 86,400,000 ms                               |

Synchronize worker clocks to within **250 ms of each other**. The worker reserves this margin before the lease expires. Every state transition checks the unique lease token and expiry in storage. Cancellation returns control to the host, aborts cooperative HTTP work, and lets abandoned claims expire. A driver call already issued can still finish. Configure driver connection and query timeouts for your shutdown policy. A database error rejects the drain or polling loop so the host supervisor can report it and restart. HTTP failures follow the per-destination retry policy.

Transient errors use capped exponential backoff with jitter. A valid provider `Retry-After` can extend the local cap. A delay beyond 30 days or an exhausted retry budget parks the row for inspection. Provider acceptance followed by a process crash before acknowledgment can cause a repeated send with the original UUID and occurrence time. “Delivered” means the endpoint accepted the event according to its response contract. Visibility in reports can follow asynchronously.

## Operate and retire destinations

- Use `await worker.destinations(afterKey, limit)` to discover registered keys in ascending order, including keys omitted from the current worker. Start with `null` and pass the last key to page. `diagnostics(key)` returns counts by state, the oldest queued occurrence time and its age in milliseconds. `worker.liveness` reports this process's active drain and its last start and completion times. Publish these through the host's own health checks.
- `inspect(key, "failed", 50)` returns event IDs, times, attempt counts and sanitized reason codes. It excludes the mapped identity, payload, response, lease token and credentials. Fix a terminal failure and call `redrive(key, eventId)` to queue the stored snapshot again with a fresh attempt budget.
- To pause delivery, remove the adaptor key from every worker and let any in-flight request finish. To stop new capture, remove that destination from every producer or make its mapper return `null`. Consent is snapshotted on insertion. Removing a key from a producer leaves older deliveries queued.
- To revoke queued export permission, first stop new capture for the key and quiesce every worker serving it. Call `purge(key, limit)` until it returns zero. It deletes pending rows and expired claims. Wait out any active leases and repeat, then verify diagnostics. This operation discards pending exports for the entire destination. A provider may already have received an in-flight request.
- To retire a key while preserving delivery, stop new capture, keep its worker running until pending and claimed counts reach zero, and resolve remaining dead letters. To trim history, repeatedly call `prune(key, cutoffEpochMs, limit)` under a host retention policy. It removes delivered or terminal rows finalized strictly before the cutoff. Pending and claimed work has no automatic expiry. The registry retains the key/provider binding.
- To disable the extension, first stop capture, then drain or explicitly purge pending work, stop all workers and back up any history you need. Leaving the extension installed retains queued rows for re-enablement. Removing extension tables or collections destroys their history. For DynamoDB, removing the GSI removes the worker's lookup path and leaves base-table items in place. Apply only the analytics teardown for your profile after verifying the backlog and the backup. Keep the base membership schema.

Inspection and cleanup default to 50 and 100 rows respectively and accept limits from 1 to 1,000. Database permissions must cover extension reads, writes and startup checks. DynamoDB also requires `DescribeTable`, transactional writes and index queries. Its due index and indexed inspection can briefly lag recent commits.

## Provider events and reports

Filter the event name to `xp.cohort.joined`, filter `xp_experiment_slug` to `checkout` and group by `xp_cohort_slug`. The values `checkout_control` and `checkout_treatment` distinguish the stored cohorts. `xp_assignment_source` separates manual and automatic joins. Count distinct event UUIDs when reconciling retries across systems.

| Destination | Wire event, credentials, regions and deduplication              |
| ----------- | --------------------------------------------------------------- |
| Amplitude   | [HTTP V2 event](analytics/amplitude.md)                         |
| Segment     | [HTTP Track event and downstream routing](analytics/segment.md) |
| Mixpanel    | [Strict Import event](analytics/mixpanel.md)                    |
| Fullstory   | [Identified v2 custom event](analytics/fullstory.md)            |
| Heap        | [Server Track event](analytics/heap.md)                         |
| PostHog     | [Capture v1 batch of one](analytics/posthog.md)                 |

Each provider has its own package subpath. All use the shared xp occurrence UUID across attempts. If Segment already forwards cohort joins to Mixpanel, configure only the Segment destination for that route.

## Reproduce the installed-package evidence

```sh
bun install --frozen-lockfile
docker compose -f docker-compose.test.yml up -d --wait postgres
bun run build
bun run test:analytics-journey
```

The journey installs the packed package in a temporary consumer, typechecks its imports, applies generated SQL in a disposable PostgreSQL schema, starts authenticated HTTP transports and forks real worker processes. Six loopback HTTP receivers record the wire events. The test kills a worker after a receiver accepts an event, restarts delivery, verifies repeated identity, timestamp and deduplication fields, and exercises rate limiting, timeouts, temporary failures, permanent rejections and re-drive. It uses synthetic subjects and credentials.
