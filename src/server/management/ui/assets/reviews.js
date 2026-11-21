import {
  $,
  announce,
  apiDetail,
  button,
  cell,
  document,
  errorText,
  localName,
  request,
  text,
} from "./common.js";
import { audience, lanes } from "./serving.js";

export function review({ record, etag, type, allocation, trigger, saved, refreshed }) {
  const dialog = $("dialog");
  const panel = $("#review");
  const problem = $("#problem");
  const back = $("#back");
  const confirm = $("#commit");
  const comparing = type === "launch" || type === "adjust";
  const title = comparing
    ? "Review allocation"
    : type === "finalize"
      ? "Select winner"
      : type === "pause"
        ? "Pause serving"
        : "Resume serving";
  let label = comparing ? (type === "launch" ? "Launch rollout" : "Apply split") : title;
  let command = { type };
  let busy = false;
  let stale = false;
  let returnFocus = trigger || document.activeElement;
  let body;
  if (comparing) {
    command = { type, allocation };
    const shares = new Map(allocation.map((item) => [item.cohort, item.percentage]));
    const full = allocation.find((item) => item.percentage === 100);
    const rows = record.cohorts
      .map(
        (c) =>
          `<tr><th scope="row"><code>${text(localName(record, c.slug))}</code></th>${cell("Saved split", text(c.percentage) + "%", "num")}${cell("Proposed split", text(shares.get(c.slug)) + "%", "num")}${cell("Current memberships", text(c.memberships ?? "Unavailable"), "num")}</tr>`,
      )
      .join("");
    body =
      lanes([
        "They keep their assigned cohort.",
        full
          ? "All join " + localName(record, full.cohort) + "."
          : "Assigned using the proposed split.",
      ]) +
      '<table class="stacked review-table"><thead><tr><th>Cohort</th><th class="num">Saved split</th><th class="num">Proposed split</th><th class="num">Current memberships</th></tr></thead><tbody>' +
      rows +
      '</tbody></table><p class="note">Current memberships stay in storage.</p>';
  } else if (type === "finalize") {
    body =
      '<label class="field">Winning cohort<select id="winner">' +
      record.cohorts
        .map((c) => `<option value="${text(c.slug)}">${text(c.slug)}</option>`)
        .join("") +
      '</select></label><div id="effect"></div><p class="note">Current memberships stay in storage.</p>';
  } else {
    body =
      lanes(audience({ ...record, enabled: type === "resume" })) +
      '<p class="note">The saved phase, split and current memberships are retained.</p>';
  }
  panel.innerHTML = `<h2 id="review-title" tabindex="-1" autofocus>${title}</h2><code>${text(record.slug)} · Revision ${text(record.revision)}</code>${body}`;
  problem.replaceChildren();
  const winner = $("#winner", panel);
  if (winner) {
    function selectWinner() {
      command = { type: "finalize", cohort: winner.value };
      label = "Select " + localName(record, winner.value) + " as winner";
      confirm.textContent = label;
      $("#effect").innerHTML = lanes(
        audience({
          ...record,
          winner: winner.value,
          rolloutPhase: record.rolloutPhase ? "winner-selected" : undefined,
        }),
      );
    }
    winner.onchange = selectWinner;
    selectWinner();
  }
  function pending(value) {
    busy = value;
    back.disabled = value;
    confirm.disabled = value || stale;
    confirm.textContent = value ? "Saving…" : label;
    if (winner) winner.disabled = value || stale;
  }
  pending(false);
  dialog.oncancel = (event) => {
    if (busy) event.preventDefault();
  };
  dialog.onclose = () => {
    if (returnFocus?.isConnected) returnFocus.focus();
  };
  confirm.onclick = async () => {
    if (busy || stale) return;
    pending(true);
    problem.replaceChildren();
    try {
      await request(apiDetail(record.slug) + "/commands", { body: command, etag });
    } catch (error) {
      stale = error.status === 409 || error.status === 428;
      pending(false);
      if (stale) {
        problem.innerHTML =
          "The saved definition changed. " + button("Review current values", "refresh");
        const refresh = $("button", problem);
        refresh.focus();
        refresh.onclick = async () => {
          refresh.disabled = true;
          back.disabled = true;
          busy = true;
          try {
            const latest = await request(apiDetail(record.slug));
            returnFocus = null;
            dialog.close();
            refreshed(latest);
          } catch (readError) {
            problem.firstChild.textContent = errorText(readError) + " ";
          } finally {
            busy = false;
            back.disabled = false;
            refresh.disabled = false;
            if (dialog.open) refresh.focus();
          }
        };
      } else {
        problem.textContent =
          (error.fields?.map((item) => item.message || item).join(" ") || errorText(error)) +
          " Your proposal is still here.";
        confirm.focus();
      }
      return;
    }
    returnFocus = null;
    dialog.close();
    announce("Changes saved.");
    await saved();
  };
  dialog.showModal();
  $("#review-title").focus({ preventScroll: true });
  dialog.scrollTop = 0;
}
