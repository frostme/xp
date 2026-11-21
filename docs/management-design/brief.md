# Operator brief

The operator opens the host's experiment directory at `/internal/experiments`. The host owns identity, permissions, and storage. In a support call the first question is what a visitor receives now. The second is how many members are stored in each cohort. A manager then needs to know whose experience will change when they commit a new split, pause, or choose a winner.

## Common fixtures

All proposals use the same synthetic store. Use the display name and durable slug to identify a record. Show phase and availability separately. Each cell under memberships counts current stored assignments in the same order as the split.

| Slug             | Availability and phase    | Serving now                      | Cohorts and future split                             | Memberships |
| ---------------- | ------------------------- | -------------------------------- | ---------------------------------------------------- | ----------- |
| existing-banner  | Enabled · Legacy uniform  | Sticky, else uniform             | control / short, equal chance                        | 14 / 21     |
| delivery-promise | Enabled · Awaiting launch | Application default (pinned off) | off / next-day-delivery-with-order-tracking, 100 / 0 | 0 / 0       |
| checkout-copy    | Enabled · Allocating      | Sticky, else weighted            | off / short / detailed, 90 / 5 / 5                   | 84 / 11 / 5 |
| address-hint     | Paused · Allocating       | Application default              | saved off / compact, 75 / 25                         | 23 / 7      |
| cart-recap       | Enabled · Winner selected | Application default (winner off) | off / compact, saved 50 / 50                         | 36 / 28     |

For a creation walkthrough start with an empty installation and create Checkout copy (`checkout-copy`, treatments `short` and `detailed`). xp inserts one real off control at 100%, pins it and gives it zero automatic memberships. Launch 90/5/5, then move to 0/100/0. A previous member stays in their cohort. Pause serves default to everyone, resume restores the saved state, and selecting off overrides returning members while leaving each count intact.

## Screens and actions

| View             | Data and actions                                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Directory        | Search by name or slug, open a detail, paginate, handle an empty store or empty search. A manager sees Create when enabled by host config. A viewer can read.                                                             |
| Detail           | Back to directory, availability, phase, serving behavior, all cohorts and counts, and the applicable action below. A failed count read says unavailable with a retry. A missing experiment offers a way to the directory. |
| Create           | Enter slug and treatments. Explain the off control. Commit creates and opens the persisted detail. Duplicate and invalid names stay visible at their fields.                                                              |
| Launch or adjust | Review every cohort, saved and proposed percentages, and running total. Show new and existing members' outcomes. Accept up to two decimal places. Validate a complete 100% split.                                         |
| Confirm          | Identify experiment and proposed action. Describe effect for existing members, future decisions and stored counts. Restore keyboard focus on cancel. Return to refreshed detail on success.                               |
| Recovery         | A failed save preserves edits. A stale revision offers to read the committed version and compare before resubmitting. Errors are announced and labeled in text.                                                           |

| State                    | Manager actions                       | Viewer  |
| ------------------------ | ------------------------------------- | ------- |
| Awaiting launch, enabled | Launch, pause                         | Inspect |
| Allocating, enabled      | Adjust split, select winner, pause    | Inspect |
| Winner selected, enabled | Pause                                 | Inspect |
| Paused, any phase        | Resume                                | Inspect |
| Legacy uniform, enabled  | Pause, select winner where applicable | Inspect |

Design desktop and mobile from the same data. Wrap long identifiers, keep tab order and focus visible, label buttons by their consequences and make counts readable without color. Exercise 375, 768, 1024 and 1440 px. The UI runs under a nested host mount and loads its assets locally.
