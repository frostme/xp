# Serving experiments to React

Install `@frostme/xp`, React 19, your database driver, and the host framework you use. These examples use Express 5, GraphQL Yoga 6, or Apollo Server 5 with GraphQL 16. The application authenticates each request and owns its database connection.

## Initialize before accepting requests

Generate storage with `xp setup`, review its files, and apply the migration through your normal deployment process. For an existing installation, run setup in the directory containing its v1 `.xp/setup.json` and apply the v2 upgrade before deploying the new server. The CLI guide covers ORM-specific setup and generated files. [CLI guide](cli.md)

Place this `xp.config.json` in the application's working directory.

```json
{
  "experiments": [
    { "slug": "checkout-banner", "cohorts": ["off", "on"] },
    { "slug": "delivery-copy", "cohorts": ["control", "short", "detailed"] }
  ]
}
```

```ts
import { initializeXp } from "@frostme/xp/server";

const xp = await initializeXp({ connection: appDatabase });
console.log(xp.driverKind, xp.dialect, xp.seedReport);
```

Pass a connected pg client/pool, mysql2 promise client/pool, mssql pool, MongoClient with `databaseName`, or DynamoDBDocumentClient with `tableName`. A Sequelize 6 instance supports PostgreSQL with pg, MySQL with mysql2, and SQL Server with tedious. Keep the instance connected while serving requests. Use `server(connection, options)` from the same entry point for synchronous construction.

`cwd` defaults to the working directory. `configPath` selects an explicit path relative to it. A missing conventional file produces empty `created` and `skipped` lists. An explicit missing file, invalid declaration or failed write rejects startup. The file accepts only unique kebab-case experiment slugs and at least two distinct local cohort names per experiment. DynamoDB allows up to 32 initial cohorts. xp validates all declarations before writing, then commits each new experiment and its cohorts together. The first cohort is the control. The exact on/off pair forms a flag. Other pairs are simple experiments, and larger groups are multivariate. Stored percentages sum to 100 and the current bucketer chooses uniformly.

Initialization skips every existing experiment, including cohorts added to its JSON declaration. Removing a declaration leaves its data in storage. A retry after a partial boot can create the remaining experiments. Use the server management API to edit live definitions. Both availability operations are idempotent.

```ts
await xp.pauseExperiment("checkout-banner");
await xp.resumeExperiment("checkout-banner");
const decision = await xp.resolveCohort(userId, "checkout-banner");
```

A missing identity or missing application user resolves to `{ slug: null }`. Create the application user through your normal account lifecycle. A paused experiment also resolves to null. Resuming restores winner-first resolution, followed by a sticky assignment or new bucketing. An assigned flag-off slug maps to null for the public decision. The existing `getGroup` method returns the stored off slug. A missing experiment for a known user is an error.

## Express

In the following examples, `authenticateSession(cookie)` represents your application's existing session verification. It returns an account with a string or numeric `id`, or null for a guest.

```ts
import { xpMiddleware } from "@frostme/xp";
import express from "express";

const app = express();
app.locals.xp = xp;
const api = express.Router();
api.use(async (req, _res, next) => {
  const account = await authenticateSession(req.get("cookie"));
  Object.assign(req, { userId: account?.id });
  next();
});
api.use(xpMiddleware);
app.use("/api", api);
app.listen(3000);
```

The default route accepts `POST /api/xp` with `{"slug":"checkout-banner"}` and returns `{"slug":"checkout-banner_on"}` or `{"slug":null}`. Responses carry `Cache-Control: private, no-store`. Invalid JSON or slugs return 400, unknown experiments return 404, and unexpected errors return 500. A Node diagnostics-channel subscriber to `xp.request.error` can forward internal errors to your host logger.

Configure the handler with `route`, `connection`, `userId`, `header`, and `resolveBody`. An explicit async-capable identity callback takes priority over a configured header and then the default `req.userId`. If the selected source is empty, the decision is null. Use an identity header only when an authenticated host or trusted proxy owns its value. A string connection hint such as `"sequelize"` validates the registered runtime. Supplying a runtime or raw database connection overrides registration. For a raw instance, finish initialization in application startup.

```ts
import { createRestLoader } from "@frostme/xp/client";

api.use(
  xpMiddleware({
    route: "/variant",
    connection: xp,
    header: "x-authenticated-account",
    resolveBody: ({ slug }) => ({ variant: slug }),
  }),
);
const load = createRestLoader({
  endpoint: "/api/variant",
  credentials: "same-origin",
  decode: (value) => {
    if (typeof value !== "object" || value === null || !("variant" in value)) {
      throw new Error("Missing variant");
    }
    return value.variant;
  },
});
```

## GraphQL Yoga and Apollo Server

Extend the existing executable schema once at startup. xp adds `xpResolveCohort(slug: String!): XPCohortResult!` to the mutation root because first resolution can create an assignment. The result's `slug` is nullable. The extension checks for name collisions, creates a mutation root when needed, and preserves other fields and resolvers, including custom root names. For a new schema the factory also exposes `typeDefs` and `resolvers`.

```ts
import { createXpGraphQL } from "@frostme/xp/server/graphql";
import { createYoga } from "graphql-yoga";
import { createServer } from "node:http";

const schema = createXpGraphQL().extendSchema(applicationSchema);
const yoga = createYoga({
  schema,
  context: async ({ request }) => ({
    xp,
    userId: (await authenticateSession(request.headers.get("cookie")))?.id,
  }),
});
createServer(yoga).listen(4000);
```

```ts
import { ApolloServer } from "@apollo/server";
import { startStandaloneServer } from "@apollo/server/standalone";
import { createXpGraphQL } from "@frostme/xp/server/graphql";

const server = new ApolloServer({
  schema: createXpGraphQL().extendSchema(applicationSchema),
});
await startStandaloneServer(server, {
  listen: { port: 4001 },
  context: async ({ req }) => ({
    xp,
    userId: (await authenticateSession(req.headers.cookie))?.id,
  }),
});
```

Supply `userId: context => ...` to read a different authentication property. With an explicit header option, Yoga provides `context.request.headers`. Apollo hosts can expose a Fetch-compatible `context.headers` or provide a callback. Keep this personalized mutation outside shared response caching. The host handles invalid GraphQL documents and missing variables. An invalid experiment slug, unknown experiment for a known user, and unexpected failure use `BAD_USER_INPUT`, `NOT_FOUND`, and `INTERNAL_SERVER_ERROR` respectively.

```ts
import { createGraphQLLoader } from "@frostme/xp/client";

const load = createGraphQLLoader({ endpoint: "/api/graphql" });
const slug = await load("delivery-copy", { signal });
```

Both loaders accept an endpoint, `fetch`, `credentials`, and `headers`. The REST loader also accepts `decode`. The GraphQL loader sends the named `XpResolveCohort` mutation with a slug variable. Both reject HTTP failures, invalid JSON and decisions belonging to another experiment. GraphQL errors reject even when HTTP succeeds. For a different GraphQL operation or result shape, pass a custom loader to React.

## React components and hooks

```tsx
import { XPProvider, Experiment, Cohort, useCohort } from "@frostme/xp/react";

function Checkout({ accountSession }: { accountSession: string }) {
  return (
    <XPProvider experimentHost="/api" sessionKey={accountSession}>
      <Experiment slug="checkout-banner" loading={<BannerSkeleton />}>
        <Cohort slug="on">
          <NewBanner />
        </Cohort>
        <Cohort default>
          <CurrentBanner />
        </Cohort>
      </Experiment>
      <Sidebar>
        <Cohort slug="delivery-copy_short">
          <ShortDeliveryCopy />
        </Cohort>
      </Sidebar>
    </XPProvider>
  );
}

function DeliveryCopy() {
  const result = useCohort("delivery-copy");
  if (result.status === "loading") return null;
  if (result.status === "error") {
    return <button onClick={() => void result.refresh()}>Retry delivery copy</button>;
  }
  return result.slug === "delivery-copy_short" ? <ShortDeliveryCopy /> : <StandardDeliveryCopy />;
}
```

`useCohort()` uses the nearest enclosing experiment. Local names and defaults belong inside that experiment. A standalone gate requires a qualified slug. All matching gates render, including multiple defaults. A resolved treatment with no matching gate renders none. Pending gates show the experiment's optional loading node. Errors reveal the default and expose the failure on the hook.

REST defaults to `/xp` and GraphQL defaults to `/graphql`. `experimentHost` adds a host or mount prefix. An explicit `endpoint` selects the complete URL. To use GraphQL, set `loader="graphql"`. For custom authentication or decoding, supply a stable loader function such as the configured `load` above.

A provider shares subscriptions, in-flight requests and decisions within the current session. Change `sessionKey` when an account logs in, logs out, or switches. A loader or endpoint change also starts a new cache. Await `refresh()` to request a fresh decision after a pause, resume, or failure. Open pages keep the last decision until refresh or a new session.

## Server rendering and hydration

Resolve decisions for the authenticated request, and pass the same snapshot to server render and hydration through your framework's request-local serialization.

```tsx
const initialAssignments = {
  "checkout-banner": (await xp.resolveCohort(userId, "checkout-banner")).slug,
};
const tree = (
  <XPProvider sessionKey={accountSession} initialAssignments={initialAssignments}>
    <App />
  </XPProvider>
);
```

Explicit null entries render the default immediately. Without a snapshot, server and initial browser renders use the pending state. The loader starts after mount. A session change discards the original preload.

## Request-local decisions and custom frontends

Create one request helper after authenticating each incoming request. Its loader closes over that request's verified identity. Repeated lookups share the decision, including failures. Pass the resulting plain data through the host framework's serializer.

```ts
import { createXpRequest } from "@frostme/xp/client";

const decisions = createXpRequest(async (slug) => (await xp.resolveCohort(userId, slug)).slug, {
  signal: request.signal,
});
const preload = await decisions.preload(["checkout-banner", "delivery-copy"]);
response.headers.set("Cache-Control", "private, no-store");
```

Spread `preload` on the React provider. A qualified slug renders its matching gate, explicit null renders the default with ready status, and an entry in `initialErrors` renders the default with a generic “Failed to resolve cohort” error. These three cases make zero browser requests until refresh. An absent experiment starts pending and loads on subscription. Log the original failure on the server. Keep prerendered pages neutral until a visitor-specific request or browser mount.

A custom browser frontend can subscribe after mount. Reading a snapshot is synchronous. Subscribers to one experiment share its request and retain the settled result for that session.

```ts
import { createXpSession } from "@frostme/xp/client";

const session = createXpSession({ ...preload, endpoint: "/api/xp" });
const update = () => renderBanner(session.getSnapshot("checkout-banner"));
const unsubscribe = session.subscribe("checkout-banner", update);
update();
await session.refresh("checkout-banner"); // for example, from a retry button
unsubscribe();
session.dispose(); // on teardown or before installing a new account's session
```

Use a fresh session when the account, endpoint or loader changes. React handles replacement when the opaque public `sessionKey` or transport configuration changes. Keep credentials, loaders, raw exceptions and database connections on the server.

## Generate the React DOM provider

Run `xp setup --scope frontend --frontend react --dry-run` in the application to review the provider, example and proposed mount edit. Re-run with `--yes` to apply it. Import `CheckoutBanner` from `./xp/CheckoutBanner` in your application and seed the `checkout-banner_on` decision. The generated provider defaults to same-origin REST at `/xp`.

For personalized SSR, keep request identity on the server, preload the route’s slugs with `createXpRequest`, and pass its public fields and the app’s session revision as props to the generated `AppXp`. Use the same root and public props with `hydrateRoot`. Rotate `sessionKey` when switching accounts. A custom endpoint, transport, or app layout can be reviewed in [frontend setup](cli.md#frontend-and-combined-setup).
