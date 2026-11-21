(() => {
  // Offline reference. URL fixtures reproduce permissions and storage failures in a single tab.
  const { document, location, window, URLSearchParams } = globalThis;
  const $ = (selector, root = document) => root.querySelector(selector);
  const main = $("#content");
  const dialog = $("dialog");
  const options = new URLSearchParams(location.search);
  const access = options.get("access") || "manage";
  const mayCreate = access === "manage" && !options.has("disable-create");
  const labels = {
    legacy: "Legacy uniform",
    ready: "Awaiting launch",
    active: "Allocating",
    final: "Winner selected",
  };
  const pageSize = 4;
  const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const escapeHtml = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  const nameOf = (slug) => slug[0].toUpperCase() + slug.slice(1).replaceAll("-", " ");
  const route = (slug) => "#" + encodeURIComponent(slug);
  const make = (slug, phase, cohorts, weights, counts, enabled = true, winner = null) => ({
    slug,
    phase,
    cohorts,
    weights,
    counts,
    enabled,
    winner,
    revision: 1,
  });
  const records = options.has("empty")
    ? []
    : [
        make("existing-banner", "legacy", ["control", "short"], [50, 50], [14, 21]),
        make(
          "delivery-promise",
          "ready",
          ["off", "next-day-delivery-with-order-tracking"],
          [100, 0],
          [0, 0],
          true,
          "off",
        ),
        make("checkout-copy", "active", ["off", "short", "detailed"], [90, 5, 5], [84, 11, 5]),
        make("address-hint", "active", ["off", "compact"], [75, 25], [23, 7], false),
        make("cart-recap", "final", ["off", "compact"], [50, 50], [36, 28], true, "off"),
      ];
  let query = "";
  let page = 0;
  let fault = options.get("error");
  let focusOnClose;
  let commitReview;
  let pendingAnnouncement = "";
  let activeRecord;
  const text = escapeHtml;
  const button = (label, command, primary = false) =>
    '<button type="button" data-command="' +
    command +
    '"' +
    (primary ? ' class="primary"' : "") +
    ">" +
    text(label) +
    "</button>";
  const cell = (label, contents, kind = "") =>
    '<td class="' +
    kind +
    '"><span class="cell-label" aria-hidden="true">' +
    text(label) +
    "</span>" +
    contents +
    "</td>";
  function heading(title, slug = "", aside = "") {
    document.title = title + " · xp";
    return (
      '<header class="meta"><div><h1 tabindex="-1">' +
      text(title) +
      "</h1>" +
      (slug ? "<code>" + text(slug) + "</code>" : "") +
      "</div>" +
      aside +
      "</header>"
    );
  }
  function phaseLabel(r) {
    return r.phase === "legacy" && r.winner ? "Legacy uniform · Winner selected" : labels[r.phase];
  }
  const availability = (r) => (r.enabled ? "Enabled" : "Paused");
  const winnerDecision = (r) =>
    r.winner === "off" && r.phase !== "legacy" ? "Application default" : r.slug + "_" + r.winner;
  function serving(r) {
    if (!r.enabled) return "Application default";
    if (r.winner) return winnerDecision(r);
    return r.phase === "legacy" ? "Uniform assignment" : "Weighted assignment";
  }
  function audience(r) {
    if (!r.enabled)
      return [
        "Application default. Their assignments stay in storage.",
        "Application default. Automatic decisions create no memberships.",
      ];
    if (r.winner) {
      const target = winnerDecision(r);
      return [
        target +
          (r.phase === "ready"
            ? ". The off control is pinned."
            : ". The winner overrides their assignment."),
        target + ". Automatic decisions create no memberships.",
      ];
    }
    const full = r.weights.indexOf(100);
    const next =
      r.phase === "legacy"
        ? "Each cohort has an equal chance."
        : full >= 0
          ? "All join " + r.cohorts[full] + "."
          : "Assigned using the split below.";
    return [
      "They keep their assigned cohort.",
      next + (r.phase === "legacy" ? "" : " Off serves the application default."),
    ];
  }
  const lanes = ([existing, joining]) =>
    '<div class="outcomes"><div><h3>Existing members</h3><p>' +
    text(existing) +
    "</p></div><div><h3>New members</h3><p>" +
    text(joining) +
    "</p></div></div>";
  function directory() {
    main.innerHTML =
      heading("Experiments", "", mayCreate ? button("Create experiment", "create", true) : "") +
      '<label class="field">Find an experiment<input id="search" type="search" placeholder="Name or slug"></label><div id="results"></div>';
    const search = $("#search");
    search.value = query;
    function list() {
      const matches = records.filter((r) =>
        (r.slug + " " + nameOf(r.slug)).toLowerCase().includes(query.toLowerCase().trim()),
      );
      if (!matches.length) {
        $("#results").innerHTML =
          "<p>" +
          (query
            ? "No experiments match this search."
            : "There are no experiments in this installation.") +
          "</p>";
        return;
      }
      const rows = matches
        .slice(page * pageSize, (page + 1) * pageSize)
        .map(
          (r) =>
            '<tr><th scope="row"><a class="dir-name" href="' +
            route(r.slug) +
            '">' +
            text(nameOf(r.slug)) +
            "</a><code>" +
            text(r.slug) +
            "</code></th>" +
            cell("Availability", text(availability(r))) +
            cell("Phase", text(phaseLabel(r))) +
            cell("Serving now", text(serving(r))) +
            "</tr>",
        );
      $("#results").innerHTML =
        '<table class="dir"><thead><tr><th>Experiment</th><th>Availability</th><th>Phase</th><th>Serving now</th></tr></thead><tbody>' +
        rows.join("") +
        '</tbody></table><div class="page-nav"><small>' +
        (page * pageSize + 1) +
        "–" +
        Math.min((page + 1) * pageSize, matches.length) +
        " of " +
        matches.length +
        "</small>" +
        (page ? button("Previous", "previous") : "") +
        ((page + 1) * pageSize < matches.length ? button("Next", "next") : "") +
        "</div>";
    }
    search.oninput = () => {
      query = search.value;
      page = 0;
      list();
    };
    list();
  }
  function detail(r) {
    const state =
      '<div class="state"><span class="chip">' +
      availability(r) +
      "</span><span>" +
      text(phaseLabel(r)) +
      "</span></div>";
    const column =
      r.phase === "legacy"
        ? "Selection"
        : r.winner || !r.enabled
          ? "Saved split"
          : "New assignment share";
    const rows = r.cohorts.map((c, i) => {
      const share = r.phase === "legacy" ? "Equal chance" : r.weights[i] + "%";
      const meter =
        r.phase === "legacy"
          ? ""
          : '<span class="track" aria-hidden="true"><i style="width:' +
            r.weights[i] +
            '%"></i></span>';
      return (
        '<tr><th scope="row"><code>' +
        text(c) +
        '</code><small class="role">' +
        (i === 0 ? "Control" : "Treatment") +
        "</small></th>" +
        cell(column, '<span class="band">' + text(share) + meter + "</span>", "num") +
        cell("Current memberships", fault === "counts" ? "Unavailable" : text(r.counts[i]), "num") +
        "</tr>"
      );
    });
    const actions = [];
    if (access === "manage") {
      if (r.enabled && ["active", "ready"].includes(r.phase))
        actions.push(
          button(r.phase === "ready" ? "Launch rollout" : "Adjust split", "split", true),
        );
      actions.push(
        button(r.enabled ? "Pause serving" : "Resume serving", r.enabled ? "pause" : "resume"),
      );
      if (r.enabled && !r.winner) actions.push(button("Select winner", "winner"));
    }
    main.innerHTML =
      heading(nameOf(r.slug), r.slug, state) +
      '<section class="serving"><div class="rowtitle"><h2>Serving now</h2><span class="serving-summary">' +
      text(serving(r)) +
      "</span></div>" +
      lanes(audience(r)) +
      '</section><section class="members"><div class="rowtitle"><h2>Cohorts</h2><span class="small">Revision ' +
      r.revision +
      "</span></div>" +
      (fault === "counts"
        ? '<p class="alert" role="alert">Membership counts unavailable. ' +
          button("Retry counts", "counts") +
          "</p>"
        : "") +
      '<table class="stacked"><thead><tr><th>Cohort</th><th class="num">' +
      column +
      '</th><th class="num">Current memberships</th></tr></thead><tbody>' +
      rows.join("") +
      '</tbody></table></section><div class="actions">' +
      actions.join("") +
      "</div>";
  }
  function createForm() {
    main.innerHTML =
      heading("Create experiment") +
      '<form class="creation"><label class="field">Experiment slug<input name="slug" required aria-describedby="slug-guide"><span id="slug-guide">Use lowercase words joined by hyphens.</span></label><label class="field">Treatments<input name="names" required aria-describedby="names-guide"><span id="names-guide">Separate treatment names with commas. xp adds the off control.</span></label><p>Off is pinned at 100% until launch. Visitors receive the application default.</p><p class="alert" id="invalid" role="alert"></p><div class="actions"><button class="primary">Create experiment</button><a href="#">Cancel</a></div></form>';
    const form = $("form", main);
    form.oninput = (e) => e.target.removeAttribute("aria-invalid");
    form.onsubmit = (e) => {
      e.preventDefault();
      const slug = form.elements.slug.value.trim();
      const names = form.elements.names.value.split(",").map((n) => n.trim());
      let field = form.elements.slug,
        error = "";
      if (!slugPattern.test(slug)) error = "Enter a lowercase kebab-case experiment slug.";
      else if (records.some((r) => r.slug === slug))
        error = "An experiment already uses this slug.";
      else if (
        !names.every((n) => slugPattern.test(n) && n !== "off") ||
        new Set(names).size !== names.length
      ) {
        field = form.elements.names;
        error = "Enter distinct treatment names. The off control is included automatically.";
      }
      if (error) {
        $("#invalid").textContent = error;
        field.setAttribute("aria-invalid", "true");
        field.setAttribute("aria-describedby", "invalid");
        field.focus();
        return;
      }
      if (fault === "save") {
        fault = null;
        $("#invalid").textContent = "Creation failed. Your inputs are still here. Try again.";
        return;
      }
      records.push(
        make(
          slug,
          "ready",
          ["off", ...names],
          [100, ...names.map(() => 0)],
          Array(names.length + 1).fill(0),
          true,
          "off",
        ),
      );
      pendingAnnouncement = "Experiment created.";
      location.hash = route(slug);
    };
  }
  function split(r) {
    const rows = r.cohorts.map(
      (c, i) =>
        '<tr><th scope="row"><code>' +
        text(c) +
        "</code></th>" +
        cell("Saved split", '<span class="saved">' + r.weights[i] + "%</span>", "num") +
        cell(
          "Proposed split",
          '<input class="weight" aria-label="Proposed percentage for ' +
            text(c) +
            '" inputmode="decimal" value="' +
            r.weights[i] +
            '">',
          "num",
        ) +
        "</tr>",
    );
    main.innerHTML =
      '<div class="editor">' +
      heading(r.phase === "ready" ? "Launch rollout" : "Adjust split", r.slug) +
      '<form><table class="stacked"><thead><tr><th>Cohort</th><th class="num">Saved split</th><th class="num">Proposed split (%)</th></tr></thead><tbody>' +
      rows.join("") +
      '</tbody></table><p class="total">Proposed total <output></output></p><p id="invalid" class="alert" role="alert"></p><div class="actions"><button class="primary">Review split</button><a href="' +
      route(r.slug) +
      '">Cancel</a></div></form></div>';
    const inputs = Array.from(main.querySelectorAll(".weight"));
    const basis = (val) =>
      /^\d+(\.\d{1,2})?$/.test(val) && Number(val) <= 100 ? Math.round(Number(val) * 100) : NaN;
    function refresh() {
      const sum = inputs.reduce((a, input) => a + basis(input.value), 0);
      $("output").value = Number.isFinite(sum) ? sum / 100 + "%" : "Incomplete";
      return sum;
    }
    refresh();
    const form = $("form", main);
    form.oninput = refresh;
    form.onsubmit = (e) => {
      e.preventDefault();
      if (refresh() !== 10000) {
        $("#invalid").textContent =
          "Enter percentages from 0 to 100 with up to two decimal places, totaling 100%.";
        (inputs.find((el) => !Number.isFinite(basis(el.value))) || inputs[0]).focus();
        return;
      }
      $("#invalid").textContent = "";
      const values = inputs.map((el) => basis(el.value) / 100);
      const comparison = r.cohorts.map(
        (c, i) =>
          '<tr><th scope="row">' +
          text(c) +
          "</th>" +
          cell("Saved split", r.weights[i] + "%", "num") +
          cell("Proposed split", values[i] + "%", "num") +
          cell(
            "Current memberships",
            fault === "counts" ? "Unavailable" : text(r.counts[i]),
            "num",
          ) +
          "</tr>",
      );
      const full = values.indexOf(100);
      const body =
        lanes([
          "They keep their assigned cohort.",
          full >= 0 ? "All join " + r.cohorts[full] + "." : "Assigned using the proposed split.",
        ]) +
        '<table class="stacked review-table"><thead><tr><th>Cohort</th><th class="num">Saved split</th><th class="num">Proposed split</th><th class="num">Current memberships</th></tr></thead><tbody>' +
        comparison.join("") +
        '</tbody></table><p class="note">Current memberships stay in storage.</p>';
      confirmAction(
        r,
        "Review allocation",
        r.phase === "ready" ? "Launch rollout" : "Apply split",
        body,
        () => {
          r.phase = "active";
          r.winner = null;
          r.weights = values;
        },
      );
    };
  }
  function confirmAction(r, title, action, body, save) {
    focusOnClose = document.activeElement;
    $("#review").innerHTML =
      '<h2 id="review-title" tabindex="-1" autofocus>' +
      text(title) +
      "</h2><code>" +
      text(r.slug) +
      " · Revision " +
      r.revision +
      "</code>" +
      body;
    $("#problem").replaceChildren();
    $("#commit").textContent = action;
    $("#commit").disabled = false;
    commitReview = () => {
      if (fault === "save") {
        fault = null;
        $("#problem").textContent = "Save failed. Your inputs are still here. Try again.";
        return;
      }
      if (fault === "stale") {
        fault = null;
        r.revision++;
        if (r.phase === "active" && r.weights.length === 3) r.weights = [80, 10, 10];
        $("#problem").innerHTML =
          "A newer revision was saved. " + button("Review current values", "refresh");
        $("#commit").disabled = true;
        return;
      }
      save();
      r.revision++;
      focusOnClose = null;
      dialog.close();
      if (location.hash === route(r.slug)) {
        render(true);
        $("#status").textContent = "Changes saved.";
      } else {
        pendingAnnouncement = "Changes saved.";
        location.hash = route(r.slug);
      }
    };
    dialog.showModal();
    $("#review-title").focus({ preventScroll: true });
    dialog.scrollTop = 0;
  }
  function winner(r) {
    const choices = r.cohorts.map(
      (c) => '<option value="' + text(c) + '">' + text(r.slug + "_" + c) + "</option>",
    );
    confirmAction(
      r,
      "Select winner",
      "Select winner",
      '<label class="field">Winning cohort<select id="winner">' +
        choices.join("") +
        '</select></label><div id="effect"></div><p class="note">Current memberships stay in storage.</p>',
      () => {
        r.winner = $("#winner").value;
        if (r.phase !== "legacy") r.phase = "final";
      },
    );
    function change() {
      const choice = $("#winner").value;
      const next = { ...r, winner: choice, phase: r.phase === "legacy" ? "legacy" : "final" };
      $("#effect").innerHTML = lanes(audience(next));
      $("#commit").textContent = "Select " + choice + " as winner";
    }
    $("#winner").onchange = change;
    change();
  }
  function render(focus = false) {
    const [slug, view] = location.hash.slice(1).split("/");
    activeRecord = records.find((r) => r.slug === slug);
    $("#access").textContent =
      access === "manage" ? "Manage access" : access === "view" ? "View only" : "Access denied";
    $("#crumb").textContent = activeRecord ? " / " + activeRecord.slug : "";
    $("#status").textContent = pendingAnnouncement;
    pendingAnnouncement = "";
    if (access === "deny")
      main.innerHTML =
        heading("Access denied") + "<p>Your host account needs experiment view access.</p>";
    else if (!slug) directory();
    else if (slug === "!create" && mayCreate) createForm();
    else if (slug === "!create")
      main.innerHTML =
        heading("Creation unavailable") +
        '<p>This installation requires creation to be enabled and a manager account.</p><a href="#">Back to directory</a>';
    else if (!activeRecord)
      main.innerHTML = heading("Experiment unavailable") + '<a href="#">Back to directory</a>';
    else if (
      view === "split" &&
      access === "manage" &&
      activeRecord.enabled &&
      ["ready", "active"].includes(activeRecord.phase)
    )
      split(activeRecord);
    else detail(activeRecord);
    if (focus) main.querySelector("h1")?.focus();
  }
  document.addEventListener("click", (e) => {
    const command = e.target.closest("[data-command]")?.dataset.command;
    if (!command) return;
    if (command === "next" || command === "previous") {
      page += command === "next" ? 1 : -1;
      directory();
      $("#search").focus();
      return;
    }
    if (command === "create") {
      location.hash = "!create";
      return;
    }
    const r = activeRecord;
    if (!r) return;
    if (command === "counts") {
      fault = null;
      detail(r);
      main.querySelector("h1").focus();
      $("#status").textContent = "Membership counts refreshed.";
      return;
    }
    if (command === "refresh") {
      dialog.close();
      if (location.hash.endsWith("/split")) {
        main
          .querySelectorAll(".saved")
          .forEach((node, i) => (node.textContent = r.weights[i] + "%"));
        $("#status").textContent =
          "Updated saved values. Review your proposal against revision " + r.revision + ".";
      } else {
        render(true);
        $("#status").textContent =
          "Revision " + r.revision + " loaded. Review the current state before trying again.";
      }
      return;
    }
    if (command === "split") {
      location.hash = route(r.slug) + "/split";
      return;
    }
    if (command === "winner") {
      winner(r);
      return;
    }
    if (command === "pause" || command === "resume") {
      const enabled = command === "resume";
      const action = enabled ? "Resume serving" : "Pause serving";
      confirmAction(
        r,
        action,
        action,
        lanes(audience({ ...r, enabled })) +
          '<p class="note">The saved phase, split and current memberships are retained.</p>',
        () => (r.enabled = enabled),
      );
    }
  });
  $("#skip").onclick = (e) => {
    e.preventDefault();
    main.focus();
  };
  $("#commit").onclick = () => commitReview();
  dialog.addEventListener("close", () => {
    if (focusOnClose?.isConnected) focusOnClose.focus();
  });
  window.addEventListener("hashchange", () => render(true));
  render();
})();
