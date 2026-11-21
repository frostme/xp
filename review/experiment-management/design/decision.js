const { document, location, window, URLSearchParams } = globalThis;
const $ = (selector) => document.querySelector(selector);
const safe = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const title = (slug) => slug[0].toUpperCase() + slug.slice(1).replaceAll("-", " ");
const config = new URLSearchParams(location.search);
const manager = config.get("access") !== "view";
const createAllowed = manager && !config.has("disable-create");
const phases = {
  legacy: "Legacy uniform",
  ready: "Awaiting launch",
  active: "Allocating",
  final: "Winner selected",
};
function record(slug, phase, cohorts, weights, counts, enabled = true, winner = null) {
  return { slug, phase, cohorts, weights, counts, enabled, winner, revision: 1 };
}
const records = config.has("empty")
  ? []
  : [
      record("existing-banner", "legacy", ["control", "short"], [50, 50], [14, 21]),
      record(
        "delivery-promise",
        "ready",
        ["off", "next-day-delivery-with-order-tracking"],
        [100, 0],
        [0, 0],
        true,
        "off",
      ),
      record("checkout-copy", "active", ["off", "short", "detailed"], [90, 5, 5], [84, 11, 5]),
      record("address-hint", "active", ["off", "compact"], [75, 25], [23, 7], false),
      record("cart-recap", "final", ["off", "compact"], [50, 50], [36, 28], true, "off"),
    ];
const main = $("#content"),
  dialog = $("dialog");
let query = "",
  page = 0,
  fault = config.get("error"),
  returnFocus,
  saveReview;
const state = (r) => (r.enabled ? "Enabled" : "Paused") + " · " + phases[r.phase];
const qualified = (r, c) => safe(r.slug + "_" + c);
const button = (label, command, primary = false) =>
  '<button type="button" data-do="' +
  command +
  '"' +
  (primary ? ' class="primary"' : "") +
  ">" +
  label +
  "</button>";
function audience(r) {
  if (!r.enabled)
    return [
      "Application default. Serving is paused.",
      "Application default. Automatic decisions create no membership.",
    ];
  if (r.winner) {
    const target = r.winner === "off" && r.phase !== "legacy" ? "Application default" : r.winner;
    return [
      target +
        (r.phase === "ready"
          ? ". The off control is pinned."
          : ". The selected winner overrides stored cohorts."),
      target + ". Automatic decisions create no membership.",
    ];
  }
  return [
    "They keep their assigned cohort.",
    r.phase === "legacy"
      ? "Any cohort, with equal chance."
      : "A cohort drawn from the split below. Off serves the application default.",
  ];
}
const outcomes = (answers) =>
  '<div class="outcomes"><div><h3>Existing members</h3><p>' +
  safe(answers[0]) +
  "</p></div><div><h3>New members</h3><p>" +
  safe(answers[1]) +
  "</p></div></div>";
function heading(label, slug = "", extra = "") {
  return (
    '<header class="meta"><div><h1 tabindex="-1">' +
    safe(label) +
    "</h1>" +
    (slug ? "<code>" + safe(slug) + "</code>" : "") +
    "</div>" +
    extra +
    "</header>"
  );
}
function directory() {
  main.innerHTML =
    heading("Experiments", "", createAllowed ? button("Create experiment", "create", true) : "") +
    '<label class="field">Find an experiment<input type="search" id="search" placeholder="Name or slug"></label><div id="results"></div>';
  function list() {
    const hits = records.filter(
      (r) =>
        (r.slug + " " + title(r.slug)).includes(query.toLowerCase()) ||
        title(r.slug).toLowerCase().includes(query.toLowerCase()),
    );
    $("#results").innerHTML =
      hits
        .slice(page * 4, (page + 1) * 4)
        .map(
          (r) =>
            '<div class="entry"><div><a href="#' +
            r.slug +
            '"><b>' +
            title(r.slug) +
            "</b></a><code>" +
            r.slug +
            '</code></div><div class="state">' +
            state(r) +
            "</div></div>",
        )
        .join("") ||
      (query
        ? "No experiments match this search."
        : "There are no experiments in this installation.");
    if (hits.length > 4)
      $("#results").innerHTML +=
        '<div class="actions">' +
        (page ? button("Previous", "previous") : "") +
        (4 * (page + 1) < hits.length ? button("Next", "next") : "") +
        "</div>";
  }
  $("#search").value = query;
  $("#search").oninput = (e) => {
    query = e.target.value;
    page = 0;
    list();
  };
  list();
}
function detail(r) {
  const choices = [];
  if (manager) {
    if (r.enabled && ["ready", "active"].includes(r.phase))
      choices.push(button(r.phase === "ready" ? "Launch rollout" : "Adjust split", "split", true));
    choices.push(
      button(r.enabled ? "Pause serving" : "Resume serving", r.enabled ? "pause" : "resume"),
    );
    if (r.enabled && !r.winner && ["active", "legacy"].includes(r.phase))
      choices.push(button("Select winner", "winner"));
  }
  main.innerHTML =
    heading(title(r.slug), r.slug, '<div class="state">' + state(r) + "</div>") +
    '<section class="serving"><div class="rowtitle"><h2>Serving now</h2></div>' +
    outcomes(audience(r)) +
    '</section><div class="pair"><section class="members"><div class="rowtitle"><h2>Cohorts</h2></div>' +
    (fault === "counts"
      ? '<div class="alert" role="alert">Membership counts unavailable. ' +
        button("Retry counts", "retry-counts") +
        "</div>"
      : "") +
    '<table><thead><tr><th scope="col">Cohort</th><th scope="col" class="num">' +
    (r.phase === "legacy"
      ? "Selection"
      : r.winner || !r.enabled
        ? "Saved split"
        : "New assignment share") +
    '</th><th scope="col" class="num">Current memberships</th></tr></thead><tbody>' +
    r.cohorts
      .map(
        (c, i) =>
          '<tr><th scope="row"><code>' +
          safe(c) +
          '</code><small class="role">' +
          (c === r.cohorts[0] ? "Control" : "Treatment") +
          '</small></th><td class="num">' +
          (r.phase === "legacy" ? "Uniform" : r.weights[i] + "%") +
          '</td><td class="num">' +
          (fault === "counts" ? "Unavailable" : r.counts[i]) +
          "</td></tr>",
      )
      .join("") +
    "</tbody></table></section>" +
    (choices.length
      ? '<aside><h2>Manage rollout</h2><div class="actions">' + choices.join("") + "</div></aside>"
      : "") +
    "</div>";
}
function createForm() {
  main.innerHTML =
    heading("Create experiment") +
    '<form id="create"><label class="field">Experiment slug<input name="slug" required aria-describedby="slug-help"><span id="slug-help">Use lowercase words joined by hyphens.</span></label><label class="field">Treatments<input name="names" required aria-describedby="names-help"><span id="names-help">Separate treatment names with commas. xp adds the off control.</span></label><p>Off is pinned at 100% until launch. Visitors receive the application default.</p><p id="invalid" class="alert" role="alert"></p><div class="actions"><button class="primary">Create experiment</button><a href="#">Cancel</a></div></form>';
  $("#create").onsubmit = (e) => {
    e.preventDefault();
    const form = e.target,
      slug = form.slug.value.trim(),
      names = form.names.value.split(",").map((v) => v.trim()),
      kebab = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    const field =
      !kebab.test(slug) || records.some((r) => r.slug === slug)
        ? form.slug
        : !names.every((n) => kebab.test(n) && n !== "off") || new Set(names).size !== names.length
          ? form.names
          : null;
    if (field) {
      $("#invalid").textContent =
        field === form.slug
          ? "Choose a unique kebab-case slug."
          : "Choose distinct kebab-case treatment names.";
      field.setAttribute("aria-invalid", "true");
      field.setAttribute("aria-describedby", "invalid");
      field.focus();
      return;
    }
    records.push(
      record(
        slug,
        "ready",
        ["off", ...names],
        [100, ...names.map(() => 0)],
        Array(1 + names.length).fill(0),
        true,
        "off",
      ),
    );
    location.hash = slug;
  };
}
function split(r) {
  main.innerHTML =
    heading(r.phase === "ready" ? "Launch rollout" : "Adjust split", r.slug) +
    '<form id="split"><section class="members"><div class="rowtitle"><h2>New assignments</h2></div><table><thead><tr><th>Cohort</th><th class="num">Saved</th><th class="num">Proposed %</th></tr></thead><tbody>' +
    r.cohorts
      .map(
        (c, i) =>
          '<tr><th scope="row">' +
          safe(c) +
          '</th><td class="num">' +
          r.weights[i] +
          '%</td><td class="num"><input class="weight" aria-label="Proposed percentage for ' +
          safe(c) +
          '" inputmode="decimal" value="' +
          r.weights[i] +
          '"></td></tr>',
      )
      .join("") +
    '</tbody></table></section><p>Total <output></output></p><p id="invalid" class="alert" role="alert"></p><div class="actions"><button class="primary">Review split</button><a href="#' +
    r.slug +
    '">Cancel</a></div></form>';
  const inputs = [...document.querySelectorAll(".weight")];
  const basis = () =>
    inputs.map((input) =>
      /^\d+(\.\d{1,2})?$/.test(input.value) && Number(input.value) <= 100
        ? Math.round(Number(input.value) * 100)
        : NaN,
    );
  function total() {
    const sum = basis().reduce((a, b) => a + b, 0);
    $("output").value = Number.isFinite(sum) ? sum / 100 + "%" : "Incomplete";
    return sum;
  }
  total();
  $("#split").oninput = total;
  $("#split").onsubmit = (e) => {
    e.preventDefault();
    if (total() !== 10000) {
      $("#invalid").textContent = "Enter percentages totaling 100, with up to two decimal places.";
      inputs[0].focus();
      return;
    }
    const values = basis().map((v) => v / 100),
      action = r.phase === "ready" ? "Launch rollout" : "Apply split";
    const lines = r.cohorts
      .map(
        (c, i) =>
          '<tr><th scope="row">' +
          safe(c) +
          "</th><td>" +
          r.weights[i] +
          "%</td><td>" +
          values[i] +
          "%</td></tr>",
      )
      .join("");
    confirmAction(
      r,
      action,
      "<table><thead><tr><th>Cohort</th><th>Saved</th><th>Proposed</th></tr></thead><tbody>" +
        lines +
        "</tbody></table>" +
        outcomes([
          "Existing members keep their cohort.",
          values.includes(100)
            ? "Every new member joins " + r.cohorts[values.indexOf(100)] + "."
            : "New members draw from the proposed split.",
        ]),
      () => {
        r.phase = "active";
        r.winner = null;
        r.weights = values;
      },
    );
  };
}
function confirmAction(r, action, body, commit) {
  returnFocus = document.activeElement;
  $("#review").innerHTML =
    '<h2 id="review-title">' +
    safe(action) +
    "</h2><code>" +
    safe(r.slug) +
    " · Revision " +
    r.revision +
    "</code>" +
    body;
  $("#problem").replaceChildren();
  $("#commit").textContent = action;
  $("#commit").disabled = false;
  saveReview = () => {
    if (fault === "save") {
      fault = null;
      $("#problem").textContent = "Save failed. Your changes are still available. Try again.";
      return;
    }
    if (fault === "stale") {
      fault = null;
      r.revision++;
      if (r.phase === "active" && r.weights.length === 3) {
        r.weights = [80, 10, 10];
      }
      $("#problem").innerHTML =
        "A newer revision was saved. " + button("Review current values", "refresh");
      $("#commit").disabled = true;
      return;
    }
    commit();
    r.revision++;
    dialog.close();
    location.hash = r.slug;
    render(true);
    $("#status").textContent = "Saved.";
  };
  dialog.showModal();
  dialog.querySelector('[value="cancel"]').focus();
}
function navigate(r, command) {
  if (command === "split") {
    location.hash = r.slug + "/split";
    return;
  }
  if (command === "retry-counts") {
    fault = null;
    detail(r);
    $("#status").textContent = "Membership counts refreshed.";
    return;
  }
  if (command === "winner") {
    const options = r.cohorts
      .map((c) => '<option value="' + safe(c) + '">' + qualified(r, c) + "</option>")
      .join("");
    confirmAction(
      r,
      "Select winner",
      '<label class="field">Winning cohort<select id="winner">' +
        options +
        '</select></label><div id="effect"></div><p>Stored membership counts stay intact.</p>',
      () => {
        r.winner = $("#winner").value;
        if (r.phase !== "legacy") r.phase = "final";
      },
    );
    function update() {
      const choice = $("#winner").value;
      const value = choice === "off" ? "Application default." : choice + ".";
      $("#effect").innerHTML = outcomes([
        value + " The winner overrides their cohort.",
        value + " Automatic decisions create no membership.",
      ]);
    }
    update();
    $("#winner").onchange = update;
    return;
  }
  const next = command === "resume";
  confirmAction(
    r,
    next ? "Resume serving" : "Pause serving",
    outcomes(audience({ ...r, enabled: next })) +
      "<p>The saved phase, split and current memberships are retained.</p>",
    () => {
      r.enabled = next;
    },
  );
}
function render(focus = false) {
  const [slug, view] = location.hash.slice(1).split("/"),
    r = records.find((x) => x.slug === slug);
  $("#access").textContent = manager ? "Manage access" : "View only";
  $("#crumb").textContent = r ? " / " + r.slug : "";
  $("#status").textContent = "";
  if (!slug) directory();
  else if (slug === "!create" && createAllowed) createForm();
  else if (!r)
    main.innerHTML = heading("Experiment unavailable") + '<a href="#">Back to directory</a>';
  else if (view === "split" && manager && r.enabled && ["ready", "active"].includes(r.phase))
    split(r);
  else detail(r);
  if (focus) main.querySelector("h1")?.focus();
}
document.addEventListener("click", (e) => {
  const command = e.target.closest("[data-do]")?.dataset.do;
  if (!command) return;
  if (command === "refresh") {
    const r = records.find((x) => x.slug === location.hash.slice(1).split("/")[0]);
    if (r)
      document.querySelectorAll("#split tbody tr").forEach((row, i) => {
        row.cells[1].textContent = r.weights[i] + "%";
      });
    dialog.close();
    returnFocus?.focus();
    $("#status").textContent = "Current revision loaded. Review your draft before submitting.";
    return;
  }
  if (command === "create") {
    location.hash = "!create";
    return;
  }
  if (command === "previous" || command === "next") {
    page += command === "next" ? 1 : -1;
    directory();
    $("#search").focus();
    return;
  }
  const r = records.find((x) => x.slug === location.hash.slice(1));
  if (r) navigate(r, command);
});
$("#skip").onclick = (e) => {
  e.preventDefault();
  main.focus();
};
$("#commit").onclick = () => saveReview();
dialog.addEventListener("close", () => {
  if (returnFocus?.isConnected) returnFocus.focus();
});
window.addEventListener("hashchange", () => render(true));
render();
