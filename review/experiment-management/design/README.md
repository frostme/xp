# Decision sheet

Open the [running experiment](index.html#checkout-copy) or [directory](index.html) from a local checkout. All data belongs to the current page. Reload to restore the [common fixtures](../../../docs/management-design/brief.md).

This independently authored prototype applies the Design plugin's visual-design and accessibility skills, using their web guides and rules for typography, focus, forms and reflow. The starting references were the [initial wireframe](../wireframe.html), [UX Pilot interaction map](../ux-pilot-flow.json) and five operator audits. Its two audience summaries come from Statsig's comparison of ending decisions. xp's membership contract determines the answers.

## Workflow

- Search by name or slug, then open a record. The phase sits beside the experiment title. The **Serving now** section explains the outcome for each population. Counts and future assignment shares have their own table.
- In the [empty installation](index.html?empty), create `checkout-copy` with `short, detailed`. The saved record opens with 100% off and zero memberships. Launch at 90/5/5 and adjust to 0/100/0. The review identifies the saved and proposed shares and who will receive short.
- Pause, resume and select off as the winner. Each dialog names the consequence for both populations. Cancelling restores the opener's focus. A final off winner remains distinguishable from an awaiting-launch pin.
- Compare [view access](index.html?access=view#checkout-copy), [creation disabled](index.html?disable-create), [unavailable counts](index.html?error=counts#checkout-copy), [a failed save](index.html?error=save#checkout-copy/split) and [a stale revision](index.html?error=stale#checkout-copy/split). The stale case changes the saved distribution to 80/10/10. Reviewing the current version updates the saved column and keeps the draft.

## Visual review

In the [first desktop render](before-desktop.png), the saved phase sat across the width of the workspace from the title. Scanning the name and phase required looking back and forth. The final [desktop render](desktop.png) groups them in one heading. The original column label “New joins” made a percentage easy to mistake for a count. The final heading specifies “New assignment share.”

The [375 px detail](mobile.png) places the new-member outcome beneath the existing-member outcome, preserving reading order. The [mobile review](review.png) shows the saved and proposed split after a failed save. Native controls retain their values, a text alert explains recovery and the confirmation button remains reachable.

Design tokens use paper `#fffefa`, ink `#202522`, muted text `#52594f`, action green `#26523c` and focus blue `#234fa6`. Headlines use a local serif, body text uses system UI and identifiers use monospace. Text contrast against paper measured 15.42:1 for primary text and 7.17:1 for muted text. White text on the primary button measured 8.92:1.

Chromium checks exercised creation through finalizing off, keyboard dismissal and focus return, stale review, preserved values after failed save, count recovery and viewer permissions. Reflow checks at 375, 768, 1024 and 1440 px found no horizontal overflow on Checkout copy. The long-slug fixture also fit at 375 px. Screen-reader speech remains unverified.

Adopt the side-by-side descriptions for existing and new members, then stack them in the same order on mobile. The tabular counts remain easier to scan with short cohort labels. The separate action column leaves ample keyboard targets on desktop, but places lifecycle actions below the table on a phone with many cohorts.
