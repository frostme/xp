# Roadmap

The current release includes native storage on PostgreSQL, MySQL, SQL Server, MongoDB and DynamoDB, Sequelize 6 on the three SQL providers, the v3 storage upgrade, startup seeding, and sticky cohort decisions for REST, GraphQL, gRPC, gRPC-Web and SOAP clients. [Consumer guide](experiments.md) · [Setup CLI](cli.md)

## Client frameworks

The package includes React DOM, Vue and Nuxt, standalone Angular, Svelte and SvelteKit, Solid 1.9 and 2, SolidStart, and request-local Astro pages. Astro can hydrate React, Vue, Svelte and Solid 1.9 islands. Custom frontends can subscribe to `createXpSession`. [Frontend usage and SSR](experiments.md) · [Setup profiles](cli.md)

## Server frameworks and protocols

Hosts can mount `ResolveCohort` with standalone Fastify or NestJS on Express and Fastify. Native gRPC serves the versioned proto. A browser can use gRPC-Web through an Envoy bridge to the native server or a direct Node handler. SOAP 1.1 exposes a WSDL-driven operation on an authenticated HTTP route. Browser loader factories and React provider shortcuts support both browser protocols. [Host examples and protocol contracts](experiments.md#fastify) · [Reproduce the installed journeys](../README.md#reproduce-the-packed-browser-and-database-journeys)

## Operations and storage

A host can mount the operator page on its own authenticated route. It reads current membership counts and supports off-first creation, weighted launch and adjustment, pause, resume and final winner selection. Existing experiments keep their uniform assignment behavior. [Management guide](management.md)

Analytics connectors are tracked independently. Further ORM runtime adapters, generator/version profiles, migration execution, cross-database migration and external identity storage remain open.
