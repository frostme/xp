# Ship analytics connectors for xp cohort joins

## Assignment for the implementation session

Implement opt-in, durable server-side delivery of new cohort memberships in `frostme/xp`. Ship one adaptor each for Amplitude, Segment, Mixpanel, Fullstory, Heap and PostHog. Finish with independently green stacked pull requests and an installed-package journey that starts a host, makes decisions, restarts a worker and verifies the actual outbound HTTP. Elliot owns merge and release.

Start from current `origin/main` in an isolated worktree. This plan was checked against `7915e0577fa3f55d61e1f81599ceb05b7e67fdff`. Read `AGENTS.md`, `docs/roadmap.md`, `docs/experiments.md`, `docs/cli.md` and the files below. Reconcile intervening changes and preserve existing public contracts. This file is the complete assignment and can run alongside the management-page session.

## What counts as a join

`xp.cohort.joined` v1 means that a new row or document establishing a user's membership committed. Generate one occurrence UUID and one UTC timestamp for that join. Deliver the same UUID and time to each eligible destination, including on retries. A later leave and rejoin gets a fresh UUID even if it restores the same cohort. Installations begin emitting with their first new eligible membership after enablement. Existing memberships need no backfill.

| Runtime action                                                                                                                          | Observable result                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| First successful automatic assignment through `getGroup`, `resolveCohort` or a decision transport                                       | One occurrence for the stored cohort. A newly bucketed `off` member also counts when the public response has `slug: null`.                            |
| Explicit successful `joinCohort`                                                                                                        | One occurrence, including a manual join while an enabled experiment has a pinned winner, or when the membership is created without a browser request. |
| Two concurrent attempts at the same membership, including mixed manual and automatic calls                                              | The transaction that inserts the membership owns the event. Preserve each caller's existing duplicate-resolution behavior.                            |
| Existing sticky membership, guest, missing user, paused decision, winner-only response, validation failure, failed or rolled-back write | Zero occurrences. Reading or returning a winner, including a pinned `off` winner, creates no automatic membership.                                    |
| Leave, configuration change, page view, exposure, conversion, pause, launch or finalization                                             | These operations generate zero analytics events in this release. An explicit subsequent successful join follows the rules above.                      |

Follow `src/use-cases/user/getGroup.ts` and `src/use-cases/user/joinCohort.ts` to `IUserDAO.addUserCohort`. Extend that write path so membership and pending deliveries share a transaction. Retain `src/interfaces/runtime.ts` as a narrow cohort decision contract. Use `src/server/index.ts` for runtime composition. Place vendor-free event types under entities/interfaces, capture and delivery rules in use cases, storage implementations under `src/adaptors/data-access` and vendor clients under `src/adaptors/analytics`. Keep the server-only exports isolated from the root and client module graphs. No browser SDK, signup, or provider call belongs on an xp decision path.

## Host configuration and payload

Use the following as the target public API. Adapt names to existing conventions if the installed TypeScript example stays this straightforward. The producer needs the destination keys and a required host mapper. Only the worker needs the credentials. `initializeXp` and the synchronous `server(connection, options)` constructor must support capture explicitly. Hosts that omit analytics can use their existing schema and process lifecycle. Keep `xp.config.json` dedicated to experiment declarations and management settings.

```ts
import { createAnalyticsWorker } from "@frostme/xp/analytics";
import { createAmplitudeAdaptor } from "@frostme/xp/analytics/amplitude";
import { createHeapAdaptor } from "@frostme/xp/analytics/heap";
import { initializeXp } from "@frostme/xp/server";

// App process. The host reads its own consent and identity records.
const xp = await initializeXp({
  connection,
  analytics: {
    destinations: [
      { key: "amplitude-prod", provider: "amplitude" },
      { key: "heap-prod", provider: "heap" },
    ],
    async mapIdentity({ userId, destination }) {
      const profile = await hostAnalyticsProfile(userId);
      if (!profile?.allows(destination.key)) return null;
      return profile.externalIdFor(destination.key); // string or null
    },
  },
});

// Worker process. Connect to the same xp database. Cron can call drainOnce().
const worker = createAnalyticsWorker({
  connection,
  adaptors: {
    "amplitude-prod": createAmplitudeAdaptor({ apiKey: secrets.amplitudeApiKey, region: "US" }),
    "heap-prod": createHeapAdaptor({ appId: secrets.heapAppId, region: "US" }),
  },
});
await worker.run({ signal: shutdown.signal });
```

Support native database/table options used by xp, including MongoDB `databaseName` and DynamoDB `tableName`. A host controls the worker, database pool, shutdown signal and polling schedule. `drainOnce()` claims at most one bounded batch and returns delivery counts. `run()` repeats bounded drains with cancellable idle waits. Neither imports nor constructing an xp runtime start timers or workers. Publish a provider-independent adaptor interface and working minimal custom-sink example alongside the six isolated provider subpaths.

Use this typed, immutable envelope for each destination. Generate the UUID independently of local SQL membership IDs.

```ts
interface CohortJoinedV1 {
  name: "xp.cohort.joined";
  version: 1;
  id: string; // occurrence UUID
  occurredAt: string; // UTC ISO timestamp
  experimentSlug: string;
  cohortSlug: string; // stored, fully qualified slug
  source: "automatic" | "manual";
}
interface PendingDelivery {
  event: CohortJoinedV1;
  destinationKey: string;
  provider: string;
  subjectId: string; // identity mapped specifically for this destination
}
```

The mapper sees the original typed host ID, including numeric zero, and the target destination key/provider. Define the portable v1 identity as the external identified-user string accepted by each chosen endpoint. An explicit null skips just that destination before persistence. Preserve numeric/string distinctions until the host maps them. The adaptor receives only its mapped identity, the envelope, and its own settings. Exclude the raw xp user ID from analytics storage and egress by default, plus request headers, cookies, cohort values, arbitrary user traits, destination credentials and the other destinations' mapped IDs. Carry the permission decision made at capture time into the immutable delivery. Document how hosts pause a destination and purge its pending work when revoking export permission.

Validate the opt-in settings before accepting traffic. Require unique stable destination keys, a known provider or custom adaptor identifier, a mapper, and usable mapped IDs. Treat thrown mapper errors and malformed mapped results as capture failures for an attempted new join. Do not silently commit an eligible membership with missing pending deliveries. Resolve any async mapping outside database locks, bound its wait, and stage pure candidate data that can be discarded if a concurrent writer wins. Recheck membership uniqueness in the transaction. An all-skipped join still commits successfully. A failed local capture can be retried by the caller. Provider HTTP errors occur only in the worker. Confirm the same distinctions in public error documentation.

## Atomic storage and upgrade

1. Persist an immutable event snapshot for each eligible destination, keyed uniquely by `(eventId, destinationKey)`. Capture destination keys/provider kinds at commit. Changes to configured outputs on later deployments apply to future joins. Never reroute queued work to a different vendor because a key was reused. Reject incompatible key bindings. Document draining/retiring old keys and rotating credentials while retaining identity and event ID.
2. In the membership transaction, insert membership and all eligible deliveries or roll everything back. Include the stored experiment/cohort slugs and occurrence time in the snapshot so successful delivery survives a later leave, rejoin or experiment deletion. Never infer pending work by scanning memberships. Preserve the response when a database commit succeeded but the client timed out and retried. Distinguish membership uniqueness conflicts from outbox errors in SQL, MongoDB and DynamoDB.
3. Implement the same contract for PostgreSQL, MySQL and SQL Server through `src/adaptors/data-access/relational.ts` and the three native and Sequelize 6 transaction/session implementations. For MongoDB insert both writes in the same existing `ClientSession` transaction and use indexed due-work/lease lookups. For DynamoDB extend `src/adaptors/data-access/dynamodb/store.ts`'s existing conditional `TransactWriteItems` for both membership keys and pending deliveries. Keep within item and request limits, check configured fan-out before capture, preserve the existing experiment condition classification (the baseline reads cancellation reason index `2`), and plan indexed or sharded due-work queries with pagination. No unbounded table scan in a worker poll. Use expiry and conditional lease ownership for each provider.
4. Introduce a separately versioned, opt-in analytics storage extension for `xp setup`, for example `--analytics` in noninteractive mode and a matching wizard choice. Include schema/models, indexes and migrations wherever existing SQL, Prisma, Drizzle, Sequelize, Mongo/Mongoose, Dynamo and other supported generator profiles require them. Read `src/adaptors/setup/{storage,projectManager}.ts`, `src/adaptors/setup/generators/`, `src/cli/` and `src/interfaces/setup.ts`. Track the analytics extension version separately from the base storage version so either roadmap feature can land first. When both extensions are available, run both installation orders on a fresh base and on an existing v2 installation. Generate additive artifacts for fresh installs, current v2 installations and the supported v1-to-current upgrade sequence. Preserve manifest checks, dry run, idempotent reruns, safety around edited files, and host-applied migrations. Existing rows, seed declarations, current decisions and setup profiles remain usable. Include migration and rollback/disable ordering, queued-work retention and explicit manual steps in the consumer guide. Verify opt-in startup against missing storage yields an actionable error before enabling capture, including a documented check for synchronous runtime construction.

## Delivery worker

Implement at-least-once delivery attempts per eligible destination. A single transaction or conditional operation must claim due records and issue a unique lease token/expiry per claim. Bound batch size, parallelism, HTTP timeouts, retry budget and shutdown duration. Fence every acknowledgment, reschedule, dead-letter transition and lease renewal by the claim token. Recover an abandoned claim when it expires. Use a database-consistent clock or an explicit clock-skew bound for multi-host leases. Share the event UUID with vendor deduplication fields. A process can die after provider acceptance and before the local acknowledgment. Describe that duplicate window and each provider's constraints in the public docs.

Track pending, claimed, delivered and terminal-failure states per destination. Respect `Retry-After` where supplied, cap exponential backoff and add jitter. Classify network timeouts, rate limits and transient vendor failures for retry. Record a short sanitized failure reason for a permanent rejection or exhausted retry budget. A failed provider must not starve healthy peers. Document finite defaults and configuration bounds. Leave pending work durable across deploys and exempt pending/claimed records from automatic TTL expiry. Supply bounded inspection, re-drive and retention/pruning APIs usable by the host. Replay uses the original event, mapped subject, ID and time. Successful rows and old dead letters may be pruned under an explicit retention policy. Never purge active/leased deliveries as a side effect of history cleanup. Provide host diagnostics for counts, age of oldest pending delivery, terminal failures and worker liveness. Omit credentials, raw subject IDs and provider payloads from default logs. A worker claims only keys for which it has a matching adaptor. Leave other keys pending, expose their backlog, and use the documented retirement procedure when an operator intentionally removes a destination.

Use the original occurrence time in every attempt. A successful provider response means the provider accepted that event under its documented contract. Diagnostic status should describe that point accurately when the vendor processes data asynchronously.

## Provider work packages

Recheck current official server APIs before shipping. For each provider document credentials, destination region/base URL, identity requirements, timestamp units, deduplication scope and the exact response that acknowledges an individual event. Prefer a one-event request for v1 where partial batch outcomes complicate acknowledgment. Use injected `fetch`/time or a local HTTP recorder for tests and a configured request timeout. Enforce reasonable response bounds and redact credential-bearing URLs, headers and bodies.

| Adaptor   | Required wire behavior and reference                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Amplitude | Send HTTP V2 `event_type`, mapped `user_id`, original millisecond `time`, `insert_id` and xp event properties. Document region and the default five-character ID minimum, including the supported override. Scope the seven-day duplicate suppression claim to the documented conditions. [HTTP V2](https://amplitude.com/docs/apis/analytics/http-v2)                                                                                                                                                   |
| Segment   | Send HTTP Track with source write key, `userId`, `event`, `properties`, original ISO `timestamp` and UUID `messageId`. Explain the approximate 24-hour duplicate window. Show one example where Segment forwards to Mixpanel and that direct Mixpanel destination is omitted to avoid double counting. [HTTP source](https://www.twilio.com/docs/segment/connections/sources/catalog/libraries/server/http-api) · [Duplicate handling](https://www.twilio.com/docs/segment/guides/duplicate-data)        |
| Mixpanel  | Use server `/import` with `strict=1`, documented auth, `distinct_id`, original `time` and `$insert_id` under event properties. Parse strict validation results. A partly invalid batch can already have ingested valid items. [Import Events](https://docs.mixpanel.com/reference/import-events)                                                                                                                                                                                                         |
| Fullstory | Send a v2 custom event associated with `user.uid` matching the host's existing Fullstory identity. Session association is optional. Use `Idempotency-Key` with the same request body and original event data on retry. Its key cache expires after 24 hours. [Event association](https://developer.fullstory.com/server/events/introduction/) · [Create event](https://developer.fullstory.com/server/events/create-event/) · [Idempotency](https://developer.fullstory.com/server/idempotent-requests/) |
| Heap      | Send server Track with `app_id`, external `identity`, `event`, original timestamp, properties and `idempotency_key`. Heap's alternative numeric `user_id` belongs to Heap's SDK. Never infer it from xp's numeric user ID. Exercise limits and regional ingestion. [Server Track](https://developers.heap.io/reference/track-1)                                                                                                                                                                          |
| PostHog   | Send Capture v1 analytics events with mapped `distinct_id`, UUID, original timestamp and event properties. Use the project-token bearer header, regional ingestion host and per-event response status. Document supported self-hosted endpoint versions. [Capture v1](https://posthog.com/docs/api/capture-v1) · [Event deduplication](https://posthog.com/docs/data/events)                                                                                                                             |

For each provider fixture, use the same synthetic membership and original timestamp. Publish the event name as `xp.cohort.joined` and use stable queryable properties such as `xp_experiment_slug`, `xp_cohort_slug`, `xp_assignment_source` and `xp_event_version`. Map the UUID to the vendor's deduplication field or header as well as retaining it in xp. Show the equivalent of “filter by experiment and group by cohort” in the consumer guide. No application secrets or actual customer identities belong in fixtures.

## Implementation and review order

Open a stack of green, reviewable PRs. Each PR targets its predecessor, supplies its contract tests and explains its place in the stack. The parent owns capture semantics and assembles the stack. Assign the three storage families to separate agents after the outbox contract is fixed. Assign each provider to a dedicated agent in waves as slots permit. Each returns its contract fixture, producer/worker configuration example and release evidence for the parent's review.

| PR  | Implement                                                                                                            | Acceptance before stacking the next PR                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Versioned event, destination/mapper and storage/adaptor ports, origin semantics, delivery state machine contracts.   | Deterministic unit tests cover mapping, skip, typed IDs, stable occurrence data, race semantics and fenced state transitions. Existing imports still work.                                                  |
| 2   | Analytics storage extension, generated schema and migration/manifest support.                                        | Fresh, v1 upgrade and v2 opt-in fixtures pass across generator profiles. Dry run, double run, edited ownership and analytics-disabled paths pass.                                                           |
| 3   | Atomic persistence and indexed claiming for native SQL and Sequelize dialects, Mongo and Dynamo.                     | Shared real-storage contract verifies atomicity, duplicate contention, lease takeover and delete/rejoin on every supported backend.                                                                         |
| 4   | Producer wiring through both membership paths, public opt-in configuration, custom adaptor port and host-run worker. | Crash/restart, partial multi-destination progress, temporary rejection, stale claim acknowledgment, bounded shutdown, terminal re-drive and redacted diagnostics pass locally.                              |
| 5   | Amplitude, Segment and Mixpanel adaptors under isolated subpaths.                                                    | Local HTTP protocol fixtures cover each provider's identity, auth, timestamps, stable keys and acknowledgment/error classification.                                                                         |
| 6   | Fullstory, Heap and PostHog adaptors, region and configuration examples.                                             | Equivalent per-provider tests, including Fullstory body replay and PostHog per-item rejection. All six pass the same adaptor contract.                                                                      |
| 7   | Packed-package journey, CLI setup documentation, operational guide, README and analytics roadmap entry.              | Disposable PostgreSQL host and a separate worker process deliver to six local HTTP receivers. Prove retry/recovery and stable keys at the HTTP boundary. Typecheck the public examples against the tarball. |

## Evidence required to finish

- Extend `src/__tests__/storage/contract.ts` or companion suites. Exercise native PostgreSQL, MySQL, SQL Server, MongoDB with transactions, DynamoDB and Sequelize 6 on all three SQL dialects. Prove forced rollback between membership and pending records, unique assignments under concurrent calls, eligible/declined destinations, zero-destination behavior, and pending payload survival after deleting a membership/experiment.
- Run real process and public-entry tests. Drive first/new, sticky, manual, duplicate race, guest, missing user, paused/winner, flag-off, DB failure, and leave/rejoin. At least one packed REST or GraphQL request and a second decision transport must share the event origin. Stop the worker before delivery, terminate a worker after an accepted request but before ack, then restart. Verify the outbox, stable HTTP payload, fenced ack and possible repeated send. Simulate 429 with `Retry-After`, 5xx, network timeout, bad credentials and permanent schema rejection. Configure a broken destination alongside a healthy one. Prove a disabled installation starts on its existing schema with no vendor credentials or worker.
- Exercise public package exports, JS/declarations, optional dependencies and Wireit cache inputs. The root import, browser clients and unrelated integrations must remain free of analytics providers. Run `bun install --frozen-lockfile`, `bun run ci`, `bun run test:integration`, `bun run test:transports`, `bun run test:hosts` and the applicable packed `bun run test:journey` and `bun run test:protocol-journey` jobs following `.github/workflows/ci.yml` and its service prerequisites. Add the new analytics journey to CI. Reliable automated delivery evidence comes from protocol-faithful local receivers. Only use a live vendor sandbox if explicitly available for this purpose, and label its evidence separately.
- Coordinate with the management session through existing xp contracts. Management owns experiment creation, pinned winners, weighted decisions, list/detail reads and current membership counts. Analytics owns the successful insert, immutable deliveries, its worker and its optional schema extension. Both sessions may touch `src/server/index.ts`, storage adapters, package exports, CLI setup, CI and the roadmap. Keep changes additive and narrowly scoped. Rebase against any landed changes and run the relevant suites. A pinned winner with no insert produces no event, and a real weighted off assignment produces one. An explicit join while the winner is pinned still emits when its insert succeeds. Verify these combinations if both features are present, using faithful equivalents on the baseline otherwise.
- Return ordered PR links, base/head revisions, live checks for each head, exact reproduction commands, upgrade/disable instructions, one example event as it appears in each provider and the limits on deduplication. The implementation is complete when the packed host reproduces the promised behavior with all six adaptors and the stack is ready for Elliot to review.
