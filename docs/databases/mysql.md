# MySQL

The MySQL adaptor supports `mysql2/promise` connections and pools. MySQL 8.0 is the integration-test baseline. Install `mysql2` in the application; it is an optional peer dependency of xp.

```ts
import { createPool } from "mysql2/promise";
import server from "xp/server";

const pool = createPool({
  host: "localhost",
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: "experiments",
});
const xp = server(pool);

// Your application owns connection shutdown.
// await pool.end();
```

The callback API from `mysql2` is not accepted directly. Call `.promise()` on that connection or pool before passing it to xp. Do not pass a connection URI or an unresolved connection promise.

xp does not connect an externally supplied standalone connection, close a connection/pool, create tables, or run migrations. A pool borrows and releases a connection for each operation; every transaction stays on its borrowed connection.

## Manual schema setup

Run this schema in the database selected by the supplied client. Use InnoDB so transactions and foreign keys are enforced. These commands belong in the application's provisioning or migration process; future CLI setup helpers are tracked in the project roadmap.

```sql
CREATE TABLE users (
  id VARCHAR(191) COLLATE utf8mb4_0900_bin PRIMARY KEY
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE experiments (
  id INTEGER AUTO_INCREMENT PRIMARY KEY,
  name TEXT NOT NULL,
  slug VARCHAR(191) COLLATE utf8mb4_0900_bin NOT NULL UNIQUE,
  type VARCHAR(32) NOT NULL CHECK (type IN ('flag', 'simple', 'multivariate', 'dynamic')),
  description TEXT NOT NULL,
  winner VARCHAR(191) COLLATE utf8mb4_0900_bin
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE cohorts (
  id INTEGER AUTO_INCREMENT PRIMARY KEY,
  experiment_id INTEGER NOT NULL,
  slug VARCHAR(191) COLLATE utf8mb4_0900_bin NOT NULL UNIQUE,
  type VARCHAR(32) NOT NULL CHECK (type IN ('control', 'treatment')),
  description TEXT NOT NULL,
  percentage DOUBLE NOT NULL CHECK (percentage >= 0 AND percentage <= 100),
  value JSON NOT NULL,
  UNIQUE (id, experiment_id),
  FOREIGN KEY (experiment_id) REFERENCES experiments(id),
  INDEX cohorts_experiment_id_idx (experiment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE user_cohorts (
  id INTEGER AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(191) COLLATE utf8mb4_0900_bin NOT NULL,
  experiment_id INTEGER NOT NULL,
  cohort_id INTEGER NOT NULL,
  UNIQUE (user_id, experiment_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (experiment_id) REFERENCES experiments(id),
  FOREIGN KEY (cohort_id, experiment_id) REFERENCES cohorts(id, experiment_id),
  INDEX user_cohorts_experiment_id_idx (experiment_id),
  INDEX user_cohorts_cohort_id_idx (cohort_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

If the application already has a `users` table, retain it and adapt `user_cohorts.user_id` to match its key type and collation. Users must exist before assignment; xp does not create them. Pass IDs in the corresponding JavaScript primitive type. The example uses string user IDs and integer xp-owned IDs. Its binary, non-padding collation preserves case and trailing-space distinctions. The example bounds user IDs and slugs to 191 characters; applications needing longer keys must provision compatible indexed columns and account for MySQL index-size limits.

Table names are fixed. The uniqueness constraints and foreign keys are required parts of the adaptor contract. Relationships use InnoDB's default restrictive behavior; xp performs ordered cascades within transactions rather than delegating deletion to foreign keys.

`winner` is a nullable cohort slug. xp validates that a selected winner belongs to the experiment. `value` is a JSON column: objects, arrays, numbers, booleans, JSON strings, and JSON null all round-trip. xp preserves supplied percentages and defaults omitted values to JSON null. JSON reads work with either mysql2's default JSON decoding or `jsonStrings: true`.

## Concurrency and ownership

Prefer a pool when the application shares database access. Mutations acquire the parent experiment lock before changing cohorts, assignments, or winners. Experiment creation is atomic, and any failed cohort insertion rolls back the entire creation.

Operations sharing a standalone promise connection are serialized across xp instances. Do not concurrently issue application queries or manage an application transaction on that same connection; xp cannot coordinate external code. Use a dedicated connection or pass the pool. xp releases borrowed connections after success and rollback without closing the caller's pool.

Deleting an experiment removes its cohorts and assignments while preserving users. Deleting a cohort removes its assignments and clears `winner` if necessary, allowing later calls to resume bucketing. Repeated deletion of missing records and empty updates are no-ops.

## Integration tests

Start the repository's MySQL service, then run:

```sh
XP_DATABASE=mysql bun run test:integration
```

Tests default to host `127.0.0.1`, port `3307`, user `root`, and password `root_password`. Override `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, and `MYSQL_PASSWORD` for another dedicated test server. Each fixture creates and drops a uniquely named database, so the test account requires database creation privileges. This test-only provisioning is not a production initialization API.
