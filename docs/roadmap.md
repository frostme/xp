# Roadmap

The current release includes native storage on PostgreSQL, MySQL, SQL Server, MongoDB and DynamoDB, Sequelize 6 on the three SQL providers, the v2 storage upgrade, startup seeding, and frontend decisions over Express, GraphQL Yoga and Apollo Server. [Consumer guide](experiments.md) · [Setup CLI](cli.md)

## Client frameworks

The package includes React DOM, Vue and Nuxt, standalone Angular, Svelte and SvelteKit, Solid 1.9 and 2, SolidStart, and request-local Astro pages. Astro can hydrate React, Vue, Svelte and Solid 1.9 islands. Custom frontends can subscribe to `createXpSession`. [Frontend usage and SSR](experiments.md) · [Setup profiles](cli.md)

## Server frameworks and protocols

NestJS and Fastify integrations will adapt request identity and application-local runtime registration to the shared server decision. gRPC and SOAP bindings will expose the same semantics through their respective schemas.

## Operations and storage

Future projects include analytics connectors and a hosted or self-hostable experiment management page. Further ORM runtime adapters, generator/version profiles, migration execution, cross-database migration, external identity storage and weighted bucketing remain open.
