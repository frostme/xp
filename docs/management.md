# Mount experiment management

The host authorizes each operator request and chooses its mount path. The handler uses the initialized xp runtime and the host database. Visitor identity for cohort decisions is independent of operator permission.

```ts
import type { Request } from "express";

import { initializeXp } from "@frostme/xp/server";
import { createXpManagementHandler } from "@frostme/xp/server/management";

const runtime = await initializeXp({ connection });
const basePath = "/internal/experiments";
app.use(
  basePath,
  createXpManagementHandler<Request>({
    runtime,
    basePath,
    access(request) {
      // Read the authenticated session established by your host middleware.
      if (hasPermission(request, "experiments:manage")) return "manage";
      if (hasPermission(request, "experiments:view")) return "view";
      return "deny";
    },
  }),
);
```

A neutral Node HTTP host can call the same handler with its incoming request and response. Supply a third callback to handle URLs outside the mount. An omitted access callback denies access. Mount one handler per runtime. Set `origin` to the public HTTPS origin when TLS terminates at a proxy. For multiple processes serving the same mount, supply a shared 32-byte `cursorKey` so subsequent requests can resume a directory page on any replica. Rotating this key invalidates outstanding cursors.

Set `management.allowCreate` in the host's `xp.config.json` to permit managers to create experiments. Its default is false. The setting takes effect on initialization. Authorized managers can still operate existing experiments. Apply the generated storage migration before serving the mount. See [experiment configuration and managed rollouts](experiments.md).

## Management HTTP API

All routes below are relative to the mount. Responses are private and uncached. POST requests require `application/json`, the public page's `Origin` header and at most 64 KiB of JSON.

| Method | Route                                  | Result                                                                           |
| ------ | -------------------------------------- | -------------------------------------------------------------------------------- |
| GET    | `/api/capabilities`                    | Effective access and create permission                                           |
| GET    | `/api/experiments?q=checkout&limit=25` | Names, slugs, availability, phase, winner and continuation cursor                |
| GET    | `/api/experiments/:slug`               | Serving state, cohort definitions, current memberships, allowed actions and ETag |
| POST   | `/api/experiments`                     | Create from a slug and local cohort names, with off inserted when omitted        |
| POST   | `/api/experiments/:slug/commands`      | Apply a conditional lifecycle command                                            |

Continue a directory search by sending its `nextCursor` as `cursor` with the same search text. An empty page may have a continuation on DynamoDB. The default limit is 25 and the maximum is 100.

To launch or adjust, send a full split using qualified cohort slugs. Up to two decimal places are supported and percentages must total 100.

```json
{
  "type": "launch",
  "allocation": [
    { "cohort": "checkout_off", "percentage": 90 },
    { "cohort": "checkout_short", "percentage": 5 },
    { "cohort": "checkout_detailed", "percentage": 5 }
  ]
}
```

Use `{"type":"pause"}`, `{"type":"resume"}` or `{"type":"finalize","cohort":"checkout_off"}` for other commands. Send the detail response's ETag unchanged as `If-Match`. Repeating an already-satisfied command for the same experiment succeeds without incrementing the revision. A competing edit returns HTTP 409 and a refresh URL. Fetch that detail and review the new state before resubmitting. A conditional write with no ETag returns 428. Invalid fields return 422 with their names and messages. A missing experiment returns 404 and insufficient permission returns 403.

## Reading membership counts

A count measures current stored memberships, including explicit joins and assignments to off. A pinned winner can serve every visitor with zero memberships. A winner overrides previously assigned cohorts while their memberships stay intact. Leaving and rejoining update the counts. The read uses xp storage and works without an analytics provider.

SQL groups memberships by cohort. MongoDB aggregates one experiment in a snapshot transaction. DynamoDB uses strongly consistent, paginated count queries per cohort. Those queries can observe different instants during concurrent changes. The directory reads a bounded portion of the DynamoDB table per request. `countsReadAt` records completion of a successful read. A failed count read returns null for the timestamp and each cohort's count, so clients can offer a retry.

## Operator page

Open the configured base path in the host after signing in. Search the directory by name or slug. Each detail page distinguishes the current decision for existing and new members from the stored membership counts. Expand **Experiment definition** to inspect qualified cohort slugs and values. A manager sees the commands available for the current lifecycle phase. The host must also enable creation for **Create experiment** to appear.

The directory, `/create`, `/experiments/:slug` and `/experiments/:slug/split` accept direct links under the base path. Script and stylesheet requests stay on the same mount and use the same host authorization. The package supplies these assets. The host can use its existing Content Security Policy provided it allows the page's own scripts, styles and API connections.

Review each change before applying it. Adjusting the split affects future assignments. Pausing preserves the saved phase and memberships. Selecting a winner changes what existing members see. A failed save keeps the proposal available, and a competing edit offers **Review current values** before another submission.

## Fastify and NestJS

In Fastify, install the hook below after the host's session hook. The handler receives the authenticated raw request before Fastify parses its body. Return an explicit public `origin` in the handler options if the host terminates TLS upstream.

```ts
const handler = createXpManagementHandler({ runtime, basePath, access: operatorAccess });
fastify.addHook("onRequest", async (request, reply) => {
  const path = request.url.split("?", 1)[0];
  if (path === basePath || path?.startsWith(basePath + "/")) {
    reply.hijack();
    await handler(request.raw, reply.raw);
  }
});
```

For NestJS with Express, call `adapter.getInstance().use(basePath, handler)` on the application's `ExpressAdapter`. For NestJS with Fastify, install the hook on `adapter.getInstance()` before startup. Mount authentication explicitly on these routes. A Nest controller guard runs later in the request lifecycle. The host-package checks start real Express, standalone Fastify, Nest Express and Nest Fastify applications and verify authenticated and denied requests against the packed module.
