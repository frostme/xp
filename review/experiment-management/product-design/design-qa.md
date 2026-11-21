# Product Design visual QA

**Final result**: passed

The [selected concept](concepts/split-review.webp) and [desktop implementation](desktop.png) show the same checkout-copy allocation review. The original ImageGen output was 1487 × 1058. Its review copy is 1200 × 854. The browser capture uses a 1440 × 1024 CSS-pixel viewport at 1×. Both were scaled proportionally to 600 pixels wide and inspected side by side. The comparison includes the whole screen, both action buttons, the 90/5/5 to 0/100/0 edit, and the membership column with 84/11/5. Table labels and both audience explanations remain legible. The prototype presents visible keyboard focus on the focused control. Its two breadcrumb items remain working links.

The [375-pixel capture](mobile.png) shows the same proposed change with repeated field labels under each cohort. The narrow layout uses vertical space to keep saved split, proposed split and stored count together. On 375, 768, 1024 and 1440 pixel viewports the review had no horizontal overflow.

The in-app browser exercised Back to edit, reviewed the preserved percentages and committed the change. Browser checks also covered empty creation, launch, pause/resume, selection of off, count retry, a viewer, and both failed-save paths. The stale response now disables Apply until the operator reviews the updated split. The browser run completed without page errors. No image assets appear in this interface beyond its review evidence. The working view uses system fonts for an offline host.
