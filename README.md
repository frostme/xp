# xp

A TypeScript experiment framework with caller-owned database connections.

```ts
import pg from "pg";
import server from "xp/server";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const xp = server(pool);
```

Generate your application’s setup files with the interactive CLI:

```sh
bun run xp setup
# or: pnpm exec xp setup
```

The wizard detects your ORM and project layout, previews migrations/schema changes,
and optionally generates supporting models. It writes files without applying them.
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

## Development

```sh
bun install
bun run ci
docker compose -f docker-compose.test.yml up -d --wait postgres
XP_DATABASE=postgres bun run test:integration
docker compose -f docker-compose.test.yml down -v
```

Integration tests create and destroy isolated fixtures. Live database checks are
not cached. Static checks and package-import smoke tests do not need a database.
Select `postgres`, `mysql`, `mssql`, `mongodb`, or `dynamodb` with `XP_DATABASE`;
start the matching Compose service. SQL Server integration runs on native Linux
amd64 CI because local ARM emulation is unsupported.

## PostgreSQL compatibility changes

Experiment reads now include cohorts, creation preserves percentages and JSON
values, and valid prefixed cohort slugs are accepted. Required lookups throw
`NotFoundError`; nullable lookups return `null`. Empty updates and deleting absent
records are no-ops. Duplicate assignments are rejected; concurrent `getGroup()`
calls return the stored assignment. Review the documented uniqueness/foreign-key
constraints and cascade behavior before upgrading an existing schema.

See the [CLI guide](docs/cli.md) for setup tooling and the [roadmap](docs/roadmap.md) for remaining work.
