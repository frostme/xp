# Ship NestJS, Fastify, gRPC and SOAP support for xp

## Assignment for the cloud agent

Work in `frostme/xp`. Implement this plan from current `main` and open the seven pull requests below. The deliverable is an installed `@frostme/xp` package that an existing application can mount, with the same cohort decision available through each supported integration. Prove that a real browser can reach the gRPC service through either supported deployment and can call SOAP directly. Finish with a bottom-to-top review index, links to passing checks for each head, and the reproduction commands. Elliot owns merging and release.

The planning baseline is `de50197856c971b3726fb4369a27ddb20fd21966` (PR #19). Read `AGENTS.md`, `docs/experiments.md`, `docs/roadmap.md`, and the files below in the checkout you receive. Reconcile intervening changes before editing. This attachment contains the full assignment.

### Decisions from the maintainer

- Expose one operation, `ResolveCohort`, in caller-owned applications. Keep experiment management, queue workers, storage changes, setup scaffolding, and additional UI frameworks outside this phase.
- Ship NestJS on its Express and Fastify platforms, plus a standalone Fastify plugin. All three mounts use the existing REST request and response.
- Ship native unary gRPC and two interchangeable ways for browsers to call it with gRPC-Web. One uses an Envoy bridge to a native gRPC service. One serves gRPC-Web in Node without a proxy.
- Ship SOAP 1.1 over HTTP with WSDL 1.1 and host authentication. Ship a directly callable browser SOAP loader. Use real protocol clients and the published schemas in examples and tests.
- Ship both framework-independent browser factories and the React options `loader="grpc-web"` and `loader="soap"`.
- Let the host authenticate each call. Anonymous access allowed by the host yields a successful null decision. A host rejection stays an error at the client.
- Deliver independently green stacked PRs, including tests against the packed npm artifact.

## Reuse the shipped contract

| Code to read                                                                                                                             | What it owns                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/interfaces/runtime.ts`, `src/server/index.ts`, `src/use-cases/user/getGroup.ts`                                                     | `initializeXp`, `CohortRuntime`, identity normalization, winner selection, sticky assignments, concurrent assignment handling, pause and flag-off behavior.            |
| `src/server/request.ts`, `src/server/runtimeSelector.ts`, `src/server/{express,graphql}/index.ts`                                        | Slug validation, async identity callbacks, configured header precedence, runtime selection and existing transport behavior. Use the request helpers where appropriate. |
| `src/client/loaders/shared.ts`, `src/client/index.ts`, `src/client/react/{components.tsx,assignments.ts}`                                | The `CohortLoader` signature, qualified slug validation, endpoint conventions, React session cache, refresh, abort, SSR preloads and error rendering.                  |
| `package.json`, `bun.lock`, `.swcrc`, `tsconfig.json`, `dpdm.config.ts`, `knip.ts`                                                       | Public exports, dependencies, JS and declaration outputs, Wireit cache inputs and import checks.                                                                       |
| `vitest.transport.config.ts`, `scripts/{host-package-smoke,test-installed-journey}.mjs`, `scripts/fixtures/`, `.github/workflows/ci.yml` | Existing host tests, isolated tarball consumers, PostgreSQL-backed React journey, and where CI discovers each.                                                         |

**Server lifecycle.** The host prepares storage and calls `await initializeXp({ connection, ... })` once during startup. Mount the returned runtime into the application or service instance. A request validates the experiment slug, reads that request's verified identity and calls `runtime.resolveCohort(identity, slug)`. The host owns listeners, connection shutdown, authentication, CORS and deployment. Imports and handler construction must be usable without opening sockets or writing to storage.

**Identity.** After host authentication, use the existing precedence of an explicit async-capable `userId(context)` resolver, a configured trusted header or gRPC metadata key, then an identity attached by host authentication. If the chosen source is empty, resolve as a guest. Preserve numeric ID zero. The operation body contains only the experiment slug. A host that uses forwarded identity must strip or replace client-supplied copies at its trusted boundary. A domain guest includes an authenticated identity absent from xp's user storage. Preserve host-generated denials from guards, hooks or interceptors. For the native SOAP mount, authenticate on the request path that actually receives the XML. Attaching to a raw Node server can bypass middleware installed on another router. [node-soap server registration](https://github.com/vpulim/node-soap/blob/v1.14.1/src/server.ts)

| Case                                          | REST on the three new HTTP mounts     | gRPC and gRPC-Web                                       | SOAP 1.1                                                 |
| --------------------------------------------- | ------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| Assigned cohort or winner                     | 200, `{"slug":"delivery-copy_short"}` | OK, response slug present                               | 200, response slug element with qualified text           |
| Guest, missing stored user, pause or flag-off | 200, `{"slug":null}`                  | OK, optional response field absent                      | 200, response slug element carries `xsi:nil="true"`      |
| Invalid experiment slug                       | 400                                   | `INVALID_ARGUMENT`                                      | HTTP 500, `soap:Client` fault, detail `INVALID_ARGUMENT` |
| Known user, unknown experiment                | 404                                   | `NOT_FOUND`                                             | HTTP 500, `soap:Client` fault, detail `NOT_FOUND`        |
| Unexpected resolver or runtime failure        | 500, sanitized body                   | `INTERNAL`, sanitized message                           | HTTP 500, `soap:Server` fault, detail `INTERNAL`         |
| Host rejects credentials or denies access     | Host 401 or 403                       | `UNAUTHENTICATED` or `PERMISSION_DENIED` via auth layer | Host HTTP 401 or 403 before dispatch                     |

Use the table as a shared test fixture. A valid slug with a guest identity and an unknown experiment returns null. Malformed slugs fail even for guests. Preserve host logging for unexpected errors and keep driver messages out of wire responses. Set `Cache-Control: private, no-store` for personalized HTTP decisions, including SOAP and browser RPC responses. Keep proxy caches disabled for the decision route.

## Host APIs and wire formats

The names below are implementation targets. Add each subpath with the PR that implements it. Compile the examples as installed consumers.

**Fastify.** Export `xpFastifyPlugin` from `@frostme/xp/server/fastify`. Support `app.register(xpFastifyPlugin, { runtime: xp, prefix: "/api" })`. Default to `POST /xp` inside that scope. Accept an optional `route`, `userId`, trusted `header`, and `resolveBody` (custom REST response mapper compatible with the existing loader's `decode`). Use the parent scope's authentication hooks. Test prefixed and sibling routes, two encapsulated registrations with different runtimes, and `app.inject` plus one real socket call. [Fastify plugin encapsulation](https://fastify.dev/docs/latest/Reference/Plugins/)

**NestJS.** Export `XpModule` from `@frostme/xp/server/nestjs`. Support `XpModule.register({runtime: xp, route: "/xp"})` and `XpModule.registerAsync({ route, imports, inject, useFactory })`. The route is known when Nest constructs the module. The async factory resolves the runtime, identity and response options through the host’s DI container. Use a module-local provider and controller. Support the same identity and response options and a configurable route under the host's global prefix. Set successful POST status to 200 explicitly. Preserve guards, exception handling and sibling controllers on both platforms. Check the compiled package's DI metadata or explicit injection tokens under the project's SWC and declaration pipelines. Test two independent Nest apps in the same process. [Nest dynamic modules](https://docs.nestjs.com/fundamentals/dynamic-modules) · [Nest HTTP platforms](https://docs.nestjs.com/techniques/performance)

**gRPC.** Ship this source schema as a stable package asset at `@frostme/xp/proto/xp/v1/cohort.proto`. Derive all generated descriptors and types from that file. Add a deterministic generation/check command with pinned tools and a drift test. Preserve field numbers and presence across future v1 revisions.

```proto
syntax = "proto3";
package xp.v1;

service CohortService {
  rpc ResolveCohort(ResolveCohortRequest) returns (ResolveCohortResponse);
}
message ResolveCohortRequest  { string slug = 1; }
message ResolveCohortResponse { optional string slug = 1; }
```

- Export `registerXpGrpc(grpcServer, { runtime: xp, userId })` from `@frostme/xp/server/grpc`. Mount on an existing `@grpc/grpc-js` server with other services. Use the grpc-js service definition loaded from the packed proto via proto-loader. Expose the schema to standard tools through package resolution. Test a native client that loads the installed proto independently of the xp handler. Decode with field presence preserved. A present empty response string is malformed. [gRPC Node](https://grpc.io/docs/languages/node/basics/) · [Protobuf field presence](https://protobuf.dev/programming-guides/field_presence/) · [gRPC status codes](https://grpc.io/docs/guides/status-codes/)
- **Envoy deployment.** Provide a runnable Envoy configuration and Compose fixture. Route the canonical method `/xp.v1.CohortService/ResolveCohort` through Envoy's gRPC-Web filter to the actual native handler over HTTP/2. For a browser base of `/api`, strip that prefix before forwarding the canonical method. Pin the image, forward the authentication material the host verifies, preserve status trailers, and exercise an allowed-origin preflight. [Envoy gRPC-Web filter](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/grpc_web_filter)
- **Direct Node deployment.** Export `createXpGrpcWebHandler({ runtime: xp, userId, ... })` from `@frostme/xp/server/grpc-web` for an existing Node HTTP listener. Use Connect's Node adapter with gRPC-Web enabled, a generated Protobuf-ES descriptor shared with the browser, and `requestPathPrefix` for mounted bases such as `/api`. The grpc-js definition and Protobuf-ES descriptor come from the same proto. Dispatch only the xp method and allow host fallback for other paths. Provide the actual request or authenticated context to the identity resolver. This deployment needs neither Envoy nor a separate native listener. Both registrations use the same domain decision and status mapping. One browser loader must work unchanged when its base moves between these deployments. [Connect Node server plugins](https://connectrpc.com/docs/node/server-plugins/) · [Connect gRPC-Web transport](https://connectrpc.com/docs/web/choosing-a-protocol/)

**SOAP.** Export an async factory from `@frostme/xp/server/soap`. Construct it with `const handleSoap = await createXpSoapHandler({ runtime: xp, publicEndpoint })`. Accept optional `path`, `userId` and trusted `header` options. The host mounts the returned handler on its SOAP route after the host’s HTTP authentication gate. The gate can return 401/403 before XML dispatch. Let the host handle OPTIONS and sibling routes. Demonstrate a denied SOAP request and a successful sibling request on the same listener.

Use `soap.createServerless` at startup and its public `processRequest` API inside this handler. Read XML with a documented byte limit enforced while streaming and return HTTP 413 for an oversized body. Carry the original authenticated request to the service method through request-local context, including on concurrent calls. Serve WSDL from the same mount. [node-soap HTTP-independent request processing](https://github.com/vpulim/node-soap/blob/v1.14.1/Readme.md#createserverless_options_)

Publish `@frostme/xp/wsdl/xp/v1/cohort.wsdl` as a self-contained WSDL 1.1 file with a SOAP 1.1 document/literal wrapped binding. Default to `/xp/soap`. A GET on the mounted path with the `?wsdl` query advertises the explicitly configured external address behind a proxy. Pin a versioned target namespace (`urn:frostme:xp:v1`), `ResolveCohort` and `ResolveCohortResponse` wrappers, qualified `slug` elements, required nillable response slug, and SOAPAction `urn:frostme:xp:v1:ResolveCohort`. Define a WSDL application fault with a qualified `XpFault` detail element and a required `code` child holding the application code. Return SOAP 1.1 fault elements including `faultcode`, `faultstring` and `detail`. Reject malformed envelopes and invalid requests before resolution. Keep XML parsing bounded and disable DTD/external-entity processing. Exercise a WSDL-driven client configured to materialize nil as null, a raw XML fixture with alternate namespace prefixes, and the browser loader. Preserve other request listeners and demonstrate that authenticated requests on the SOAP path reach host auth. [node-soap](https://github.com/vpulim/node-soap) · [SOAP 1.1 HTTP binding and faults](https://www.w3.org/TR/2000/NOTE-SOAP-20000508/) · [WSDL 1.1](https://www.w3.org/TR/2001/NOTE-wsdl-20010315)

## Browser and React API

```tsx
import type { ReactNode } from "react";

import { createGrpcWebLoader } from "@frostme/xp/client/grpc-web";
import { createSoapLoader } from "@frostme/xp/client/soap";
import { XPProvider } from "@frostme/xp/react";

const grpcLoad = createGrpcWebLoader({ experimentHost: "/api" });
const soapLoad = createSoapLoader({ endpoint: "/api/xp/soap" });
export async function decisions(signal: AbortSignal) {
  return Promise.all([
    grpcLoad("delivery-copy", { signal }),
    soapLoad("delivery-copy", { signal }),
  ]);
}

type Props = { children: ReactNode; sessionKey: string };
export function RpcExperiments({ children, sessionKey }: Props) {
  return (
    <XPProvider loader="grpc-web" experimentHost="/api" sessionKey={sessionKey}>
      {children}
    </XPProvider>
  );
}
export function SoapExperiments({ children, sessionKey }: Props) {
  return (
    <XPProvider loader="soap" endpoint="/api/xp/soap" sessionKey={sessionKey}>
      {children}
    </XPProvider>
  );
}
```

- Implement the existing `CohortLoader` signature. Support injected `fetch`, headers, credentials and caller `AbortSignal`. Default to same-origin. `experimentHost` is an origin or mount prefix. Append the canonical gRPC method or `/xp/soap` once. An explicit `endpoint` is the complete URL and takes precedence. For gRPC-Web, document the canonical service/method suffix and validate it when deriving the transport base URL. Preserve host path prefixes. Provide runnable relative and absolute URL examples.
- Use a browser gRPC-Web binary transport (e.g. `createGrpcWebTransport`) and the generated descriptor. Honor final RPC status even on HTTP 200. For SOAP use browser `fetch`, POST `text/xml` with the agreed SOAPAction, and a namespace-aware XML parser. Recognize the declared nil element, verify the expected response wrapper and slug, decode fault details on a non-2xx response, and surface empty bodies, unexpected shapes or plain HTTP denials as errors. Reuse `decodeAssignment` to reject a qualified slug from the wrong experiment in both loaders.
- Add the two literal options to `XPProviderProps.loader`. Use the existing function-loader path, cache and session lifecycle. Load protocol-specific browser code on demand. Resolve browser runtime dependencies for the installed shortcuts without requiring the consumer to install any server peer. Check that a REST-only browser's initial bundle excludes the RPC/XML implementation and that all browser chunks exclude Node built-ins, DB drivers, CLI code, `soap`, and Node gRPC servers. Build a production fixture with code splitting. Traverse static imports from the entry for the initial-bundle assertion and inspect every emitted chunk for server dependencies. Preserve the public `./client` and `./react` paths.
- Exercise guest defaults, treatment, error plus retry, abort, deduplication and account switches. Reuse React's existing preload behavior, including explicit null, and ensure SSR does not invoke DOM APIs, initialize transports, or fetch at import/render time. Preserve host rejection as an error on `useCohort` even when the default gate is visible.

## Review stack and ownership

Branch PR 1 from current `main`. Target each later PR at its immediate predecessor. Use the `frostme/` branch prefix. A lead owns integration and shared files (`package.json`, `bun.lock`, CI, build inputs/outputs, exports and compiler configuration). Separate worktrees let the HTTP hosts, gRPC schema and SOAP binding progress independently. Browser work depends on the relevant reviewed wire contract. Integrate those branches in this review order. Each row ships executable tests and installed-package coverage for its feature on that PR's CI run.

| PR and suggested branch suffix | Owner and change                                                                                                                             | Passing evidence on that head                                                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 · `fastify-decisions`        | HTTP adapter owner. Add `src/server/fastify/`, shared decision test vectors, export, optional Fastify peer and isolated consumer.            | Existing REST loader calls real Fastify. Verify default and custom route/body, auth hooks, scope isolation, errors and the shared decision table.                                                                 |
| 2 · `nestjs-decisions`         | Nest owner. Add `src/server/nestjs/`, sync and DI-based async registration, peer declarations and fixtures for both platforms.               | Installed consumer boots on each platform, validates an auth guard denial, parent prefix, status 200, request identity and concurrent app isolation.                                                              |
| 3 · `grpc-cohort-service`      | RPC owner. Add the versioned proto, descriptor generation, asset packaging, `src/server/grpc/`, status mapping and native client example.    | Resolve through a real native socket using the packed schema. Cover absent vs empty response slug, auth metadata, statuses, sibling service and schema regeneration.                                              |
| 4 · `grpc-web-decisions`       | RPC/browser owner. Add the direct Node handler, browser gRPC-Web entry, Envoy config, and browser CI fixtures.                               | The same packed loader calls both deployments in Chromium. Prove proxy translation against a native-only upstream, direct Node with no proxy process, final status on HTTP 200, credentialed preflight and abort. |
| 5 · `soap-cohort-service`      | SOAP owner. Add WSDL packaging, `src/server/soap/`, browser SOAP entry, faults, and client examples.                                         | Pack, install, retrieve WSDL, and resolve through a WSDL-driven client and Chromium. Inspect nil and typed SOAP faults on the wire, exercise host HTTP denial and a prefixed public address.                      |
| 6 · `react-protocol-loaders`   | React owner. Extend `src/client/react/` with both shortcuts and lazy loading. Extend strict consumer declarations and browser bundle checks. | In a packed React app exercise each literal and a custom factory, default versus error, retry, SSR/preload, and a late response after session change. Verify REST and GraphQL regressions and bundle boundaries.  |
| 7 · `protocol-journeys`        | Integration lead. Extend the installed PostgreSQL journey, CI, `docs/experiments.md`, `README.md` entry links, and `docs/roadmap.md`.        | Run the integrated journey below and provide working install, mount, auth, proxy, direct-host, browser and React examples. Update the roadmap to match demonstrated support.                                      |

Start with the mutually compatible host majors represented by Nest 12 and Fastify 5. During planning the registry reported Nest 12.6.0, Fastify 5.12.8, Connect 2.3.0, grpc-js 1.14.7, proto-loader 0.8.1 and soap 1.14.1. At execution verify peers against the actual checkout, lock compatible versions, and list the versions exercised in CI. Isolate public declarations and runtime imports by subpath. Install each fixture's declared peers and real transitive dependencies. Keep the root package and existing host fixtures usable without any newly optional server dependency.

## Verification and definition of done

1. Run `bun install --frozen-lockfile` and `bun run ci` at baseline and at the integrated head. The repository CI uses Node 26 and Bun 1.4.4 at the baseline. Use the workflow's pinned pnpm and Yarn for existing setup checks. Record baseline failures separately with the commit and reproduction command.
2. Keep `bun run test:transports --reporter=verbose`, `bun run build`, and `bun run test:hosts` green. Extend Wireit's build inputs and outputs for proto, WSDL and generated descriptors. Cold and cached builds must both pack the assets. Use clean tarball installs and strict NodeNext consumer compilation. Resolve both asset paths through package exports from a different working directory. Check public entry points for cycles and unused dependencies.
3. Add a discoverable `bun run test:protocol-browser` command and run it in GitHub Actions starting in PR 4. Install pinned Chromium tooling, start disposable hosts and the test Envoy container, wait for readiness, exercise both same-origin and explicit credentialed cross-origin configurations, and clean up on failure. Have JavaScript on a real page perform the requests. In the cross-origin fixture configure an explicit allowed origin, permit the actual request headers (including SOAPAction for SOAP), allow credentials, and expose the RPC status headers needed by the transport. Expose `grpc-status` and `grpc-message`, then verify the browser reads the status of a trailers-only denial. Validate that preflight succeeds independently of the authenticated POST. Cover malformed responses, missing credentials versus rejected credentials, cancellation, and typed protocol errors in the appropriate live or deterministic contract fixture.
4. Preserve the five DB jobs and their existing integrations. Extend the PostgreSQL job's `bun run test:journey` (or add a named companion command there) with a packed consumer and the real v2 schema from `xp setup`. For a stored user and enabled experiment, resolve through standalone Fastify, both Nest platforms, native gRPC, both browser RPC deployments, and SOAP. Assert the same qualified slug and exactly one persisted membership across repeated and overlapping transports. Assert both guest cases write nothing. Verify pause returns null, resume restores the sticky result, and a known user's missing experiment reaches the client as an error. Keep the existing Express/Yoga/Apollo journey running.
5. In the browser journey give A and B different known cohorts. Delay A's response, switch the React `sessionKey`, display B's branch, then release A. Assert B's branch stays visible. Exercise both new shortcuts, at least one real proxy-backed React call, and a retry after a host denial. Assert hook status as well as the rendered gate to distinguish error from ready/null.
6. Give each PR its own feature demo, exact commands and head SHA. If a lower PR changes, update its descendants and recheck affected heads. Report a missing Docker, browser or cloud capability explicitly and use a capable CI runner for the required evidence. Final handoff includes the review order, verified checks, peer versions, tested schema paths, and commands to reproduce the browser and database journeys. Leave all seven PRs open for maintainer review.
