# Serving experiments to frontends

Install `@frostme/xp` and the frontend runtime for your application. On the server, install your database driver and host framework.

## Choose a frontend

Run `xp setup --scope frontend --frontend <profile> --dry-run` in the application package to see its proposed files and entry-point edit. Use the profile that owns the app bootstrap. [Setup and manual registration](cli.md)

| Setup profile         | Package entry                                                     | Consumer example                                                               |
| --------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `react`               | `@frostme/xp/react`                                               | [React components and hooks](#react-components-and-hooks)                      |
| `vue`, `nuxt`         | `@frostme/xp/vue`                                                 | [Vue and Nuxt](#vue-3-and-nuxt-4)                                              |
| `angular`             | `@frostme/xp/angular`                                             | [Angular signals and structural directives](#angular-standalone-components)    |
| `svelte`, `sveltekit` | `@frostme/xp/svelte`                                              | [Svelte stores and snippets](#svelte-5-and-sveltekit-3)                        |
| `solid`, `solidstart` | `@frostme/xp/solid` for Solid 2 or `@frostme/xp/solid/v1` for 1.9 | [Solid components and SSR](#solid-components-and-ssr)                          |
| `astro`               | `@frostme/xp/astro`                                               | [Request-local Astro pages](#astro-on-demand-pages)                            |
| Custom                | `@frostme/xp/client`                                              | [Sessions and request preloads](#request-local-decisions-and-custom-frontends) |

## Choose a server host

The installed consumers exercise the following versions.

| Mount       | Packages exercised                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------- |
| REST        | Express 5.3.0 or Fastify 5.12.8                                                                                      |
| NestJS      | `@nestjs/common`, `core` and the Express or Fastify platform adapter 12.6.0, `reflect-metadata` 0.2.2 and RxJS 7.8.2 |
| GraphQL     | GraphQL 16.15.0 with Yoga 6.1.0 or Apollo Server 5.5.2                                                               |
| Native gRPC | `@grpc/grpc-js` 1.14.7 and `@grpc/proto-loader` 0.8.1                                                                |
| gRPC-Web    | Envoy 1.37.4 to native gRPC, or `@connectrpc/connect-node` 2.3.0 in the HTTP host                                    |
| SOAP        | `soap` 1.14.1                                                                                                        |

For example, a SOAP host using PostgreSQL can run `npm install @frostme/xp pg soap@1.14.1`. For a Fastify host use `npm install @frostme/xp pg fastify@5`. A Nest app needs `@nestjs/common`, `@nestjs/core`, `reflect-metadata`, `rxjs` and its chosen `@nestjs/platform-*` package. Browser applications can import either browser loader from xp and add React for the provider shortcuts. Each application authenticates its requests and owns its database connection.

## Initialize before accepting requests

Generate storage with `xp setup`, review its files, and apply the migration through your normal deployment process. For an existing installation, run setup in the directory containing its v1 or v2 `.xp/setup.json` and apply the v3 upgrade before deploying the new server. The CLI guide covers ORM-specific setup and generated files. [CLI guide](cli.md)

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

`cwd` defaults to the working directory. `configPath` selects an explicit path relative to it. A missing conventional file produces empty `created` and `skipped` lists. An explicit missing file, invalid declaration or failed write rejects startup. The file accepts unique kebab-case experiment slugs. A legacy declaration requires at least two distinct local cohort names. DynamoDB allows up to 32 initial cohorts. xp validates all declarations before writing, then commits each new experiment and its cohorts together. The first cohort is the control. The exact on/off pair forms a flag. Other pairs are simple experiments, and larger groups are multivariate. Legacy definitions store percentages totaling 100 and choose new cohorts uniformly.

Initialization skips every existing experiment, including cohorts added to its JSON declaration. Removing a declaration leaves its data in storage. A retry after a partial boot can create the remaining experiments. Use the server management API to edit live definitions. Both availability operations are idempotent.

```ts
await xp.pauseExperiment("checkout-banner");
await xp.resumeExperiment("checkout-banner");
const decision = await xp.resolveCohort(userId, "checkout-banner");
```

A missing identity or missing application user resolves to `{ slug: null }`. Create the application user through your normal account lifecycle. A paused experiment also resolves to null. Resuming restores winner-first resolution, followed by a sticky assignment or new bucketing. An assigned flag-off slug maps to null for the public decision. The existing `getGroup` method returns the stored off slug. A missing experiment for a known user is an error.

## Managed definitions

Add `rollout: "off-first"` to a declaration to seed a managed experiment. The off control may appear anywhere in the declaration. xp moves it first, or supplies it if omitted. Include at least one distinct treatment. The 32-cohort DynamoDB limit includes off. A managed definition, its off winner, initial revision and all cohorts become visible together.

```json
{
  "management": { "allowCreate": false },
  "experiments": [
    { "slug": "checkout-copy", "cohorts": ["short", "detailed"], "rollout": "off-first" }
  ]
}
```

This definition starts enabled and awaiting launch at 100% off. The two treatments start at 0%. The host's create switch defaults to false and is read at initialization. Config seeds can still create missing experiments. When creation is enabled, a trusted host can call `runtime.management.create({ slug, cohorts })` to persist the same off-first definition. A duplicate slug returns a conflict. An empty installation can declare `"experiments": []`. Adding an existing slug to config, removing its declaration, and restarting all preserve the saved database definition.

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

## Fastify

Register the plugin in the scope where the host authenticates requests. With a prefix of `/api`, the default route is `POST /api/xp`. A hook can admit guests, attach an account ID (including numeric zero) or send a denial before the decision runs.

```ts
import { xpFastifyPlugin } from "@frostme/xp/server/fastify";
import Fastify from "fastify";

const app = Fastify();
app.addHook("preHandler", async (request, reply) => {
  const cookie = request.headers.cookie;
  const account = await authenticateSession(cookie);
  if (cookie && !account) return reply.code(401).send({ error: "Invalid session" });
  Object.assign(request, { userId: account?.id });
});
app.register(xpFastifyPlugin, { runtime: xp, prefix: "/api" });
await app.listen({ port: 3000 });
```

Both Fastify and Nest support `route`, `userId`, `header` and `resolveBody`. The identity callback has first priority, followed by the configured trusted header, then the request's `userId`. An empty selected source yields a guest. Have the authenticating host strip or replace any incoming copy of a trusted header. Use the REST loader's `decode` with a custom response body. [Packed Fastify consumer](../scripts/fixtures/host-package-smoke/fastify.ts)

## NestJS on Express or Fastify

Import the dynamic module into the application. A global prefix applies on either platform. The following example uses the runtime initialized above. With Express, pass `new ExpressAdapter()` from `@nestjs/platform-express` in place of the Fastify adapter.

```ts
import "reflect-metadata";
import { XpModule } from "@frostme/xp/server/nestjs";
import { Module, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";

@Module({ imports: [XpModule.register({ runtime: xp, route: "/xp" })] })
class ShopModule {}

const app = await NestFactory.create(ShopModule, new FastifyAdapter());
app.setGlobalPrefix("api");
app.useGlobalGuards({
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const account = await authenticateSession(request.headers.cookie);
    if (request.headers.cookie && !account) throw new UnauthorizedException();
    request.userId = account?.id;
    return true;
  },
});
await app.listen(3000);
```

For dependency injection, export the runtime's provider from a host module. Set the route when declaring the module and resolve request options in the factory. The packed consumer demonstrates both registrations, a sibling controller and 401/403 responses on each platform. [Nest consumer](../scripts/fixtures/host-package-smoke/nestjs.ts)

```ts
import type { CohortRuntime } from "@frostme/xp/server";

import { XpModule } from "@frostme/xp/server/nestjs";
import { Module } from "@nestjs/common";

const xpRuntime = Symbol("shop.xp");
@Module({ providers: [{ provide: xpRuntime, useValue: xp }], exports: [xpRuntime] })
class StorageModule {}

@Module({
  imports: [
    XpModule.registerAsync({
      route: "/decision",
      imports: [StorageModule],
      inject: [xpRuntime],
      useFactory: async (runtime: CohortRuntime) => ({
        runtime,
        userId: (request) => request.userId,
      }),
    }),
  ],
})
class ShopModule {}
```

## Native gRPC and the Envoy bridge

Register the unary method on an existing grpc-js server. The versioned proto lives at `@frostme/xp/proto/xp/v1/cohort.proto`. A host interceptor can verify credentials and supply an identity in metadata. In this example `verifyBearer` is the application's verifier for a supplied token. It returns the verified account or null for an invalid token. Missing credentials are allowed as a guest.

```ts
import { registerXpGrpc } from "@frostme/xp/server/grpc";
import * as grpc from "@grpc/grpc-js";

const authenticate: grpc.ServerInterceptor = (_method, call) =>
  new grpc.ServerInterceptingCall(call, {
    start(next) {
      next({
        onReceiveMetadata(metadata, accept) {
          const token = metadata.get("authorization")[0];
          metadata.remove("x-verified-user");
          if (token !== undefined) {
            const account = verifyBearer(token);
            if (!account) {
              call.sendStatus({ code: grpc.status.UNAUTHENTICATED, details: "Invalid session" });
              return;
            }
            metadata.set("x-verified-user", String(account.id));
          }
          accept(metadata);
        },
      });
    },
  });

const rpc = new grpc.Server({ interceptors: [authenticate] });
registerXpGrpc(rpc, { runtime: xp, header: "x-verified-user" });
rpc.bindAsync("127.0.0.1:18183", grpc.ServerCredentials.createInsecure(), (error) => {
  if (error) throw error;
});
```

Use the published schema when constructing a native client. Keep proto-loader's default field-presence behavior. An absent response `slug` means null. A present value must be a qualified cohort slug for the requested experiment. The packed example loads the method definition from the installed file and sends a real unary call with metadata. [Native client and server](../scripts/fixtures/host-package-smoke/grpc.ts)

To expose this loopback server to a browser, run the fixture's pinned Envoy on a Linux Docker host.

```sh
docker compose -f scripts/fixtures/protocol-browser/compose.yml up -d
# After the session
docker compose -f scripts/fixtures/protocol-browser/compose.yml down
```

The fixture listens on `127.0.0.1:18182`, accepts a page from `http://127.0.0.1:18180` and routes `/api/xp.v1.CohortService/ResolveCohort` to the canonical native method on port 18183. Envoy removes the mount prefix, translates binary gRPC-Web to gRPC over HTTP/2 and forwards authentication material and status. Keep caches disabled on this route. Set the allowed origin, upstream and TLS for your deployment. [Envoy route and CORS configuration](../scripts/fixtures/protocol-browser/envoy.yaml)

## Direct Node gRPC-Web

The Node handler serves the same browser method on a caller-owned HTTP server. A Connect interceptor can authorize the call and replace a client-supplied identity header. `requestPathPrefix` preserves the mount path. The host handles other routes through `fallback`.

```ts
import { Code, ConnectError, type Interceptor } from "@connectrpc/connect";
import { createXpGrpcWebHandler } from "@frostme/xp/server/grpc-web";
import { createServer } from "node:http";

const authenticate: Interceptor = (next) => async (request) => {
  const token = request.header.get("authorization");
  request.header.delete("x-verified-user");
  if (token !== null) {
    const account = verifyBearer(token);
    if (!account) throw new ConnectError("Invalid session", Code.Unauthenticated);
    request.header.set("x-verified-user", String(account.id));
  }
  return next(request);
};
const grpcWeb = createXpGrpcWebHandler({
  runtime: xp,
  requestPathPrefix: "/api",
  interceptors: [authenticate],
  header: "x-verified-user",
  fallback: (_request, response) => response.writeHead(404).end(),
});
createServer(grpcWeb).listen(3000);
```

For hosts that already attach an identity to the Node request, `userId(request)` receives that original request. An interceptor can return `Code.PermissionDenied` for an authenticated account without access.

## SOAP 1.1

Construct the handler once. `path` selects the path received by Node. `publicEndpoint` is the external URL advertised in the WSDL, including any proxy prefix. Authenticate in front of the XML dispatch on the listener that actually receives the POST. Here the host exposes its health route and accepts anonymous reads of the WSDL.

```ts
import { createXpSoapHandler } from "@frostme/xp/server/soap";
import { createServer } from "node:http";

const path = "/api/xp/soap";
const handleSoap = await createXpSoapHandler({
  runtime: xp,
  path,
  publicEndpoint: "http://localhost:3000/api/xp/soap",
});
createServer(async (request, response) => {
  if (request.url === "/health") {
    response.writeHead(200).end("ok");
    return;
  }
  if (request.method === "POST" && new URL(request.url!, "http://localhost").pathname === path) {
    const cookie = request.headers.cookie;
    const account = await authenticateSession(cookie);
    if (cookie && !account) {
      response.writeHead(401, { "Cache-Control": "private, no-store" }).end();
      return;
    }
    Object.assign(request, { userId: account?.id });
  }
  if (!(await handleSoap(request, response))) response.writeHead(404).end();
}).listen(3000);
```

The default path is `/xp/soap`. GET the mounted path with `?wsdl` or resolve the static asset `@frostme/xp/wsdl/xp/v1/cohort.wsdl`. The binding uses SOAP 1.1 document/literal messages with action `urn:frostme:xp:v1:ResolveCohort`. XML requests have a 16 KiB streaming limit. Oversized requests return HTTP 413. DTDs are rejected.

A WSDL-driven client discovers the operation and endpoint. Set `handleNilAsNull` to decode the response's required, nillable `slug`.

```ts
import { createClientAsync } from "soap";

const client = await createClientAsync("http://localhost:3000/api/xp/soap?wsdl", {
  handleNilAsNull: true,
});
const [decision] = await client.ResolveCohortAsync({ slug: "delivery-copy" });
console.log(decision.slug);
```

## Browser protocol loaders

A relative `experimentHost` selects a same-origin mount. An absolute base selects another origin. A complete `endpoint` takes precedence. For gRPC-Web the endpoint must end in `/xp.v1.CohortService/ResolveCohort`. For SOAP, the default suffix is `/xp/soap`. Changing the gRPC-Web base switches between direct Node and Envoy.

```ts
import { createGrpcWebLoader } from "@frostme/xp/client/grpc-web";
import { createSoapLoader } from "@frostme/xp/client/soap";

const direct = createGrpcWebLoader({ experimentHost: "/api" });
const proxy = createGrpcWebLoader({
  experimentHost: "http://127.0.0.1:18182/api",
  credentials: "include",
});
const soap = createSoapLoader({ endpoint: "/api/xp/soap" });

export function loadDecisions(signal: AbortSignal) {
  return Promise.all([direct, proxy, soap].map((load) => load("delivery-copy", { signal })));
}
```

Each loader accepts `fetch`, `headers` and `credentials`. Credentials default to `same-origin`. For credentialed cross-origin use, the host must answer OPTIONS for the explicit allowed origin before authenticating the POST, allow credentials and the request headers in use (including `authorization`, `content-type`, gRPC-Web headers and SOAP's `SOAPAction`). Expose `grpc-status` and `grpc-message` to JavaScript, including on trailers-only denials. For cookies, configure the cookie's domain, SameSite and Secure attributes for the deployment.

| Decision                               | REST                | gRPC or gRPC-Web                     | SOAP 1.1                                       |
| -------------------------------------- | ------------------- | ------------------------------------ | ---------------------------------------------- |
| Assigned or winner                     | 200, qualified slug | OK, slug present                     | 200, qualified slug element                    |
| Guest, absent user, paused or flag off | 200, null           | OK, slug absent                      | 200, slug with `xsi:nil="true"`                |
| Malformed slug                         | 400                 | INVALID_ARGUMENT                     | 500, Client fault with INVALID_ARGUMENT detail |
| Known user's missing experiment        | 404                 | NOT_FOUND                            | 500, Client fault with NOT_FOUND detail        |
| Unexpected failure                     | 500                 | INTERNAL                             | 500, Server fault with INTERNAL detail         |
| Host rejects or denies access          | 401 or 403          | UNAUTHENTICATED or PERMISSION_DENIED | Host HTTP 401 or 403 before XML dispatch       |

The browser loaders return a qualified slug or null, and reject transport errors and malformed responses. gRPC-Web checks final RPC status even on HTTP 200. The SOAP loader exposes an application's `XpFault` detail through `XpSoapFault.code`. A plain HTTP denial rejects the load.

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

REST defaults to `/xp` and GraphQL defaults to `/graphql`. `experimentHost` adds a host or mount prefix. An explicit `endpoint` selects the complete URL. To use GraphQL, set `loader="graphql"`. Set `loader="grpc-web"` or `loader="soap"` to load the associated browser implementation on demand. For custom authentication or decoding, supply a stable loader function such as a configured factory above.

```tsx
import type { ReactNode } from "react";

import { XPProvider } from "@frostme/xp/react";

type Props = { sessionKey: string; children: ReactNode };
export function RpcExperiments({ sessionKey, children }: Props) {
  return (
    <XPProvider loader="grpc-web" experimentHost="/api" sessionKey={sessionKey}>
      {children}
    </XPProvider>
  );
}
export function SoapExperiments({ sessionKey, children }: Props) {
  return (
    <XPProvider loader="soap" endpoint="/api/xp/soap" sessionKey={sessionKey}>
      {children}
    </XPProvider>
  );
}
```

An admitted guest reaches `useCohort().status === "ready"` with a null slug. A rejected session reaches `"error"` and exposes the error and `refresh()` for retry. Both can render the default cohort. Route the retry through the host's authentication flow when a session needs renewal.

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

### Astro islands

Use an installed official Astro integration and a directly imported framework component to hydrate a decision. The CLI generates a native `XpIsland` for the selected renderer and a small `CheckoutIsland.astro` example. This page renders a React island with its own request-scoped snapshot.

```astro
---
import XpIsland from "../xp/XpIsland.tsx";
const experiments = ["checkout-banner"];
const preload = Astro.isPrerendered || !Astro.locals.xpHost
  ? { initialAssignments: {}, initialErrors: [] }
  : await Astro.locals.xp.preload(experiments);
const sessionKey = Astro.locals.xpHost?.sessionKey ?? 0;
---
<XpIsland client:load {experiments} {preload} {sessionKey} />
```

Pass each island its own experiment allowlist. Request memoization shares server work where the lists overlap. Native Astro serialization carries explicit null results and sanitized failures to each island. A preloaded decision stays visible without a browser lookup until refresh. An omitted decision renders pending, then loads after hydration. A static page can pass the empty preload shown above to defer all visitor decisions to the browser.

Each island owns a separate provider. Refresh updates only that island. After login, logout or account switching, navigate or reload the personalized route so every island receives the new snapshot and opaque public revision. Hosts handling auth without navigation must broadcast the new revision to all mounted framework roots and pass it to each provider’s reactive `sessionKey` prop. Keep credentials in the host’s HTTP-only session.
