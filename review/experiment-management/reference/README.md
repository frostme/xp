# Experiment management reference

Open [the directory](index.html) in a browser. The HTML, stylesheet and script work directly from a checkout. Each tab starts with synthetic records and keeps its own changes until reload.

## Operator journeys

| Start                                                                                                                                           | Walkthrough                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Empty installation](index.html?empty)                                                                                                          | Create `checkout-copy` with treatments `short, detailed`. The saved detail shows Enabled, Awaiting launch, off at 100% and zero memberships in all three cohorts. Launch at 90/5/5 and review the consequence before confirming.                  |
| [Checkout copy](index.html#checkout-copy)                                                                                                       | Open Adjust split and enter 0/100/0. Review compares the saved and proposed share beside each cohort's count. All new members will join short. Back restores focus and keeps the proposal. Apply and inspect the same 84/11/5 stored memberships. |
| [Allocating experiment](index.html#checkout-copy)                                                                                               | Pause serving, confirm the effects for both groups, then resume. Select off as winner. The detail now shows Winner selected, application default for both groups and the retained counts.                                                         |
| [Legacy uniform](index.html#existing-banner) · [Paused](index.html#address-hint) · [Winner off](index.html#cart-recap)                          | Inspect current serving, saved definition and available commands. The legacy selector gives each cohort an equal chance. Finalized off and pinned off remain distinct phases.                                                                     |
| [View access](index.html?access=view#checkout-copy) · [Creation disabled](index.html?disable-create#!create) · [Denied](index.html?access=deny) | Check permissions, including a direct link to a disabled create screen.                                                                                                                                                                           |
| [Unavailable counts](index.html?error=counts#delivery-promise) · [Missing record](index.html#missing)                                           | Retry the count read, inspect the long qualified experiment context, or go back to the directory.                                                                                                                                                 |
| [Stale revision](index.html?error=stale#checkout-copy/split) · [Failed save](index.html?error=save#checkout-copy/split)                         | Propose 0/100/0. The stale fixture changes the stored split to 80/10/10. Review current values, compare against the preserved proposal and confirm again. The failed-save fixture retains the proposal for a retry.                               |

## Components and design decisions

- The full-width searchable directory uses the UX Pilot flow. Name and slug identify a record. Availability, saved phase and serving behavior have separate columns. On a narrow screen, labels travel with each experiment.
- The Design proposal supplies the serif titles, ruled surfaces, and adjacent state and availability. MagicPath supplies the prominent serving summary and small allocation bars. The detail fits within a host's content area with a single breadcrumb.
- Better Design and Figma distinguish existing and new members in paired descriptions. The selected phase or winner supplies the words. When one cohort receives every future join, the review names it.
- The Product Design comparison places saved split, proposed split and stored membership count on the same row. Its narrow-screen treatment retains the labels inside each cohort group. A native dialog starts at its heading so the change and its consequences are visible even on a short screen. Back or Escape returns focus to the initiating control.
- The shared [state and permission table](../../../docs/management-design/brief.md) determines which commands appear. A successful command returns to the saved detail. A failed count read marks every count unavailable.

| Token                    | Value and application                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| Canvas / foreground      | `#fffefa` and `#202522` for the operator workspace                                           |
| Secondary text / divider | `#52594f` and `#c4c7b5` for context and row separation                                       |
| Serving panel / action   | `#f1f2e7` and `#26523c` for current behavior and primary commands                            |
| Focus / error            | `#234fa6` focus outline and `#8d261d` error text, with an explicit message                   |
| Typography               | Local Georgia titles, system sans-serif controls and system monospace identifiers            |
| Spacing                  | 1rem mobile gutter, 2rem desktop gutter, 74rem maximum workspace, 44px minimum button height |

## Screens

[Directory on desktop](directory-desktop.png) · [Detail on desktop](detail-desktop.png) · [Detail on mobile](detail-mobile.png) · [Review on desktop](review-desktop.png) · [Review on mobile](review-mobile.png)
