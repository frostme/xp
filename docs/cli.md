# Project setup CLI

Install `@frostme/xp` in the application, then run its local executable:

```sh
bun run xp setup
pnpm exec xp setup
npm exec -- xp setup
yarn exec xp setup
```

Storage setup generates files for the application's migration or infrastructure workflow. It does not install packages, connect to a database, apply migrations, or provision resources. Installed schema tools may run locally to generate or validate files. The application passes its native database client or Sequelize 6 instance to `@frostme/xp/server`. Other ORM profiles provide schema and migration generation.

## Wizard

Setup inspects the selected package, installed ORM versions, configuration literals, schema/model files, and conventional directories. It recognizes Sequelize, Prisma, Drizzle, TypeORM, MikroORM, Knex, Kysely, Mongoose, and native database drivers. Project detection does not execute application configuration.

A fully detected project opens directly at **Review**. Missing choices open the relevant field. Settings are grouped into **Storage**, **Output**, and **User identity**; saving a field returns to its group, and **Continue to review** validates the choices and prepares a fresh file plan.

The wizard uses TermCN Ink components and the default terminal theme. Use **Tab / Shift+Tab** to change focus, **arrow keys** to operate the focused control, and **Enter** to select or submit. When the wizard navigation is focused, left/right move between settings groups. **Esc** returns from a field or preview; from review it cancels. **Ctrl+C** cancels inspection or planning before writing starts.

Review includes the resolved settings, every proposed file, warnings, and manual prerequisites. Use its action selector to **Generate files**, **Edit settings**, **Preview files**, or **Cancel**. Generation requires a separate confirmation, which defaults to returning to review. Dry runs offer **Finish dry run** and never write files.

Path fields accept new or existing paths relative to the selected project (`--cwd`). Use **up/down** to choose a completion and **right arrow** to accept it; Tab moves focus. Completion excludes symlinks and paths outside the project. Filesystem validation still runs during planning and application.

Preview offers **Changes**, **Complete before**, and **Complete after**, plus a file selector. Tab into the content viewport to scroll with arrows, Page Up / Page Down, or Home / End. Long lines wrap and the viewport adjusts when the terminal is resized. Unchanged files remain readable. No files are written before confirmation.

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

## Frontend and combined setup

From an existing React DOM application with React and React DOM 19.3.1 through 19.x installed, preview the source edits and apply them with the same flags.

```sh
xp setup --cwd apps/shop --scope frontend --frontend react --dry-run
xp setup --cwd apps/shop --scope frontend --frontend react --non-interactive --yes
xp setup --cwd apps/shop --frontend react --transport graphql --endpoint /api/graphql --dry-run
xp setup --cwd apps/shop --scope both --frontend react --orm none --database postgres --user-storage create --dry-run
```

In the wizard, review the suggested scope or choose **Edit settings** to change it. Frontend shows the framework, transport and public endpoint. Combined setup plans both sets of files and applies them under the same project lock. Automated commands without frontend flags retain their storage workflow. A frontend flag selects frontend setup. Use `--scope both` when also passing storage flags.

Detection checks dependencies declared by the selected package and resolves their installed versions, including workspace-hoisted packages. Run setup at the application’s package boundary. REST uses `/xp` and GraphQL uses `/graphql` by default. Supply a public root-relative path or HTTP(S) URL. For a credentialed fetch or headers, pass a loader constructed by your application. Keep query parameters, credentials and tokens out of the endpoint and the setup manifest.

React setup generates `src/xp/provider.tsx` and `src/xp/CheckoutBanner.tsx` (or JSX). The first file exports `AppXp`; the second exports a working `CheckoutBanner` for a seeded `checkout-banner` experiment with a treatment named `on`. Setup wraps a single recognized React DOM `createRoot(...).render(...)` call in `src/main.tsx` or `.jsx`. The preview includes the host edit and its full before/after source. With custom layouts or hydration bootstraps, follow the printed insertion instruction to wrap the server and browser roots with the generated provider. Pass the same request-local preload on both initial renders.

The app owns its auth integration. Supply a public session revision through `sessionKey` and change it when the signed-in account changes. Mount the example inside the provider and point it at an authenticated xp route. The versioned `.xp/frontend.json` records public transport settings, generated file hashes and registration paths. Setup reparses application-owned registrations on every run. Host edits and customized generated modules survive reruns. When a transport change would replace customized plumbing, setup reports the conflicting path for manual reconciliation.

For programmatic review use `detectScoped(options)`, `planScoped(options)` and `applyScoped(plan)` on the `cli()` instance. A frontend-only plan has no storage settings or migration prerequisites. Storage-only callers can keep using `detectProject`, `planSetup` and `applySetup`.

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

When upgrading storage v1, setup recognizes the Prisma or Drizzle config it generated on the first run. The upgrade keeps host config edits and adds the availability field to the integrated Prisma schema. Drizzle preserves its recorded snapshots, applied SQL and subsequent application migrations. A changed xp-owned Drizzle declaration requires a manual schema merge.

Planning fingerprints source files and applying checks them again. New files and precise existing schema/config changes are staged before publication. If writing fails, setup attempts to restore its changes while preserving concurrent edits. The final result distinguishes complete file generation from files requiring manual integration; it never means the database has been migrated.

## Programmatic interface

Importing `@frostme/xp/cli` has no terminal or argument-parsing side effects:

```ts
import cli, { type SetupOptions } from "@frostme/xp/cli";

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

## Upgrading existing storage

Run `xp setup --dry-run` in the application that holds the v1 `.xp/setup.json`. Setup verifies the recorded files and previews the v2 migration and model changes. Run `xp setup` again to generate them. Apply the migration with your application's normal runner before deploying the updated xp server. Previously applied migrations retain their original contents and fingerprints.

### Vue and Nuxt

```sh
xp setup --scope frontend --frontend vue --transport rest --endpoint /api/xp --dry-run
xp setup --scope frontend --frontend nuxt --transport graphql --endpoint /api/graphql --non-interactive --yes
```

The Vue profile follows the component import in a conventional `src/main.ts` or `src/main.js` `createApp(App).mount(...)` call and wraps that component's template. Nuxt wraps `app/app.vue` or creates it for the recognized implicit pages layout. Existing layouts, pages and imports remain in their original order. For a custom mount, import the generated `XpAppProvider.vue` and wrap the host tree used by the browser and SSR. Generated options and the runnable `CheckoutBanner.vue` example live in `src/xp/` for Vue or `app/xp/` for Nuxt.

Set a reactive public session revision and supply personalized decisions through the request bootstrap. Hosts can start with the empty bootstrap and the configured browser endpoint. [Vue and Nuxt authentication and SSR](experiments.md#vue-3-and-nuxt-4)
