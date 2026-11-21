# Assignment capture with managed rollouts

The disposable checkout combines the management API at `2e0f08370e3065a7ff544908adc53d6697352234` and the analytics journey at `7af23610dea44ae689afd6691ea9e14cb1ecd9bd`. Both include the serving and storage implementations from their earlier PRs.

The test provisions each database through xp’s fixtures and drives public runtime calls with synthetic identities. Before installing the analytics schema, a deterministic draw at 99.99% off puts a user in the remaining 0.01% treatment. The management detail reports one stored membership. The fixture then installs the analytics extension and opens a second runtime with a custom test destination.

| Operation on the second experiment                               | Public decision        | Stored result                                      |
| ---------------------------------------------------------------- | ---------------------- | -------------------------------------------------- |
| Read the initial off winner                                      | Application default    | Zero automatic joins and zero pending deliveries   |
| Explicitly join short while off is pinned                        | Application default    | One short membership and one manual event          |
| Make and repeat a weighted off decision                          | Application default    | One off membership and one automatic event         |
| Change the weights while identity mapping holds an off candidate | Short after resampling | One short membership and one automatic short event |
| Finalize off while identity mapping holds a short candidate      | Application default    | Zero memberships and zero events for this user     |

The sink claims three distinct event IDs. Current memberships stay at one off, two short and zero long before and after the claim. Each storage write receives staged deliveries as its fourth argument and the sampled rollout revision as its fifth. Server composition supplies the optional capture and random source to the combined decision path.

## Reproduce

Run the script from an xp checkout that has fetched both commits. It prepares a temporary worktree, reapplies the checked-in conflict resolutions and test, verifies the resulting Git tree, installs dependencies, checks TypeScript and runs the selected provider fixtures. The script cleans up its temporary worktree. Git 2.53.0, Bun 1.4.4 and Node 26.12.0 were used for the recorded run.

```sh
docker compose -f docker-compose.test.yml up -d --wait postgres mysql mongodb dynamodb
bash review/experiment-management/analytics-compatibility/reproduce.sh postgres mysql mongodb dynamodb
```

The PostgreSQL and MySQL jobs each exercise native and Sequelize 6 adaptors. MongoDB uses a replica set. DynamoDB uses DynamoDB Local with the optional analytics index. The same script accepts `mssql` on a host running SQL Server. The recorded combined run covered the six integrations above on ARM64.

[Management PR](https://github.com/frostme/xp/pull/49) · [Analytics PR](https://github.com/frostme/xp/pull/47)
