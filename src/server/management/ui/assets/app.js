import {
  $,
  announce,
  apiDetail,
  base,
  button,
  detailUrl,
  directoryUrl,
  errorText,
  focusHeading,
  heading,
  history,
  location,
  main,
  request,
  text,
} from "./common.js";
import { directory } from "./directory.js";
import { createForm, splitForm } from "./editors.js";
import { review } from "./reviews.js";
import { detailHtml } from "./serving.js";

function readFailure(error, retry) {
  const missing = error.status === 404;
  main.onclick = null;
  const title = missing
    ? "Experiment unavailable"
    : error.status === 403
      ? "Access denied"
      : "Could not load experiments";
  main.innerHTML =
    heading(title) +
    '<p class="alert" role="alert">' +
    text(errorText(error)) +
    '</p><div class="actions">' +
    (missing || error.status === 403 ? "" : button("Retry", "retry")) +
    '<a href="' +
    text(directoryUrl) +
    '">Back to directory</a></div>';
  const retryButton = $("button", main);
  if (retryButton) retryButton.onclick = retry;
  focusHeading();
}

function renderDefinition(result, editing, draft, notice, blocked = "") {
  const { data: record, etag } = result;
  $("#crumb").textContent = " / " + record.slug;
  main.onclick = null;
  const freshDetail = async (successText) => {
    if (editing) history.replaceState(null, "", detailUrl(record.slug));
    await loadDefinition(record.slug, false, successText);
  };
  function showReview(type, allocation, proposal, trigger) {
    review({
      record,
      etag,
      type,
      allocation,
      trigger,
      saved: () => freshDetail("Changes saved."),
      refreshed: (latest) => {
        const changedId = latest.data.id !== record.id;
        const unavailable = changedId
          ? "This slug now belongs to another experiment. Open its detail to start a new change."
          : editing &&
              !latest.data.actions.some((action) => action === "launch" || action === "adjust")
            ? "This change is unavailable in the current state."
            : "";
        renderDefinition(
          latest,
          editing,
          proposal,
          "Revision " +
            latest.data.revision +
            " loaded. Review the current state and your proposal.",
          unavailable,
        );
      },
    });
  }
  if (
    editing &&
    (draft || record.actions.includes("launch") || record.actions.includes("adjust"))
  ) {
    splitForm(record, draft, showReview, blocked);
  } else {
    if (editing) history.replaceState(null, "", detailUrl(record.slug));
    main.innerHTML = detailHtml(record);
    main.onclick = async (event) => {
      const trigger = event.target.closest("button");
      if (!trigger) return;
      const command = trigger.dataset.command;
      if (command === "counts") {
        trigger.disabled = true;
        await freshDetail("Membership counts refreshed.");
        return;
      }
      if (record.actions.includes(command)) showReview(command, undefined, undefined, trigger);
    };
  }
  announce(notice || "");
  if (notice) focusHeading();
}
async function loadDefinition(slug, editing, notice) {
  try {
    const result = await request(apiDetail(slug));
    renderDefinition(
      result,
      editing,
      undefined,
      notice === "Membership counts refreshed." && !result.data.countsReadAt
        ? "Membership counts remain unavailable."
        : notice,
    );
  } catch (error) {
    readFailure(error, () => loadDefinition(slug, editing, notice));
  }
}

async function start() {
  let capabilities;
  try {
    capabilities = (await request("/api/capabilities")).data;
  } catch (error) {
    readFailure(error, start);
    return;
  }
  $("#access").textContent = capabilities.access === "manage" ? "Manage access" : "View only";
  const path = location.pathname.slice(base.length).replace(/\/$/, "");
  if (!path) {
    directory(capabilities.allowCreate);
    return;
  }
  if (path === "/create") {
    if (!capabilities.allowCreate) {
      main.innerHTML =
        heading("Creation unavailable") +
        '<p>This installation requires creation to be enabled and a manager account.</p><a href="' +
        text(directoryUrl) +
        '">Back to directory</a>';
    } else {
      createForm(async (slug) => {
        history.replaceState(null, "", detailUrl(slug));
        await loadDefinition(slug, false, "Experiment created.");
      });
    }
    return;
  }
  const [, , slug, editor] = path.split("/");
  await loadDefinition(slug, editor === "split");
}
void start();
