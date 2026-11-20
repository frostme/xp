# Roadmap

The current release includes native storage on PostgreSQL, MySQL, SQL Server, MongoDB and DynamoDB, Sequelize 6 on the three SQL providers, the v2 storage upgrade, startup seeding, and React decisions over Express, GraphQL Yoga and Apollo Server. [Consumer guide](experiments.md) · [Setup CLI](cli.md)

## Client frameworks

| Framework | Planned integration                                                            |
| --------- | ------------------------------------------------------------------------------ |
| Vue       | A composable for cohort decisions and experiment/default components.           |
| Angular   | An injectable decision service and experiment/cohort directives or components. |
| Svelte    | A reactive cohort store and experiment/cohort components.                      |
| Astro     | Request-local decisions for server-rendered components and hydrated islands.   |
| Solid     | A cohort resource or hook and reactive experiment/cohort components.           |

## Server frameworks and protocols

NestJS and Fastify integrations will adapt request identity and application-local runtime registration to the shared server decision. gRPC and SOAP bindings will expose the same semantics through their respective schemas.

## Operations and storage

Future projects include analytics connectors and a hosted or self-hostable experiment management page. Further ORM runtime adapters, generator/version profiles, migration execution, cross-database migration, external identity storage and weighted bucketing remain open.
