import {
  $,
  actionLink,
  announce,
  base,
  button,
  cell,
  detailUrl,
  errorText,
  heading,
  history,
  location,
  main,
  request,
  text,
} from "./common.js";
import { availability, phaseLabel, serving } from "./serving.js";

const { AbortController, URL, URLSearchParams, clearTimeout, setTimeout } = globalThis;

export function directory(mayCreate) {
  const current = new URL(location.href);
  let query = current.searchParams.get("q") || "";
  let cursors = history.state?.query === query ? history.state.cursors : [null];
  let nextCursor;
  let controller;
  let timer;
  main.innerHTML =
    heading(
      "Experiments",
      "",
      mayCreate ? actionLink("Create experiment", base + "/create", true) : "",
    ) +
    '<label class="field">Find an experiment<input id="search" type="search" maxlength="256" placeholder="Name or slug"></label><div id="results"></div>';
  const input = $("#search");
  const results = $("#results");
  input.value = query;
  async function load(returnFocus = false) {
    controller?.abort();
    const task = new AbortController();
    controller = task;
    const params = new URLSearchParams({ q: query, limit: "25" });
    const cursor = cursors.at(-1);
    if (cursor) params.set("cursor", cursor);
    results.setAttribute("aria-busy", "true");
    results.innerHTML = "<p>Loading experiments…</p>";
    try {
      const { data } = await request("/api/experiments?" + params, { signal: task.signal });
      if (task.signal.aborted) return;
      nextCursor = data.nextCursor;
      const rows = data.items
        .map(
          (r) =>
            `<tr><th scope="row"><a class="dir-name" href="${text(detailUrl(r.slug))}">${text(r.name)}</a><code>${text(r.slug)}</code></th>${cell("Availability", availability(r))}${cell("Phase", text(phaseLabel(r)))}${cell("Serving now", text(serving(r)))}</tr>`,
        )
        .join("");
      const empty =
        nextCursor || cursor
          ? "No matching experiments on this page."
          : query
            ? "No experiments match this search."
            : "There are no experiments in this installation.";
      results.innerHTML =
        (rows
          ? '<table class="dir"><thead><tr><th>Experiment</th><th>Availability</th><th>Phase</th><th>Serving now</th></tr></thead><tbody>' +
            rows +
            "</tbody></table>"
          : "<p>" + empty + "</p>") +
        (rows || cursor || nextCursor
          ? `<div class="page-nav"><small>Page ${cursors.length}</small>${cursors.length > 1 ? button("Previous", "previous") : ""}${nextCursor ? button("Next", "next") : ""}</div>`
          : "");
      announce(
        rows
          ? data.items.length +
              (data.items.length === 1 ? " experiment" : " experiments") +
              " on page " +
              cursors.length +
              "."
          : empty,
      );
      if (returnFocus) input.focus();
    } catch (error) {
      if (task.signal.aborted) return;
      results.innerHTML =
        '<p class="alert" role="alert">' +
        text(errorText(error)) +
        "</p>" +
        button("Retry", "retry") +
        (cursor ? button("Restart search", "restart") : "");
    } finally {
      if (!task.signal.aborted) results.removeAttribute("aria-busy");
    }
  }
  function rememberPage() {
    if (query) current.searchParams.set("q", query);
    else current.searchParams.delete("q");
    history.replaceState({ query, cursors }, "", current);
  }
  input.oninput = () => {
    clearTimeout(timer);
    controller?.abort();
    query = input.value;
    cursors = [null];
    rememberPage();
    results.setAttribute("aria-busy", "true");
    results.textContent = "Loading experiments…";
    timer = setTimeout(() => load(), 180);
  };
  results.onclick = (event) => {
    const command = event.target.closest("button")?.dataset.command;
    if (!command) return;
    if (command === "next") cursors.push(nextCursor);
    if (command === "previous") cursors.pop();
    if (command === "restart") cursors = [null];
    rememberPage();
    void load(true);
  };
  void load();
}
