# DynamoDB

Use [`xp setup`](../cli.md) to generate the setup files for this provider and your selected ORM. Review and apply them through your application’s normal workflow.

The adaptor uses AWS SDK v3's `DynamoDBDocumentClient` and one pre-existing table. It supports Amazon DynamoDB and DynamoDB Local with the same key layout. No secondary indexes, streams, TTL configuration, or background workers are required.

## Connect

```ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import server from "xp/server";

const raw = new DynamoDBClient({ region: "us-east-1" });
const client = DynamoDBDocumentClient.from(raw);
const xp = server(client, { tableName: "xp" });
```

Install `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` alongside xp. The adaptor is detected from the document client's constructor. A low-level `DynamoDBClient` is not accepted. Use the normal document-client JSON marshalling/unmarshalling settings; `wrapNumbers` and class-instance conversion are not part of the supported entity contract. The application owns AWS credentials, endpoint selection, retry configuration, and client shutdown. Construction neither provisions the table nor sends a request.

## Provision the table

Run this yourself, or express the same definition in your infrastructure tooling:

```sh
aws dynamodb create-table \
  --table-name xp \
  --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST
```

Both key attributes are strings. The table must be active before invoking xp operations. The application needs table permissions for `GetItem`, `Query`, `Scan`, `PutItem`, `UpdateItem`, `DeleteItem`, and `ConditionCheckItem`. DynamoDB authorizes transactional operations through those underlying item permissions. Setup additionally needs create-table permissions; xp does not provision tables at runtime. [Transaction IAM permissions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis-iam.html)

The canonical layout is:

| Record                       | `pk`                     | `sk`                  | Additional fields                                                                    |
| ---------------------------- | ------------------------ | --------------------- | ------------------------------------------------------------------------------------ |
| Experiment                   | `EXP#<experiment-id>`    | `META`                | `id`, `name`, `slug`, `description`, `type`, `winner`, `state`                       |
| Experiment slug claim        | `EXP_SLUG#<slug>`        | `META`                | `experiment_id`                                                                      |
| Cohort                       | `EXP#<experiment-id>`    | `C#<cohort-id>`       | `id`, `experiment_id`, `slug`, `description`, `percentage`, `type`, `value`, `state` |
| Cohort locator               | `COHORT#<cohort-id>`     | `META`                | `cohort_id`, `experiment_id`                                                         |
| Cohort slug claim            | `COHORT_SLUG#<slug>`     | `META`                | `cohort_id`, `experiment_id`                                                         |
| User assignment              | `EXP#<experiment-id>`    | `M#<encoded-user-id>` | `id`, `user_id`, `experiment_id`, `cohort_id`                                        |
| Assignment reverse reference | `COHORT#<cohort-id>`     | `M#<encoded-user-id>` | Same assignment fields and assignment `id`                                           |
| Existing user                | `USER#<encoded-user-id>` | `META`                | `id`                                                                                 |

xp generates UUID strings for experiment, cohort, and assignment IDs. `state` is `active` or `deleting` and is private to the adaptor. Returned entities never expose `pk`, `sk`, or deletion metadata. Experiment results hydrate their cohorts; the stored experiment record does not embed them.

The application must provision each user before assigning them. User IDs may be strings or finite numbers. The encoding is base64url of UTF-8 JSON `[typeof id, id]`, preserving the distinction between `1` and `"1"`:

```ts
import { PutCommand } from "@aws-sdk/lib-dynamodb";

const id = "application-user-42";
const encoded = Buffer.from(JSON.stringify([typeof id, id])).toString("base64url");
await client.send(
  new PutCommand({
    TableName: "xp",
    Item: { pk: `USER#${encoded}`, sk: "META", id },
  }),
);
```

Store the same primitive value in `id` that you pass to xp. There is no implicit user creation or arbitrary external identity-store lookup. Mutate xp-owned records through the adaptor; direct edits that bypass claims, parent checks, or paired assignment writes can violate its integrity guarantees.

## Limits and consistency

Experiment creation is one conditional transaction: two experiment items plus three items per initial cohort. At most **32 initial cohorts** are accepted (`2 + 3 × 32 = 98` actions); 33 or more are rejected before any request. Further cohorts can be added individually. DynamoDB's separate limits still apply: 100 distinct items and 4 MiB per transaction, and 400 KiB per item. A service rejection leaves no partial experiment. [AWS transaction documentation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html)

Slug claims and assignment keys enforce uniqueness. Every child insertion checks its active parent in the same transaction. Finalization checks that the exact winning cohort ID is still active and belongs to the experiment, so deleting a cohort and reusing its slug cannot finalize the replacement accidentally. Assignment writes also require an existing user.

Point reads and queries are strongly consistent on the base table; related assignment reads use a transactional snapshot. List operations fully paginate a filtered table scan. Reads are not a table-wide snapshot when other operations are concurrently changing the experiment set. Cohort queries also consume every page. Table size therefore affects the cost and duration of `list()`.

## Cascading deletion and retries

Deleting an experiment or cohort first marks it `deleting`. Subsequent reads hide it, and conditional writes prevent new dependents. Deleting a winning cohort clears the experiment's winner, allowing subsequent bucketing. Cleanup then removes assignments and their reverse references, dependent cohorts, locators, and slug claims.

Cleanup queries pages of up to 25 records and uses ownership-checked transactional deletes. Those checks protect a replacement assignment after leave/rejoin and protect records that reuse an already released slug. Transaction conflicts have at most five application attempts with backoff, in addition to the SDK's configured transport retries.

`remove(id)` resolves only after physical cleanup completes. A rejected call may already have hidden the target. Its tombstone and slug reservations remain until cleanup finishes; invoke **the same `remove(id)` again** to resume. This also works after an application restart. There is no automatic worker to retry abandoned failures. After interrupted cohort cleanup, hidden assignments may still reserve their user/experiment keys, so joining or bucketing those users can fail until the same cohort removal is resumed. Overlapping removal calls are safe, and removing an already absent ID is a no-op.

## Local tests

Use the repository's DynamoDB Local service and run:

```sh
XP_DATABASE=dynamodb DYNAMODB_ENDPOINT=http://127.0.0.1:8000 bun run test:integration
```

Tests create isolated tables with dummy local credentials and delete them afterward. They cover the shared storage contract, transaction/item limits, pagination, interrupted cleanup, overlapping cascades, leave/rejoin races, and slug reuse. The CLI can generate the table input; production provisioning remains application-owned.
