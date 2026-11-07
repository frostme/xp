# PostgreSQL

The PostgreSQL adaptor supports `pg.Client` and `pg.Pool`. PostgreSQL 16 is the integration-test baseline. Install `pg` in the application; xp treats database drivers as optional peer dependencies.

```ts
import { Pool } from "pg";
import server from "xp/server";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const experiments = server(pool);

// Your application owns connection creation and shutdown.
// Call pool.end() when your application shuts down.
```

xp does not connect or close an externally supplied client, create tables, or run migrations. A `Client` must already be connected. A pool acquires connections as needed; xp releases every borrowed connection after an operation and keeps each transaction on one connection.

## Manual schema setup

Run the following once in the database/schema used by the supplied client. This example uses text application user IDs and integer xp-owned IDs. If the application already has a `users` table, retain it and make `user_cohorts.user_id` match the type of `users.id`. Pass IDs of the corresponding JavaScript primitive type. xp requires the application to create user records before assigning them to an experiment; it never implicitly creates users.

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY
);

CREATE TABLE experiments (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('flag', 'simple', 'multivariate', 'dynamic')),
  description TEXT NOT NULL,
  winner TEXT
);

CREATE TABLE cohorts (
  id SERIAL PRIMARY KEY,
  experiment_id INTEGER NOT NULL REFERENCES experiments(id),
  slug TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('control', 'treatment')),
  description TEXT NOT NULL,
  percentage DOUBLE PRECISION NOT NULL CHECK (percentage >= 0 AND percentage <= 100),
  value JSONB NOT NULL DEFAULT 'null'::jsonb,
  UNIQUE (id, experiment_id)
);
CREATE INDEX cohorts_experiment_id_idx ON cohorts(experiment_id);

CREATE TABLE user_cohorts (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  experiment_id INTEGER NOT NULL REFERENCES experiments(id),
  cohort_id INTEGER NOT NULL,
  UNIQUE (user_id, experiment_id),
  FOREIGN KEY (cohort_id, experiment_id) REFERENCES cohorts(id, experiment_id)
);
CREATE INDEX user_cohorts_experiment_id_idx ON user_cohorts(experiment_id);
CREATE INDEX user_cohorts_cohort_id_idx ON user_cohorts(cohort_id);
```

Use the client's normal PostgreSQL `search_path` to select a schema. Table names are fixed. Unique slugs, the assignment uniqueness constraint, and foreign keys are part of the adaptor contract. Do not omit them. Relationships deliberately use PostgreSQL's default `NO ACTION` behavior: xp performs ordered deletion and winner clearing in a transaction.

The `winner` column stores a cohort slug or SQL `NULL`. xp validates that a winner belongs to its experiment. All cohort JSON values, including strings, numbers, booleans, arrays, objects, and JSON `null`, use `JSONB`.

## Connection ownership and concurrency

Prefer a pool when the application shares database access across requests. A transaction borrows one connection until commit or rollback. Independent operations can use other connections.

xp serializes its operations that share the same standalone `pg.Client`, including operations issued through multiple xp instances. Do not concurrently use that standalone client for application queries or application-managed transactions: xp cannot coordinate code outside the library. Use a dedicated client or pass the pool instead. xp does not expose transaction nesting or accept an application-managed transaction as its client.

## Behavior and existing installations

This version establishes the following contract and corrects the original PostgreSQL adaptor:

- Experiment creation atomically inserts the experiment and initial cohorts. Initial `winner` is `null`.
- Supplied percentages are stored unchanged; the old control=100/treatment=0 override is removed. The random bucketer still selects uniformly and does not use these percentages as weights.
- Cohort slugs use `<experiment-slug>_<cohort-name>`, and validated JSON values are retained. Omitted values become JSON `null`.
- Experiment reads and lists include their current cohorts.
- A user can have only one assignment per experiment. Concurrent `getGroup()` calls return the persisted winning assignment; explicit duplicate joins fail.
- Removing an experiment deletes its cohorts and assignments but keeps application users. Removing a cohort deletes its assignments and clears the experiment winner if needed. Clearing a winner allows subsequent calls to resume bucketing among the remaining cohorts.
- Required ID reads reject with `NotFoundError`; optional lookups return `null`. Empty updates and update/delete calls for absent records are no-ops.

Before upgrading an existing installation, compare its tables with the schema above. Clean up duplicate slugs, duplicate user/experiment assignments, and orphan or mismatched relationships before adding the constraints. Apply any required schema changes through the application's own migration process; xp does not alter existing data or schemas automatically.

## Integration tests

Start the repository's PostgreSQL test service, then run:

```sh
XP_DATABASE=postgres bun run test:integration
```

Tests default to `127.0.0.1:5433`, database `test_db`, user `test_user`, password `test_password`. Override these with `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD`, or supply `POSTGRES_URL`. Each test creates and drops an isolated schema, so its database user needs schema creation permission. These fixtures are test-only provisioning, not a production setup API.
