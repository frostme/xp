# @frostme/xp - AI Agent Documentation

## Project Overview

**xp** is an experiment framework node module written in TypeScript. It allows another node app to
load in, monitor, integrate, and iterate on experiments with little to no adjustments to their existing configuration
and infrastructure.

- **Repository**: frostme/xp
- **Default Branch**: main
- **License**: MIT
- **Maintainer**: Elliot Frost (frostme)
- **Version**: 0.1.0

## Tech Stack

- **Node.js**: 24+
- **TypeScript**: 7+
- **Package Manager**: bun
- **Builder**: swc
- **Testing**: vitest
- **Linting**: oxlint
- **Formatting**: oxfmt
- **Unused Code**: knip
- **Dependency Detection**: dpdm
- **Cache**: wireit

## Project Structure

### Architecture Principles

xp utilizes clean architecture principles to separate concerns and allow for easy integration with other node applications. The framework is designed to be modular, allowing developers to easily swap out components and adaptors as needed.

How xp defines its architecture:

- **Entities**: Core business logic and domain models that are independent of any framework or external dependencies.
- **Use Cases**: Application-specific business rules that orchestrate the flow of data between entities
- **Interfaces**: Abstractions that define the contracts for the adaptors and integrations, allowing for flexibility and decoupling.
- **Adaptors**: Implementations of the interfaces that connect the xp framework to external systems, such as databases, client frameworks, and server frameworks.
- **Config**: Initialization of integration adaptors and their configurations, allowing for easy setup and customization of the xp framework.
- **Frameworks**: Supported integration types (server, client, cli) that provide the necessary infrastructure for running experiments in different environments.

### Core Directories

```
$HOME/code/xp/src/
├── adaptors                     # Supported integration adaptor definitions
│   ├── bucketers                # experiment cohort bucketing adaptors
│   ├── data-access              # database integrations used for cli/server frameworks
│   ├── frameworks               # frontend integrations use for client frameworks
│   └── validation               # schema validation adaptors
├── cli                          # CLI framework integrations
├── client                       # Client framework integrations
├── config                       # adaptor definitions for supported integrations
├── entities                     # xp framework domain model entities
├── errors                       # custom error classes
├── framework                    # supported integration types (server, client, cli)
├── interfaces                   # TypeScript interfaces used throughout the xp module
├── server                       # Server framework integrations
├── types                        # Global and Module augmentation types
└── use-cases                    # xp experiment framework use cases and business logic
```

## Developmet Workflow

### Initial Setup

```bash
# Clone repository
git clone git@github.com:frostme/xp.git
cd xp

# Install dependencies
bun install

# Run tests to ensure everything is working
bun run test:unit
bun run test:integration
```

### Building

xp is built using swc. The build process transpiles TypeScript code into JavaScript, generating output in the `dist` directory. The build command can be run using the following command:

```bash
bun run build
```

### Tests

We utilize vitest for testing our codebase. We have two types of tests: unit tests and integration tests. Both unit and integration tests are located within subdirectories insides `__tests__` directories. Unit tests are defined as `**/__tests__/*-unit.ts` and integration tests are defined as `**/__tests__/*-integration.ts`. Vitest is configured at `vitest.unit.config.ts` and `vitest.integration.config.ts` for unit and integration tests respectively.

The unit and integration tests can be run using the following commands:

```bash
bun run test:unit
bun run test:integration
```

### Styles/Conventions

Code styles and conventions are enforced using oxfmt and oxlint. We have a pre-commit hook that runs oxfmt and oxlint on staged files to ensure that code adheres to our style guidelines before being committed. Unused code is detected using knip and circular dependency detection is performed using dpdm.

The formatting, lint, unused code, and dependency detection commands can be run using the following commands:

```bash
bun run format:check
bun run lint
bun run lint:unused
bun run circular:check
```

### CI/CD

Our CI pipeline is configured to run on every push and pull request to the main branch. The pipeline includes steps for linting, testing, and building the project. We use GitHub Actions for our CI/CD workflows.

Our CD pipeline is configured to automatically publishing utilizing [`semantic-release`](https://semantic-release.org/).
