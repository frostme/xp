# Roadmap

## Database setup CLI

`xp setup` now generates reviewed migration, schema, collection/index, and DynamoDB
provisioning files. See the [CLI guide](cli.md) for the tested tool/provider matrix.
The CLI does not install dependencies or apply migrations/provision infrastructure.
Constructing a server or adaptor still does not perform setup.

Future work includes additional ORM/version profiles, deliberate schema upgrades,
optional migration execution, and ORM runtime clients. Cross-database data migrations,
arbitrary external identity-store integration, and weighted bucketing remain separate work.
