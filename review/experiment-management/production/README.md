# Production interface review

The screenshots use the compiled management mount in Chromium. The checkout-copy fixture starts enabled and allocating with 84 off memberships, five detailed and eleven short. Its operator proposes 80% off, 15% detailed and 5% short. The heavier installed-PostgreSQL journey uses fresh data.

| View           | Reference                                   | Compiled page              |
| -------------- | ------------------------------------------- | -------------------------- |
| Desktop detail | [Approved](../reference/detail-desktop.png) | [1440 px](detail-1440.png) |
| Mobile detail  | [Approved](../reference/detail-mobile.png)  | [375 px](detail-375.png)   |
| Desktop review | [Approved](../reference/review-desktop.png) | [1440 px](review-1440.png) |
| Mobile review  | [Approved](../reference/review-mobile.png)  | [375 px](review-375.png)   |

The desktop detail keeps the availability and phase beside the title, followed by the two serving explanations, cohort counts and actions. Production orders treatments by slug after off and adds an expandable definition. On mobile, the review stacks saved share, proposed share and current count under each cohort. Long confirmations scroll inside the dialog. Both sizes retain the visible focus outline for keyboard navigation.

Run `bun run build`, `bunx playwright install chromium` and `bun run test:management-ui`. Set `XP_MANAGEMENT_UI_EVIDENCE` to an output directory to regenerate the four captures. The check opens direct links at 375, 768, 1024 and 1440 px with reduced motion. It opens and dismisses confirmation by keyboard, verifies the focus return, refreshes a stale edit without losing its percentages, and checks read-only, forbidden, missing and failed-count states. A sparse first page exercises directory continuation.

Measured production contrast ratios are 15.42∶1 for body text on the page, 6.41∶1 for secondary text on the serving panel, 8.92∶1 for the primary button label and 8.57∶1 for error text. The keyboard focus outline is 7.59∶1 against the page. Availability and phase have text labels, and each percentage is printed beside its bar.
