# Microsoft SQL Server

Use [`xp setup`](../cli.md) to generate the setup files for this provider and your selected ORM. Review and apply them through your application’s normal workflow.

The SQL Server adaptor accepts a connected `mssql.ConnectionPool` using the default Tedious driver. SQL Server 2025 on Linux amd64 is the integration-test baseline. Install `mssql` in your application; xp loads its optional peer dependency only when needed.

```ts
import sql from "mssql";
import server from "xp/server";

const pool = await new sql.ConnectionPool({
  server: process.env.SQL_SERVER!,
  database: process.env.SQL_DATABASE!,
  user: process.env.SQL_USER!,
  password: process.env.SQL_PASSWORD!,
  options: { encrypt: true, trustServerCertificate: false },
}).connect();

const experiments = server(pool);
// Close the pool when your application shuts down, not after each xp operation.
```

xp owns neither the pool nor its connection lifecycle. It does not connect, close, create tables, or run migrations. Transactions reserve a connection from the pool; every transaction request uses that reserved connection. Read requests use the pool directly. The native `msnodesqlv8` driver and caller-managed transactions are not supported by this adaptor.

## Manual schema setup

Run this schema in the database selected by the supplied pool. The example uses `dbo` tables, text application user IDs, and integer xp-owned IDs. If the application already has a `users` table, retain it and make `user_cohorts.user_id` use its exact SQL type and collation. Supply matching JavaScript primitive IDs; xp never implicitly creates users.

```sql
CREATE TABLE users (
  id NVARCHAR(255) COLLATE Latin1_General_100_BIN2 NOT NULL PRIMARY KEY
);

CREATE TABLE experiments (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  name NVARCHAR(MAX) NOT NULL,
  slug NVARCHAR(255) COLLATE Latin1_General_100_BIN2 NOT NULL UNIQUE,
  type NVARCHAR(20) NOT NULL CHECK (type IN ('flag', 'simple', 'multivariate', 'dynamic')),
  description NVARCHAR(MAX) NOT NULL,
  winner NVARCHAR(255) COLLATE Latin1_General_100_BIN2 NULL
);

CREATE TABLE cohorts (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  experiment_id INT NOT NULL REFERENCES experiments(id),
  slug NVARCHAR(255) COLLATE Latin1_General_100_BIN2 NOT NULL UNIQUE,
  type NVARCHAR(20) NOT NULL CHECK (type IN ('control', 'treatment')),
  description NVARCHAR(MAX) NOT NULL,
  percentage FLOAT NOT NULL CHECK (percentage >= 0 AND percentage <= 100),
  value NVARCHAR(MAX) NOT NULL DEFAULT N'null' CHECK (ISJSON(value, VALUE) = 1),
  UNIQUE (id, experiment_id)
);
CREATE INDEX cohorts_experiment_id_idx ON cohorts(experiment_id);

CREATE TABLE user_cohorts (
  id INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  user_id NVARCHAR(255) COLLATE Latin1_General_100_BIN2 NOT NULL REFERENCES users(id),
  experiment_id INT NOT NULL REFERENCES experiments(id),
  cohort_id INT NOT NULL,
  UNIQUE (user_id, experiment_id),
  FOREIGN KEY (cohort_id, experiment_id) REFERENCES cohorts(id, experiment_id)
);
CREATE INDEX user_cohorts_experiment_id_idx ON user_cohorts(experiment_id);
CREATE INDEX user_cohorts_cohort_id_idx ON user_cohorts(cohort_id);
```

The example limits slugs and user IDs to 255 UTF-16 code units. Binary collation preserves case-sensitive identity. Unique slug indexes, assignment uniqueness, and the composite cohort/experiment foreign key are part of the required schema. The `value` column stores serialized JSON, including scalar values and JSON `null`; do not replace its check with the object/array-only form of `ISJSON`.

Table names are fixed. Foreign keys use `NO ACTION`: xp performs ordered transactional cleanup rather than configuring multiple database cascade paths. Inserts use `OUTPUT INSERTED.*`, so triggers that prohibit this form of `OUTPUT` require application-specific adaptation and are outside the supported schema.

## Behavior and locking

- Experiments and their initial cohorts are created in one transaction. Supplied percentages and JSON values are retained; the initial winner is `null`.
- Experiment reads include current cohorts. Returned identifiers are primitive values, and SQL Server result metadata is not exposed.
- Every mutation locks the parent experiment using `UPDLOCK, HOLDLOCK` before changing its children, memberships, or winner. This coordinates insertion, finalization, and deletion across concurrent calls.
- An assignment requires an existing user, experiment, and matching cohort. Only one assignment per user/experiment is permitted. Concurrent `getGroup()` calls return the persisted assignment; explicit duplicate joins reject.
- Experiment deletion removes dependent assignments and cohorts. Cohort deletion removes its assignments and clears the winner if that cohort won. User records remain. These changes commit or roll back together.
- Required ID reads reject with `NotFoundError`, optional lookups return `null`, and missing update/delete targets or empty updates are no-ops.
- Values are bound as typed request parameters. Unicode strings and JSON use `NVARCHAR(MAX)`; percentages use numeric parameters without losing their fractional part.

Use an application database user with the required data permissions. The integration tests use an administrator only to create and remove their isolated test databases; xp itself does not require database creation permission.

## Integration tests

Start the SQL Server test service and run:

```sh
XP_DATABASE=mssql bun run test:integration
```

The default connection is `127.0.0.1:1434`, user `sa`, password `Xp_test_Password123!`. Configure `MSSQL_HOST`, `MSSQL_PORT`, `MSSQL_USER`, and `MSSQL_SA_PASSWORD` to use another local test server. Fixtures create a unique database for each test and drop it afterward. Test connections trust the local certificate and disable transport encryption; the production example above uses certificate validation and encryption.

Linux amd64 CI is authoritative for container integration. Running the amd64 SQL Server image under Apple Silicon emulation may be slow or unsupported. Unit tests separately verify transaction-bound requests, typed parameter binding, commit/rollback behavior, automatic rollback handling, and connection ownership.
