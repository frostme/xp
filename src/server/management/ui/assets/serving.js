import { actionLink, button, cell, detailUrl, heading, localName, text } from "./common.js";

const phases = {
  "awaiting-launch": "Awaiting launch",
  allocating: "Allocating",
  "winner-selected": "Winner selected",
};
export const phaseLabel = (r) =>
  phases[r.rolloutPhase] || (r.winner ? "Legacy uniform · Winner selected" : "Legacy uniform");
export const availability = (r) => (r.enabled ? "Enabled" : "Paused");
export function serving(r) {
  if (!r.enabled) return "Application default";
  if (r.winner)
    return (r.rolloutPhase || r.type === "flag") && r.winner === r.slug + "_off"
      ? "Application default"
      : r.winner;
  return r.rolloutPhase ? "Weighted assignment" : "Uniform assignment";
}
export function audience(r) {
  if (!r.enabled)
    return [
      "Application default. Their assignments stay in storage.",
      "Application default. Automatic decisions create no memberships.",
    ];
  if (r.winner) {
    const decision = serving(r);
    return [
      decision +
        (r.rolloutPhase === "awaiting-launch"
          ? ". The off control is pinned."
          : ". The winner overrides their assignment."),
      decision + ". Automatic decisions create no memberships.",
    ];
  }
  if (!r.rolloutPhase)
    return ["They keep their assigned cohort.", "Each cohort has an equal chance."];
  const full = r.cohorts.find((cohort) => cohort.percentage === 100);
  return [
    "They keep their assigned cohort.",
    (full ? "All join " + localName(r, full.slug) + "." : "Assigned using the split below.") +
      " Off serves the application default.",
  ];
}
export const lanes = ([existing, joining]) =>
  `<div class="outcomes"><div><h3>Existing members</h3><p>${text(existing)}</p></div><div><h3>New members</h3><p>${text(joining)}</p></div></div>`;
export function detailHtml(r) {
  const column = !r.rolloutPhase
    ? "Selection"
    : r.winner || !r.enabled
      ? "Saved split"
      : "New assignment share";
  const rows = r.cohorts
    .map((c) => {
      const share =
        c.percentage === null
          ? "Equal chance"
          : `<span class="band">${text(c.percentage)}%<progress aria-hidden="true" max="100" value="${text(c.percentage)}"></progress></span>`;
      return `<tr><th scope="row"><code>${text(localName(r, c.slug))}</code><small class="role">${c.type === "control" ? "Control" : "Treatment"}</small></th>${cell(column, share, "num")}${cell("Current memberships", text(c.memberships ?? "Unavailable"), "num")}</tr>`;
    })
    .join("");
  const actions = [];
  if (r.actions.includes("launch") || r.actions.includes("adjust"))
    actions.push(
      actionLink(
        r.actions.includes("launch") ? "Launch rollout" : "Adjust split",
        detailUrl(r.slug) + "/split",
        true,
      ),
    );
  if (r.actions.includes("pause")) actions.push(button("Pause serving", "pause"));
  if (r.actions.includes("resume")) actions.push(button("Resume serving", "resume"));
  if (r.actions.includes("finalize")) actions.push(button("Select winner", "finalize"));
  const state = `<div class="state"><span class="chip">${availability(r)}</span><span>${text(phaseLabel(r))}</span></div>`;
  const definitions = r.cohorts
    .map(
      (c) =>
        `<dt><code>${text(c.slug)}</code></dt><dd>${c.description ? text(c.description) + " " : ""}<code>${text(JSON.stringify(c.value))}</code></dd>`,
    )
    .join("");
  return (
    heading(r.name, r.slug, state) +
    `<section class="serving"><div class="rowtitle"><h2>Serving now</h2><span class="serving-summary">${text(serving(r))}</span></div>${lanes(audience(r))}</section>
<section class="members"><div class="rowtitle"><h2>Cohorts</h2><span class="small">Revision ${text(r.revision)}</span></div>
${r.countsReadAt ? "" : '<p class="alert" role="alert">Membership counts unavailable. ' + button("Retry counts", "counts") + "</p>"}
<table class="stacked"><thead><tr><th>Cohort</th><th class="num">${column}</th><th class="num">Current memberships</th></tr></thead><tbody>${rows}</tbody></table></section><div class="actions">${actions.join("")}</div>
<details class="definition"><summary>Experiment definition</summary><p>${text(r.type)}${r.description ? " · " + text(r.description) : ""}</p><dl>${definitions}</dl></details>`
  );
}
