# Product Design proposal

Open [the review prototype](index.html#checkout-copy/review) from this checkout, or serve the folder with a local HTTP server. The files also work offline. Every fresh load restores the synthetic fixtures. For the creation journey open [an empty directory](index.html?empty). Inspect the [desktop](desktop.png) and [mobile](mobile.png) captures directly in the review.

## Three image-based directions

Product Design’s context and ideation workflows used the [common brief](../../../docs/management-design/brief.md), its five product audits, and the [UX Pilot flow](../ux-pilot-flow.json). ImageGen produced each of the three concepts independently on November 21, 2026. The source images include speculative typography and copy. The prototype uses the shared fixture and serving contract.

| Direction                                                | Different operator task and tradeoff                                                                                                                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Serving brief](concepts/serving-brief.webp)             | Existing and new decisions lead the detail. Comfortable to read while answering a support request. A manager editing a split needs another view for the numerical comparison.                                                              |
| [Directory inspector](concepts/directory-inspector.webp) | A persistent list makes it quick to inspect neighboring experiments. The rail consumes space inside an embedded host. Some generated fixture descriptions needed correction.                                                               |
| [Split review](concepts/split-review.webp)               | Each cohort aligns its saved split, proposed split and current membership count. The operator can see who will keep their assignment and who will receive the proposed split before applying. A dedicated review adds one navigation step. |

The parent selected **Split review**. The working version keeps allocation review on a full page with addressable navigation. The tabular desktop layout becomes a labeled block per cohort at narrow widths. The proposed 0/100/0 survives Back to edit. A 100% off winner overrides decisions while the count table continues to describe the saved membership rows. This follows the two-audience review observed in [Statsig](../../../docs/management-design/audits/statsig.md) and the saved-to-live separation in [LaunchDarkly](../../../docs/management-design/audits/launchdarkly.md).

## Walkthrough

1. Open the empty directory, then **Create experiment**. Enter `checkout-copy` and put `short` and `detailed` on separate lines. Inspect the saved detail, including the zero membership count for each cohort.
2. Launch 90/5/5. Open **Adjust split**, enter 0/100/0 and choose **Review allocation**. **Back to edit** preserves the draft. **Apply allocation** returns to the saved detail.
3. Pause and resume. Choose **Select winner**, select off, and confirm. Open the directory and compare this winner with an awaiting-launch experiment on a fresh, populated page.
4. Inspect [viewer access](index.html?viewer#checkout-copy), [creation disabled](index.html?no-create), [unavailable counts](index.html?counts-error#checkout-copy), [a concurrent edit](index.html?save-error=stale#checkout-copy/review), or [a failed save](index.html?save-error=transient#checkout-copy/review). The one-shot failure fixtures let the operator recover with their split intact.

The prototype simulates revision changes, assignments and host access with in-memory fixtures. Production permission checks, atomic writes, paging and assignment verification belong to the implementation PRs. Adopt the saved/proposed comparison, plain-language confirmation and mobile row labels. For hosts with a smaller content area, reduce the heading and table padding while retaining both audience explanations. [Visual QA](design-qa.md)
