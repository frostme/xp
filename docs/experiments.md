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

## Svelte 5 and SvelteKit 3

Install Svelte 5.59.0 or later in major 5 alongside xp. The native Svelte entry exports three components and a readable store. This component receives public request data and a session revision from its host.

```svelte
<script lang="ts">
  import { XPProvider, Experiment, Cohort } from "@frostme/xp/svelte";
  import type { XpPreload } from "@frostme/xp/client";
  let { preload, revision }: { preload: XpPreload; revision: string } = $props();
</script>

<XPProvider {...preload} sessionKey={revision}>
  <Experiment slug="checkout-banner">
    {#snippet loading()}<p>Loading offer…</p>{/snippet}
    <Cohort slug="on"><p>New checkout offer</p></Cohort>
    <Cohort default><p>Standard checkout</p></Cohort>
  </Experiment>
  <Cohort slug="delivery-copy_short"><p>Short delivery copy</p></Cohort>
</XPProvider>
```

A child component can call `const decision = cohortStore(() => experiment)` during initialization and render `$decision.status`, `$decision.slug` or `$decision.error`. A button can call `$decision.refresh()`. Inside an experiment, `cohortStore()` reads the nearest experiment. Matching snippets instantiate lazily. An explicit null and a failed preload both render the default, with ready and error status respectively. Subscriptions start after mounting and share requests for the same slug.

The generated SvelteKit 3.4+ layout server load calls `loadXp(event)`. The app’s authenticated server hook can supply `event.locals.xp = { load, slugs, sessionKey }`. Define the optional `App.Locals.xp` field using the generated `XpRequestLocals` type in TypeScript projects. Bind `load` to the verified identity for this request, choose the route's explicit experiment list, and set `Cache-Control: private, no-store` on personalized responses. The layout sends its serializable `data.xp` to the generated provider. Without the host binding, it renders pending until the browser subscribes. Invalidate the relevant layout load and rotate the public revision when the account changes. Keep credentials in the server hook.

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

## Vue 3 and Nuxt 4

Install Vue 3.5.46 or later in the 3.x series. Wrap the root in `XPProvider` from `@frostme/xp/vue` or use the wrapper generated by `xp setup --scope frontend --frontend vue`. These components and the `useCohort` composable work in SFC templates and SSR render functions.

```vue
<script setup lang="ts">
import { Experiment, Cohort } from "@frostme/xp/vue";
</script>
<template>
  <Experiment slug="checkout-banner">
    <template #loading>Loading checkout…</template>
    <Cohort slug="on"><ExpressCheckout /></Cohort>
    <Cohort default><StandardCheckout /></Cohort>
  </Experiment>
  <Cohort slug="checkout-banner_on">Express checkout available</Cohort>
</template>
```

`useCohort()` reads the enclosing experiment. `useCohort(() => props.experiment)` watches a reactive slug. Read `decision.value.status`, `slug` and `error` in setup code, or unwrap the ref directly in the template. Call `decision.value.refresh()` to retry. Only selected slots construct their children. Each nested provider owns a separate session. Rotate `sessionKey` when an account changes.

For a Vue SSR app, create one app per request and pass `app.provide(xpBootstrap, shallowRef({ sessionKey, ...preload }))` to the server factory and matching client bootstrap. Import `xpBootstrap` from the generated `src/xp/options` module. Serialize only the request's public preload and session revision with the host's serializer. Keep authenticated decisions private with `Cache-Control: private, no-store`. A host with custom authentication can supply a stable `loader` through the injected ref.

For Nuxt 4.6.4 and later 4.x, select `--frontend nuxt`. The generated wrapper reads `useState("xp:bootstrap")`. In an app plugin, load the host-owned bootstrap endpoint using Nuxt's request-aware fetch and keyed payload transfer.

```ts
import type { XpBootstrap } from "../xp/options";

export default defineNuxtPlugin(async () => {
  const requestFetch = useRequestFetch();
  const { data } = await useAsyncData("session-bootstrap", () =>
    requestFetch<XpBootstrap>("/api/bootstrap"),
  );
  useState<XpBootstrap>("xp:bootstrap", () => ({})).value = data.value ?? {};
});
```

The endpoint authenticates the incoming request, calls `createXpRequest` and returns `{ sessionKey, ...await decisions.preload([...]) }`. Update the same state with the new revision on account switch. The root wrapper stays mounted during page navigation. Both integrations can start from a pending SSR shell before an auth bootstrap exists.

## Angular standalone components

Use the standalone structural directives to render branches and `inject(XpDecisions).cohort(slug)` for a refreshable signal. The generated provider can carry public request preloads through Angular hydration. [Angular setup, signals and SSR](angular.md)

## Solid components and SSR

Use `@frostme/xp/solid` with Solid 2.0.3 or later in major 2 and its matching `@solidjs/web` renderer. Solid 1.9 apps from 1.9.20 onward, including SolidStart 2.2, use `@frostme/xp/solid/v1`. Configure Vite with the corresponding `@solidjs/vite-plugin` or `vite-plugin-solid`. Each import has a browser build and a server build compiled for that major.

```tsx
import type { XpPreload } from "@frostme/xp/client";

import { XPProvider, Experiment, Cohort, createCohort } from "@frostme/xp/solid";

function Retry() {
  const decision = createCohort();
  return (
    <button disabled={decision().status !== "error"} onClick={() => void decision().refresh()}>
      Retry decision
    </button>
  );
}

export function Checkout(props: { revision: string; preload: XpPreload }) {
  return (
    <XPProvider sessionKey={props.revision} {...props.preload} endpoint="/api/xp">
      <Experiment slug="checkout-banner" loading={<p>Loading offer…</p>}>
        <Cohort slug="on">New offer</Cohort>
        <Cohort default>
          Standard checkout <Retry />
        </Cohort>
      </Experiment>
      <Cohort slug="delivery-copy_short">Short delivery copy</Cohort>
    </XPProvider>
  );
}
```

Call `createCohort()` inside a component under an experiment, or pass an experiment slug. For a changing prop, pass a getter such as `createCohort(() => props.slug)`. Read the returned accessor in JSX so it tracks the current snapshot. A nested provider starts its own scope. Pending renders the experiment's loading content. A null assignment or failed decision renders the default. A retry exposes loading before the next decision.

Instantiate `createXpRequest` inside the authenticated server request, resolve the route's slugs, and pass the returned public preload and revision to the same provider tree on the server and browser. Return personalized responses with `Cache-Control: private, no-store`. Use Solid's hydration script with a manual `renderToString` host. In SolidStart, a host-owned server query can return the public envelope through the router's native serialization. Mount the provider after `createAsync` resolves under the route's suspense boundary. Revalidate the query after an account change and return the new public revision. See the [Solid setup recipe](cli.md#solid-and-solidstart).

## Astro on-demand pages

In Astro 7.4.13 and later 7.x releases, an on-demand page renders a decision into HTML. Register the generated middleware after authentication. The host supplies a loader bound to the current request. For a co-located runtime, set `context.locals.xpHost` in your authentication middleware before calling `next()`.

```ts
context.locals.xpHost = {
  load: async (slug) => (await runtime.resolveCohort(authenticatedUser?.id, slug)).slug,
  sessionKey: publicAccountRevision,
};
```

For a separate service, call the generated `createHostLoader({ endpoint, headers })` with a trusted absolute endpoint and the credentials your server obtained for this request. Keep the loader and credentials inside middleware. Each request gets its own `Astro.locals.xp`. The generated middleware sets `Cache-Control: private, no-store` when the host provides a request loader.

```astro
---
import { Experiment, Cohort } from "@frostme/xp/astro";
export const prerender = false;
const result = await Astro.locals.xp.resolve("checkout-banner");
---
<Experiment slug="checkout-banner">
  <Fragment slot="cohort-on">Early checkout</Fragment>
  <p>Current checkout</p>
</Experiment>
<aside><Cohort slug="checkout-banner_on">Early access</Cohort></aside>
<Cohort experiment="checkout-banner" default>Current offer</Cohort>
```

Every lookup for one experiment shares its request promise, including `await Astro.locals.xp.preload(["checkout-banner"])`. Each experiment evaluates only the selected slot. An unlisted treatment renders empty. A guest null and a failure render the default. Use `result.status` to distinguish them. Plain pages work with JavaScript disabled. Prerendered pages and an unconfigured host render the deliberate public default without visitor lookups at build time. To supply `locals` from your own middleware, extend `App.Locals` with `XpLocals` from `@frostme/xp/astro` and set `locals.xp = createXpRequest(load, { signal: request.signal })` per request.
