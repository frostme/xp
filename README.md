# xp

A TypeScript experiment framework with caller-owned database connections. Declare experiments in `xp.config.json`, resolve assignments through your existing service, and render sticky decisions in React, Vue, Angular, Svelte, Solid or Astro. [Consumer guide](docs/experiments.md)

| Host or client | Integration guide                                                                                                                                                                        |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REST           | [Express](docs/experiments.md#express), [Fastify](docs/experiments.md#fastify), [NestJS on Express or Fastify](docs/experiments.md#nestjs-on-express-or-fastify)                         |
| GraphQL        | [Yoga and Apollo](docs/experiments.md#graphql-yoga-and-apollo-server)                                                                                                                    |
| RPC            | [Native gRPC and Envoy](docs/experiments.md#native-grpc-and-the-envoy-bridge), [direct Node gRPC-Web](docs/experiments.md#direct-node-grpc-web), [SOAP 1.1](docs/experiments.md#soap-11) |
| Browser        | [Protocol loaders](docs/experiments.md#browser-protocol-loaders), [React provider and hooks](docs/experiments.md#react-components-and-hooks)                                             |

```sh
npm install @frostme/xp
```

```ts
import server from "@frostme/xp/server";
import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const xp = server(pool);
```

Generate your application’s setup files with the interactive CLI:

```sh
bun run xp setup
# or: pnpm exec xp setup
```

Select the application package and preview its frontend wiring before applying it.

```sh
xp setup --cwd apps/shop --scope frontend --frontend vue --transport rest --endpoint /api/xp --dry-run
xp setup --cwd apps/shop --scope frontend --frontend vue --transport rest --endpoint /api/xp --yes
```

Setup recognizes React DOM, Vue, Nuxt, standalone Angular, Svelte, SvelteKit, Solid, SolidStart and Astro. The generated example uses the seeded `checkout-banner` experiment. Connect the provider to the host's public session revision so it updates on login, logout and account changes. On the server, preload decisions after authenticating the request and serve personalized HTML with `Cache-Control: private, no-store`.

The storage scope previews migrations, schemas and optional supporting models. Use `--scope both` to review storage and frontend changes together.
See the [CLI guide](docs/cli.md) for supported tools, flags, and automation.

Install the driver for the database you use. Drivers are optional peers; xp does not
connect, create schemas, migrate data, or close your client. See
the setup guide for your provider before the first operation:

| Database   | Driver and client                                     | Construction                       | Setup                                                |
| ---------- | ----------------------------------------------------- | ---------------------------------- | ---------------------------------------------------- |
| PostgreSQL | `pg.Client` or `pg.Pool`                              | `server(client)`                   | [Schema](docs/databases/postgres.md)                 |
| MySQL      | `mysql2/promise` connection or pool                   | `server(client)`                   | [Schema](docs/databases/mysql.md)                    |
| SQL Server | `mssql.ConnectionPool`                                | `server(pool)`                     | [Schema](docs/databases/mssql.md)                    |
| MongoDB    | `mongodb.MongoClient`                                 | `server(client, { databaseName })` | [Collections and indexes](docs/databases/mongodb.md) |
| DynamoDB   | `DynamoDBDocumentClient` from `@aws-sdk/lib-dynamodb` | `server(client, { tableName })`    | [Table and keys](docs/databases/dynamodb.md)         |

For Sequelize 6, call `server(sequelize)` with the application's connected instance.
Use PostgreSQL with `pg`, MySQL with `mysql2`, or SQL Server with `tedious`.
The application owns migrations, authentication, the connection pool, and shutdown.

MongoDB requires a replica set. DynamoDB allows at most 32 initial cohorts per
experiment; its staged deletions must be retried by ID after failures to finish
cleanup. See the provider guides for size limits and operating requirements.

The application must provide user records before assigning users. IDs are strings
or numbers; use the same primitive representation when reading and writing them.
Experiment and cohort slugs are unique. Each user can have one assignment per
experiment. Removing an experiment removes its cohorts and assignments. Removing
a cohort removes its assignments and clears that cohort as winner, if necessary;
the experiment then resumes normal bucketing.

Cohort percentages are stored as supplied. The current random bucketer still
chooses uniformly, rather than weighting choices by percentage.

## Cohort join analytics

Applications can opt into durable delivery of new memberships to Amplitude, Segment, Mixpanel, Fullstory, Heap, PostHog or a custom server adaptor. The host maps consent and identity per destination, runs the worker and controls retention. [Configuration, delivery guarantees and provider examples](docs/analytics.md)

## Development

```sh
bun install
bun run ci
docker compose -f docker-compose.test.yml up -d --wait postgres
XP_DATABASE=postgres bun run test:integration
docker compose -f docker-compose.test.yml down -v
```

Integration tests create and destroy isolated fixtures. Live database checks are
not cached. Static checks and package-import smoke tests run independently of the databases. Run `bun run test:transports --reporter=verbose` for host and loader contracts. After `bun run build`, `bun run test:hosts` checks isolated tarball consumers and the browser bundle.

For native SSR, hydration and CLI-generated mounts in external tarball consumers, run:

```sh
bun run build
bunx playwright install --with-deps chromium
bun run test:frontend
XP_PROFILE=vue bun run test:frontend
# With the PostgreSQL test service running
bun run test:frontend:journey
```

Select `postgres`, `mysql`, `mssql`, `mongodb`, or `dynamodb` with `XP_DATABASE`;
start the matching Compose service. SQL Server integration runs on native Linux
amd64 CI because local ARM emulation is unsupported.

### Reproduce the packed browser and database journeys

Use Node 26, Bun 1.4.4 and Linux with Docker Compose. Install Chromium for the Playwright version in the lockfile. The browser command starts the test hosts and Envoy and exercises browser gRPC-Web and SOAP.

```sh
bun install --frozen-lockfile
bun run build
bunx --no-install playwright install --with-deps chromium
bun run test:protocol-browser
```

Run both PostgreSQL journeys to check React over Express/Yoga/Apollo and all seven additional mounts against the schema generated by `xp setup`. The protocol journey compares the cohort returned by concurrent calls with the single persisted membership. It also exercises guest access, host denial, retry, account switching, pause and resume. The hosts and browser use the installed tarball.

```sh
docker compose -f docker-compose.test.yml up -d --wait postgres
bun run test:journey
bun run test:protocol-journey
docker compose -f docker-compose.test.yml down -v
```

## PostgreSQL compatibility changes

Experiment reads now include cohorts, creation preserves percentages and JSON
values, and valid prefixed cohort slugs are accepted. Required lookups throw
`NotFoundError`; nullable lookups return `null`. Empty updates and deleting absent
records are no-ops. Duplicate assignments are rejected; concurrent `getGroup()`
calls return the stored assignment. Review the documented uniqueness/foreign-key
constraints and cascade behavior before upgrading an existing schema.

See the [CLI guide](docs/cli.md) for setup tooling and the [roadmap](docs/roadmap.md) for remaining work.
