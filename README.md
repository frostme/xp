# xp

A TypeScript experiment framework with caller-owned database connections.

```ts
import pg from "pg";
import server from "xp/server";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const xp = server(pool);
```

Install the driver for the database you use. Drivers are optional peers; xp does not
connect, create schemas, migrate data, or close your client. See
[PostgreSQL setup](docs/databases/postgres.md) before the first operation.

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

## PostgreSQL compatibility changes

Experiment reads now include cohorts, creation preserves percentages and JSON
values, and valid prefixed cohort slugs are accepted. Required lookups throw
`NotFoundError`; nullable lookups return `null`. Empty updates and deleting absent
records are no-ops. Duplicate assignments are rejected; concurrent `getGroup()`
calls return the stored assignment. Review the documented uniqueness/foreign-key
constraints and cascade behavior before upgrading an existing schema.

See the [roadmap](docs/roadmap.md) for planned setup tooling.
