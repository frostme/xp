# Project setup CLI

Install `xp` in the application, then run its local executable:

```sh
bun run xp setup
pnpm exec xp setup
npm exec -- xp setup
yarn exec xp setup
```

`xp setup` generates storage files for the application's migration or infrastructure workflow. It does not install packages, connect to a database, apply migrations, or provision resources. Installed schema tools may run locally to generate or validate files. The application still passes a supported native database client to `xp/server`; selecting an ORM does not add an ORM runtime adapter.

## Wizard

Setup inspects the selected package, installed ORM versions, configuration literals, schema/model files, and conventional directories. It recognizes Sequelize, Prisma, Drizzle, TypeORM, MikroORM, Knex, Kysely, Mongoose, and native database drivers. Project detection does not execute application configuration.

A fully detected project opens directly on a confirmation screen. Missing or ambiguous choices open individual prompts. The summary shows the selected database, paths, language, module format, user identity contract, and all file changes. Press **e** to edit choices, **p** to inspect before/after contents, **Enter** to generate, or **q** to cancel. Directory fields support arrow-key browsing and **Tab** for typing a new or existing path. **Esc** returns to the previous step, and **Ctrl+E** opens all setup choices while answering a prompt. No files are written before confirmation.

Supporting models/entities/types are optional and off by default. Prisma and Drizzle schemas are required parts of their migration workflows. Models use explicit physical names and do not enable automatic synchronization, collection creation, or index creation.

Arguments override saved choices, which override detected settings, which override conventional defaults. In a monorepo, run from the application package or select it with `--cwd`. For shared files, select a workspace root containing all required paths. Setup refuses to write outside that root or through symlinks.

## Arguments and automation

```sh
# Explicit Sequelize migration; optional models alongside it.
bun run xp setup --orm sequelize --database postgres \
  --migrations-dir migrations --models --models-dir src/models \
  --language typescript --user-id-type uuid

# Preview native SQL for a fresh application, without changing its files.
pnpm exec xp setup --orm none --database postgres \
  --user-storage create --dry-run

# Existing MySQL users: match their physical primary-key declaration.
xp setup --orm knex --database mysql --user-storage reuse \
  --user-id-type 'VARCHAR(191)' --user-id-charset utf8mb4 \
  --user-id-collation utf8mb4_0900_bin --non-interactive --yes
```

| Flag                                       | Purpose                                                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `--cwd`                                    | Project directory                                                                                         |
| `--orm`, `--database`                      | Generator and database provider                                                                           |
| `--orm-version`                            | Supported output profile when the ORM is not installed; cannot override an incompatible installed version |
| `--config`, `--schema`                     | ORM configuration and schema path                                                                         |
| `--migrations-dir`                         | Migration/provisioning output directory                                                                   |
| `--models`, `--no-models`, `--models-dir`  | Optional supporting models/types and their directory                                                      |
| `--language`                               | `typescript` or `javascript`                                                                              |
| `--module-format`                          | `esm` or `commonjs`                                                                                       |
| `--user-storage`                           | `reuse` (default) or explicit minimal `create`                                                            |
| `--user-id-type`                           | Exact SQL type, including length/unsignedness; `string` or `number` for MongoDB                           |
| `--user-id-collation`, `--user-id-charset` | Existing character-key settings where applicable                                                          |
| `--table-name`                             | DynamoDB table name                                                                                       |
| `--yes`                                    | Accept resolved choices without opening the wizard                                                        |
| `--non-interactive`                        | Never prompt; writing requires `--yes`                                                                    |
| `--dry-run`                                | Display the complete proposed output without changing the project                                         |
| `--help`, `--version`                      | Command reference and package version                                                                     |

Noninteractive runs fail with the missing choices rather than guess them. `--yes` does not bypass missing values, incompatible versions, or existing-file conflicts. Dry runs may use temporary files and installed local generators; they do not change the application directory.

## Supported generator profiles

SQL below means PostgreSQL, MySQL, and SQL Server. SQLite and MariaDB are not xp runtime providers. Untested versions, prereleases, and incompatible tool/provider pairs produce an explanation; use `--orm none` for native output when appropriate.

| Tool      | Profile                 | Providers          | Output                                                          |
| --------- | ----------------------- | ------------------ | --------------------------------------------------------------- |
| Sequelize | 6.x; CLI 6.x            | SQL                | CommonJS `.cjs` up/down migration; optional models              |
| TypeORM   | 1.x                     | SQL, MongoDB       | SQL migration or Mongo bootstrap; optional EntitySchema files   |
| MikroORM  | 7.x                     | SQL, MongoDB       | Provider-specific migration; optional EntitySchema files        |
| Prisma    | 7.x SQL; 6.19.x Mongo   | SQL, MongoDB       | Prisma schema integration and SQL migration or Mongo bootstrap  |
| Drizzle   | ORM 0.45.x; Kit 0.31.x  | PostgreSQL, MySQL  | Schema module, migration, and tool-generated metadata           |
| Kysely    | 0.29.x                  | SQL                | Up/down migration; optional database interfaces                 |
| Knex      | 3.x                     | SQL                | Up/down migration; optional table declarations                  |
| Mongoose  | 9.x                     | MongoDB            | Bootstrap script; optional schemas/models                       |
| None      | Native storage contract | All five providers | SQL up/down files, Mongo bootstrap, DynamoDB create-table input |

The consuming application's installed versions are checked. Missing packages are listed as manual prerequisites; setup never downloads them. Supporting types and entities may require registration in the application's configuration. The result clearly reports any remaining integration work.

Sequelize CLI v6 receives runnable CommonJS migrations even when application models use TypeScript or ESM. Other TypeScript migrations need the application's configured loader or compilation step. MikroORM SQL setup also emits schema-generator exclusion settings for xp-owned tables; merge them so later automatic diffs do not remove the canonical storage contract. Kysely migrations use the application's migration runner.

Prisma SQL output includes physical mappings, user relations, and canonical SQL constraints. Setup does not invoke `prisma migrate dev --create-only`, which can require database access. Existing schemas receive a precise reviewed merge where their structure can be resolved; ambiguous schemas receive a separate contribution and manual integration instructions.

Drizzle generation stages the full schema and migration history, supplies a generated config, and invokes the installed `drizzle-kit generate` directly. It preserves tool-created snapshots and journals, supplements the new SQL with required constraints, and rejects unrelated pending schema changes. Schema modules are evaluated by Drizzle; sources coupled to application startup or unsupported loaders require manual integration. Missing Kit or an unsupported schema layout produces files plus explicit instructions, rather than a claimed complete migration.

## User storage and database requirements

The current runtime requires users at physical `users.id`. Setup defaults to reusing it. SQL foreign keys must match its type, length, unsignedness, charset, and collation. Setup detects these where possible and requests unresolved details. A differently named account table, custom identity column, or external identity service requires application integration beyond this command.

For a fresh application, `--user-storage create` explicitly scaffolds minimal user storage. The application must still create user records before assignments. Rollback always preserves users, including a scaffolded users table.

MongoDB requires a replica set or transaction-capable sharded cluster. Its physical primitive `id` is distinct from `_id`; an ObjectId `_id` alone is insufficient. Generated bootstrap code checks the user identity prerequisite, creates required collections/indexes, and never backfills identities. Mongoose models disable automatic provisioning.

DynamoDB output describes the single table with string `pk`/`sk`, on-demand billing, and no secondary indexes. Completion instructions describe explicit user provisioning using the runtime's key encoding.

## Review, reruns, and recovery

Setup records normalized choices, storage version, generated paths, and fingerprints in `.xp/setup.json`. It does not save connection credentials. Commit this file with the generated artifacts.

An unchanged rerun is a no-op. Changed or missing generated files are reported as conflicts; setup does not overwrite manual edits or rewrite historical migrations. Different setup options after initial generation require an explicit follow-up migration. Schema upgrades are not inferred from deleting or replacing the manifest.

Planning fingerprints source files and applying checks them again. New files and precise existing schema/config changes are staged before publication. If writing fails, setup attempts to restore its changes while preserving concurrent edits. The final result distinguishes complete file generation from files requiring manual integration; it never means the database has been migrated.

## Programmatic interface

Importing `xp/cli` has no terminal or argument-parsing side effects:

```ts
import cli, { type SetupOptions } from "xp/cli";

const setup = cli();
const options: SetupOptions = {
  cwd: process.cwd(),
  orm: "none",
  database: "postgres",
  userStorage: "create",
};
const detected = await setup.detectProject(options);
const plan = await setup.planSetup(options);
// Present plan.files, warnings, and prerequisites in your own review interface.
const result = await setup.applySetup(plan);
```

The exported types include `SetupOptions`, `ProjectDetection`, `SetupPlan`, and `SetupResult`. A custom `IProjectManager` can be passed to `cli(manager)`. Framework/use-case code depends on interfaces; terminal, filesystem, discovery, and generator integrations live in outer adaptors.
