# Experiment management review

Open the [merged prototype](reference/index.html) from a local checkout. It uses an in-memory fixture and works offline. The [reference guide](reference/README.md) includes desktop and mobile renders, input and error examples, and the walkthrough from pinned off to final winner. The [decision record](../../docs/management-design/decision.md) scores each proposal and identifies which elements the production page should carry forward.

- [Five independent product audits and cross-product matrix](../../docs/management-design/research.md)
- [Shared brief, fixture data and actions by state](../../docs/management-design/brief.md)
- [Initial connected wireframes](wireframe.html) and [UX Pilot workflow](ux-pilot/README.md)
- [Better Design](better-design/README.md), [Design](design/README.md) and [Product Design](product-design/README.md)
- [MagicPath](magicpath/README.md) and [Figma](figma/README.md)

The proposals and review assets live outside the package file list. Each report identifies its evidence source. The PR's Markdown images provide a comparison without requiring access to private design accounts.

## Implementation and verification

| Review order                                                    | Change                                                                     | Evidence                                                                                                      |
| --------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [1. Research and design](https://github.com/frostme/xp/pull/43) | Five product audits, design proposals and the selected operator workflow   | [Decision and scores](../../docs/management-design/decision.md)                                               |
| [2. Managed definitions](https://github.com/frostme/xp/pull/46) | Off-first atomic create, startup config and additive storage upgrades      | [Host migration notes](../../docs/cli.md#upgrading-existing-storage)                                             |
| [3. Weighted serving](https://github.com/frostme/xp/pull/48)    | Sticky decisions, revision fencing and lifecycle transitions               | [Serving contract](../../docs/experiments.md#serving-and-changing-a-managed-rollout)                          |
| [4. Host API](https://github.com/frostme/xp/pull/49)            | Host access, conditional writes, directory and fresh membership counts     | [Mounting and request contract](../../docs/management.md)                                                     |
| [5. Packaged interface](https://github.com/frostme/xp/pull/50)  | Directory, detail, creation, allocation and confirmations                  | [Reference and production comparison](production/README.md)                                                   |
| Installed journeys and release review                           | Isolated package, generated PostgreSQL storage, Chromium and host restarts | [Installed journey](acceptance/README.md) · [Analytics coexistence replay](analytics-compatibility/README.md) |

The final PR description records all six submitted commit IDs and corresponding CI runs. The PostgreSQL, MySQL, SQL Server, MongoDB and DynamoDB jobs run the shared contracts, including Sequelize on the three SQL providers. The cross-feature replay records the two branches and six local integrations tested together. The management branches build independently of the analytics work.
