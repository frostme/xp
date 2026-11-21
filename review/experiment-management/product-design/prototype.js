// This review prototype uses synthetic records scoped to the current page.
(() => {
  const { URLSearchParams, document, location, Node, window } = globalThis;
  const fixtures = [
    ["existing-banner", "Legacy uniform", true, ["control", "short"], [50, 50], [14, 21]],
    [
      "delivery-promise",
      "Awaiting launch",
      true,
      ["off", "next-day-delivery-with-order-tracking"],
      [100, 0],
      [0, 0],
    ],
    ["checkout-copy", "Allocating", true, ["off", "short", "detailed"], [90, 5, 5], [84, 11, 5]],
    ["address-hint", "Allocating", false, ["off", "compact"], [75, 25], [23, 7]],
    ["cart-recap", "Winner selected", true, ["off", "compact"], [50, 50], [36, 28]],
  ];
  const options = new URLSearchParams(location.search);
  const records = new Map(
    (options.has("empty") ? [] : fixtures).map(
      ([slug, phase, enabled, cohorts, weights, counts]) => [
        slug,
        {
          slug,
          phase,
          enabled,
          cohorts,
          weights,
          counts,
          winner: phase === "Winner selected" || phase === "Awaiting launch" ? "off" : null,
        },
      ],
    ),
  );
  const canManage = !options.has("viewer");
  const canCreate = canManage && !options.has("no-create");
  const screen = document.querySelector("#screen");
  const crumb = document.querySelector("#breadcrumb");
  const status = document.querySelector("#status");
  let draft,
    draftSlug,
    search = "",
    page = 0,
    failedCounts = options.has("counts-error");
  let restoreFocus;
  let failSave = options.get("save-error");
  const el = (tag, content, className) => {
    const element = document.createElement(tag);
    if (content !== undefined) element.textContent = content;
    if (className) element.className = className;
    return element;
  };
  function link(text, path, style) {
    const a = el("a", text, style);
    a.href = "#" + path;
    return a;
  }
  function cancelLink(r, trigger) {
    const a = link("Cancel", r.slug, "button");
    a.addEventListener("click", () => {
      restoreFocus = trigger;
    });
    return a;
  }
  function button(label, action, primary = false) {
    const b = el("button", label, primary ? "primary" : undefined);
    b.type = "button";
    b.onclick = action;
    return b;
  }
  const go = (path) => {
    location.hash = path;
  };
  const displayName = (slug) => slug[0].toUpperCase() + slug.slice(1).replaceAll("-", " ");
  const metadata = (r) => [r.slug, r.enabled ? "Enabled" : "Paused", r.phase].join(" · ");
  function heading(title, sub) {
    const h = el("h1", title);
    h.tabIndex = -1;
    screen.append(h);
    if (sub) screen.append(el("p", sub, "meta"));
    document.title = title + " · Experiments";
  }
  function section(title, body) {
    const s = el("section", undefined, "section");
    s.append(el("h2", title), el("p", body, "copy"));
    screen.append(s);
  }
  function actions(...controls) {
    const group = el("div", undefined, "actions");
    group.append(...controls);
    screen.append(group);
  }
  function table(headers, rows) {
    const t = el("table"),
      head = t.createTHead().insertRow();
    for (const header of headers) {
      const cell = el("th", header);
      cell.scope = "col";
      head.append(cell);
    }
    const body = t.createTBody();
    for (const values of rows) {
      const row = body.insertRow();
      values.forEach((value, i) => {
        const c = el(i === 0 ? "th" : "td");
        if (i === 0) c.scope = "row";
        else {
          const label = el("span", headers[i], "rowlabel");
          label.setAttribute("aria-hidden", "true");
          c.append(label);
        }
        c.append(value instanceof Node ? value : document.createTextNode(String(value)));
        row.append(c);
      });
    }
    const wrapper = el("div", undefined, "table-wrap");
    wrapper.append(t);
    screen.append(wrapper);
  }
  function directory() {
    heading("Experiments");
    const label = el("label", "Find by name or slug");
    const input = el("input");
    input.type = "search";
    input.value = search;
    label.append(el("br"), input);
    const list = el("ul", undefined, "directory");
    const controls = el("div", undefined, "actions");
    function refresh() {
      list.replaceChildren();
      controls.replaceChildren();
      const matches = [...records.values()].filter((r) =>
        [r.slug, displayName(r.slug)].some((v) => v.toLowerCase().includes(search.toLowerCase())),
      );
      for (const r of matches.slice(page * 4, page * 4 + 4)) {
        const item = el("li");
        item.append(link(displayName(r.slug), r.slug), el("small", metadata(r)));
        list.append(item);
      }
      if (!matches.length)
        list.append(el("li", search ? "No matching experiments." : "No experiments yet."));
      if (page > 0)
        controls.append(
          button("Previous page", () => {
            page--;
            refresh();
          }),
        );
      if (matches.length > (page + 1) * 4)
        controls.append(
          button("Next page", () => {
            page++;
            refresh();
          }),
        );
    }
    input.oninput = () => {
      search = input.value;
      page = 0;
      refresh();
    };
    screen.append(label, list, controls);
    refresh();
    if (canCreate) actions(link("Create experiment", "/create", "button primary"));
  }
  function create() {
    if (!canCreate) {
      heading("Creation unavailable");
      return;
    }
    heading(
      "Create experiment",
      "The off control starts pinned at 100%. Visitors receive the application default.",
    );
    const form = el("form", undefined, "fields");
    function field(labelText, textarea = false) {
      const label = el("label", labelText),
        input = el(textarea ? "textarea" : "input");
      input.required = true;
      input.className = "text-field";
      label.append(input);
      form.append(label);
      return input;
    }
    const slugField = field("Experiment slug"),
      treatments = field("Treatment names, one per line", true);
    const error = el("p", undefined, "error");
    error.setAttribute("role", "alert");
    const submit = el("button", "Create experiment", "primary");
    submit.type = "submit";
    form.append(error, submit);
    screen.append(form);
    form.onsubmit = (e) => {
      e.preventDefault();
      const slug = slugField.value.trim(),
        names = treatments.value.trim().split(/\s+/);
      const valid = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
      if (!valid.test(slug) || records.has(slug)) {
        error.textContent = "Enter a unique kebab-case experiment slug.";
        slugField.focus();
        return;
      }
      if (
        !names.every((v) => valid.test(v) && v !== "off") ||
        new Set(names).size !== names.length
      ) {
        error.textContent = "Enter distinct treatments. xp adds off automatically.";
        treatments.focus();
        return;
      }
      records.set(slug, {
        slug,
        enabled: true,
        phase: "Awaiting launch",
        cohorts: ["off", ...names],
        weights: [100, ...names.map(() => 0)],
        counts: [0, ...names.map(() => 0)],
        winner: "off",
      });
      go(slug);
    };
  }
  const effectiveWinner = (r) => (r.winner === "off" ? "the application default" : r.winner);
  function detail(r) {
    heading(displayName(r.slug), metadata(r));
    const serving = !r.enabled
      ? "Application default for all users. Resume restores the saved state."
      : r.winner
        ? "All users receive " + effectiveWinner(r) + "."
        : "Existing members keep their cohort. New members follow " +
          (r.phase === "Legacy uniform" ? "the uniform bucketer." : "the current split.");
    section("Serving now", serving);
    table(
      [
        "Cohort",
        r.phase === "Allocating" && r.enabled ? "New assignment share" : "Saved allocation",
        "Current memberships",
      ],
      r.cohorts.map((c, i) => [
        c,
        r.phase === "Legacy uniform" ? "Equal chance" : r.weights[i] + "%",
        failedCounts ? "Unavailable" : r.counts[i],
      ]),
    );
    if (failedCounts)
      actions(
        button("Retry membership counts", () => {
          failedCounts = false;
          render();
        }),
      );
    if (!canManage) return;
    const controls = [];
    if (r.enabled && ["Awaiting launch", "Allocating"].includes(r.phase))
      controls.push(
        button(
          r.phase === "Awaiting launch" ? "Launch rollout" : "Adjust split",
          () => {
            draft = [...r.weights];
            draftSlug = r.slug;
            go(r.slug + "/edit");
          },
          true,
        ),
      );
    if (r.enabled && ["Legacy uniform", "Allocating"].includes(r.phase) && !r.winner)
      controls.push(link("Select winner", r.slug + "/winner", "button"));
    controls.push(
      link(r.enabled ? "Pause" : "Resume", r.slug + (r.enabled ? "/pause" : "/resume"), "button"),
    );
    actions(...controls);
  }
  function editor(r) {
    heading(r.phase === "Awaiting launch" ? "Launch rollout" : "Adjust allocation", metadata(r));
    const inputs = r.cohorts.map((name, i) => {
      const input = el("input");
      input.type = "number";
      input.step = "0.01";
      input.min = "0";
      input.max = "100";
      input.value = String(draft[i]);
      input.setAttribute("aria-label", name + " proposed percent");
      return input;
    });
    table(
      ["Cohort", "Saved split", "Proposed split"],
      r.cohorts.map((name, i) => [name, r.weights[i] + "%", inputs[i]]),
    );
    const total = el("p");
    total.setAttribute("role", "status");
    const error = el("p", undefined, "error");
    error.setAttribute("role", "alert");
    function update() {
      draft = inputs.map((n) => n.value);
      total.textContent =
        "Total " + Number(draft.reduce((s, v) => s + Math.round(Number(v) * 100), 0) / 100) + "%";
    }
    inputs.forEach((n) => (n.oninput = update));
    update();
    screen.append(total, error);
    actions(
      button(
        "Review allocation",
        () => {
          const invalid = inputs.find((n) => !n.value || !n.validity.valid);
          if (invalid || draft.reduce((s, v) => s + Math.round(Number(v) * 100), 0) !== 10000) {
            error.textContent = "Use 0–100% with up to two decimals and a total of 100%.";
            (invalid ?? inputs[0]).focus();
            return;
          }
          go(r.slug + "/review");
        },
        true,
      ),
      cancelLink(r, r.phase === "Awaiting launch" ? "Launch rollout" : "Adjust split"),
    );
  }
  function review(r) {
    heading("Review allocation", metadata(r));
    table(
      ["Cohort", "Saved split", "Proposed split", "Current memberships"],
      r.cohorts.map((c, i) => [
        c,
        r.weights[i] + "%",
        draft[i] + "%",
        failedCounts ? "Unavailable" : r.counts[i],
      ]),
    );
    section("Existing members", "Existing members keep their assignment.");
    const single = draft.findIndex((v) => Number(v) === 100);
    section(
      "New members",
      single === -1
        ? "New members will be assigned from the proposed split."
        : "All new members will be assigned " + r.cohorts[single] + ".",
    );
    const error = el("p", undefined, "error");
    error.setAttribute("role", "alert");
    screen.append(error);
    actions(
      button(
        "Apply allocation",
        (event) => {
          if (failSave) {
            const stale = failSave === "stale";
            failSave = null;
            error.textContent = stale
              ? "The saved revision changed. Review the latest split before applying."
              : "Save failed. Your proposed split is still here.";
            if (stale) {
              event.currentTarget.disabled = true;
              r.weights = [...r.weights].reverse();
              actions(button("Review latest split", () => go(r.slug + "/edit")));
            }
            return;
          }
          r.weights = draft.map(Number);
          r.winner = null;
          r.phase = "Allocating";
          go(r.slug);
        },
        true,
      ),
      link("Back to edit", r.slug + "/edit", "button"),
    );
  }
  function confirm(r, action) {
    const winner = action === "winner",
      pause = action === "pause";
    heading(
      winner ? "Select winner" : pause ? "Pause experiment" : "Resume experiment",
      metadata(r),
    );
    let chosen = r.cohorts[0];
    if (winner) {
      const label = el("label", "Winning cohort "),
        select = el("select");
      label.append(select);
      screen.append(label);
      for (const c of r.cohorts) {
        const o = el("option", c);
        o.value = c;
        select.append(o);
      }
      select.onchange = () => {
        chosen = select.value;
        update();
      };
    }
    const effect = el("p", undefined, "section copy");
    const update = () => {
      effect.textContent = winner
        ? "Existing and new users will receive " +
          (chosen === "off" ? "the application default" : chosen) +
          ". Current memberships stay in storage."
        : pause
          ? "All users will receive the application default. The saved rollout and membership counts stay intact."
          : "Serving will resume from the saved phase and allocation.";
    };
    update();
    screen.append(effect);
    actions(
      button(
        winner ? "Confirm winner" : pause ? "Pause experiment" : "Resume experiment",
        () => {
          if (winner) {
            r.winner = chosen;
            r.phase = "Winner selected";
          } else r.enabled = !pause;
          go(r.slug);
        },
        true,
      ),
      cancelLink(r, winner ? "Select winner" : pause ? "Pause" : "Resume"),
    );
  }
  function render() {
    const [slug = "", view = ""] = location.hash.slice(1).split("/");
    screen.replaceChildren();
    crumb.replaceChildren(link("Experiments", ""));
    status.textContent = "";
    if (!slug && view === "create") create();
    else if (!slug) directory();
    else {
      const r = records.get(slug);
      if (!r) heading("Experiment unavailable");
      else {
        crumb.append(document.createTextNode("/"), link(displayName(r.slug), r.slug));
        const editable =
          canManage && r.enabled && ["Allocating", "Awaiting launch"].includes(r.phase);
        if (editable && (view === "edit" || view === "review")) {
          if (draftSlug !== slug) {
            draftSlug = slug;
            draft = view === "review" && slug === "checkout-copy" ? [0, 100, 0] : [...r.weights];
          }
          if (view === "review") review(r);
          else editor(r);
        } else if (
          canManage &&
          ((view === "pause" && r.enabled) ||
            (view === "resume" && !r.enabled) ||
            (view === "winner" && r.enabled && !r.winner))
        )
          confirm(r, view);
        else detail(r);
      }
    }
    const focusTarget = restoreFocus
      ? [...screen.querySelectorAll("button, a")].find((item) => item.textContent === restoreFocus)
      : undefined;
    (focusTarget ?? screen.querySelector("h1"))?.focus({ preventScroll: true });
    restoreFocus = undefined;
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", render);
  render();
})();
