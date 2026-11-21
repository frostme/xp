# Installed management journey

Chromium completed the lifecycle against PostgreSQL 16 through an Express 5 host at `/internal/experiments`. The runner installed the workspace tarball into a temporary consumer, ran its installed `xp setup` command, and applied the generated SQL in a disposable schema. The consumer loaded the page, JavaScript, stylesheet and management handler from that package. Analytics was absent.

| Action                          | Observed result                                                                                                                                                                                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start with creation disabled    | The legacy and managed seeds were created. Anonymous access and a manager’s direct create request returned 403. The manager launched the managed seed in the page.                                                                                                                       |
| Restart with creation enabled   | The startup report skipped both existing seeds. The manager created `checkout-copy` with two treatments. A viewer saw its detail and received 403 on direct create and lifecycle requests.                                                                                               |
| Visit before launch             | Pinned off returned the application default. PostgreSQL contained zero memberships for `checkout-copy`.                                                                                                                                                                                  |
| Launch at 50% off and 50% short | Deterministic draws either side of the boundary assigned Alice to off and Bob to short. Both assignments survived repeat visits. The detail displayed `1`, `1` and `0` current memberships for off, short and detailed.                                                                  |
| Adjust to 100% detailed         | A simulated HTTP 503 retained the proposed percentages. A competing operator then saved a different split. The page received a real 409, fetched that revision, and retained the draft for a second review. Alice and Bob kept their original cohorts and a new shopper joined detailed. |
| Pause, resume and select off    | Bob received the default while paused, short after resume, and the default after finalization. All three assignment rows remained.                                                                                                                                                       |
| Restart with saved state        | The off winner and all stored memberships survived. An explicit join, leave and rejoin changed totals from three to four, back to three, and then to four. The legacy multivariate experiment continued to serve its own off slug.                                                       |

## Browser evidence

| Viewport | Allocating detail                    | Allocation review               |
| -------- | ------------------------------------ | ------------------------------- |
| 375 px   | [Detail](allocating-detail-375.png)  | [Review](review-split-375.png)  |
| 768 px   | [Detail](allocating-detail-768.png)  | [Review](review-split-768.png)  |
| 1024 px  | [Detail](allocating-detail-1024.png) | [Review](review-split-1024.png) |
| 1440 px  | [Detail](allocating-detail-1440.png) | [Review](review-split-1440.png) |

The desktop detail keeps serving behavior above the cohort table, with saved shares and current counts aligned by row. The mobile dialog stacks the existing-member and new-member effects, then labels each saved split, proposal and count within its cohort. Escape restores focus to Review split. Enter reopens the dialog and moves focus to its heading. All four widths fit without horizontal page scrolling. [Directory screenshot](directory-desktop.png) · [Design reference](../reference/README.md)

## Reproduce

From the repository root, use a disposable PostgreSQL database that allows schema creation. The repository’s PostgreSQL test service supplies the runner’s default connection on port 5433. `POSTGRES_URL` or standard PostgreSQL environment variables select another database.

```sh
bun install --frozen-lockfile
bun run build
bunx --no-install playwright install chromium
docker compose -f docker-compose.test.yml up -d --wait postgres
XP_MANAGEMENT_EVIDENCE=review/experiment-management/acceptance node scripts/test-management-journey.mjs
```

The evidence variable enables screenshot capture. The test removes its temporary consumer and database schema on completion. [Installed runner](../../../scripts/test-management-journey.mjs) · [Journey assertions](../../../scripts/fixtures/management-journey/journey.test.mjs)
