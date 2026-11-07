# MongoDB

The MongoDB adaptor uses the official `mongodb` Node.js driver and a replica set or sharded cluster supporting transactions. A standalone MongoDB server is not supported. The integration tests use a single-node replica set; production deployments should use an appropriately replicated topology.

```ts
import { MongoClient } from "mongodb";
import server from "xp/server";

const client = new MongoClient(process.env.MONGODB_URL!);
await client.connect();
const xp = server(client, { databaseName: "experiments" });

// Use xp, then close the application's client during application shutdown.
// await client.close();
```

Install `mongodb` in the consuming application. `databaseName` must be explicit and non-empty. xp does not connect, close the client, create collections, create indexes, or migrate stored data during construction.

## Provisioning

Run the following in `mongosh` against the chosen database before using xp. The application owns provisioning; these commands are documentation, not an initialization API. Future CLI setup helpers are tracked in the project roadmap.

```js
use experiments;

db.createCollection("experiments");
db.createCollection("cohorts");
db.createCollection("users");
db.createCollection("user_cohorts");

db.experiments.createIndex({ id: 1 }, { unique: true });
db.experiments.createIndex({ slug: 1 }, { unique: true });
db.cohorts.createIndex({ id: 1 }, { unique: true });
db.cohorts.createIndex({ slug: 1 }, { unique: true });
db.cohorts.createIndex({ experiment_id: 1 });
db.users.createIndex({ id: 1 }, { unique: true });
db.user_cohorts.createIndex({ id: 1 }, { unique: true });
db.user_cohorts.createIndex({ user_id: 1, experiment_id: 1 }, { unique: true });
db.user_cohorts.createIndex({ experiment_id: 1 });
db.user_cohorts.createIndex({ cohort_id: 1 });
```

For an existing `users` collection, retain it and add the required primitive `id` field and unique index instead of running `createCollection("users")`. Every user participating in an experiment must already have a document such as `{ id: "customer-123" }`. xp does not create users. String and numeric IDs are supported; the same type must be supplied on subsequent calls. A MongoDB `ObjectId` alone is insufficient: map the application's ID to a string or number in `users.id`.

The other records have these domain fields:

| Collection     | Fields                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `experiments`  | UUID string `id`, `name`, unique `slug`, `type`, `description`, nullable `winner` cohort slug, internal numeric `version` |
| `cohorts`      | UUID string `id`, `experiment_id`, unique `slug`, `type`, `description`, numeric `percentage`, JSON `value`               |
| `user_cohorts` | UUID string `id`, `user_id`, `experiment_id`, `cohort_id`                                                                 |

MongoDB also assigns its own `_id`. Public results expose the primitive domain IDs and omit `_id`, `version`, and unrelated fields on application user documents. Experiment reads include their cohorts. JSON values and supplied percentages are preserved; missing values become `null`.

Do not write directly to xp-owned collections while the adaptor is operating. All adaptor mutations coordinate through the parent experiment's `version` field inside a transaction. This prevents concurrent cohort creation, membership creation, or finalization from escaping a deletion. Direct writes bypass these relationship guarantees. Application-managed user deletion must likewise be coordinated with its experiment assignments.

## Transactions and deletion

The adaptor uses snapshot reads, majority writes, and primary read preference in transactions. The driver retries designated transient transaction failures. xp ends its sessions without closing the application's client.

Experiment creation inserts the experiment and all its initial cohorts atomically. Deleting an experiment removes its cohorts and assignments in one transaction. Deleting a cohort removes its assignments and clears `winner` if it was the winning cohort, allowing subsequent bucketing. Repeating deletion of an absent record succeeds.

Transactions and document sizes remain subject to MongoDB server limits. A failed transaction rolls back all changes. Large deployments must size transactions and server resources appropriately.

## Local integration tests

Start the repository's MongoDB replica-set service, then run:

```sh
XP_DATABASE=mongodb bun run test:integration
```

The default URI is `mongodb://127.0.0.1:27018/?directConnection=true&replicaSet=rs0`. Override `XP_MONGODB_URL` for another test replica set. Tests create and drop a uniquely named database and therefore require database/index creation privileges; use a dedicated test deployment.
