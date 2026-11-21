import {
  $,
  cell,
  detailUrl,
  directoryUrl,
  errorText,
  heading,
  localName,
  main,
  request,
  text,
} from "./common.js";

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function createForm(openCreated) {
  main.innerHTML =
    heading("Create experiment") +
    `<form class="creation" novalidate>
<label class="field">Experiment slug<input name="slug" required aria-describedby="slug-guide"><span id="slug-guide">Use lowercase words joined by hyphens.</span></label>
<label class="field">Treatments<input name="names" required aria-describedby="names-guide"><span id="names-guide">Separate treatment names with commas. xp adds the off control.</span></label>
<p>Off is pinned at 100% until launch. Visitors receive the application default.</p><p class="alert" id="invalid" role="alert"></p><div class="actions"><button class="primary">Create experiment</button><a href="${text(directoryUrl)}">Cancel</a></div></form>`;
  const form = $("form", main);
  const slug = form.elements.slug;
  const names = form.elements.names;
  const submit = $("button", form);
  const problem = $("#invalid", form);
  function invalid(input, message) {
    problem.textContent = message;
    if (!input) return;
    input.setAttribute("aria-invalid", "true");
    input.setAttribute(
      "aria-describedby",
      (input === slug ? "slug-guide" : "names-guide") + " invalid",
    );
    input.focus();
  }
  form.oninput = (event) => {
    event.target.removeAttribute("aria-invalid");
    problem.textContent = "";
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const name = slug.value.trim();
    const treatments = names.value.split(",").map((v) => v.trim());
    if (!slugPattern.test(name))
      return invalid(slug, "Enter a lowercase kebab-case experiment slug.");
    if (
      !treatments.every((v) => slugPattern.test(v) && v !== "off") ||
      new Set(treatments).size !== treatments.length
    )
      return invalid(
        names,
        "Enter distinct treatment names. The off control is included automatically.",
      );
    submit.disabled = true;
    submit.textContent = "Creating…";
    problem.textContent = "";
    try {
      const { data } = await request("/api/experiments", {
        body: { slug: name, cohorts: treatments },
      });
      await openCreated(data.slug);
    } catch (error) {
      const item = error.fields?.[0];
      const field =
        error.status === 409 || item?.field?.includes(".slug")
          ? slug
          : item?.field?.includes(".cohorts")
            ? names
            : null;
      invalid(field, item?.message || errorText(error));
    } finally {
      submit.disabled = false;
      submit.textContent = "Create experiment";
    }
  };
}

function basis(input) {
  return /^\d+(\.\d{1,2})?$/.test(input) && Number(input) <= 100
    ? Math.round(Number(input) * 100)
    : NaN;
}
export function splitForm(record, draft, onReview, unavailable = "") {
  const launch = record.actions.includes("launch");
  const rows = record.cohorts
    .map(
      (c, i) =>
        `<tr><th scope="row"><code>${text(localName(record, c.slug))}</code></th>${cell("Saved split", text(c.percentage) + "%", "num")}${cell("Proposed split", `<input class="weight" inputmode="decimal" aria-label="Proposed percentage for ${text(localName(record, c.slug))}" aria-describedby="invalid" data-index="${i}" value="${text(draft?.get(c.slug) ?? c.percentage)}">`, "num")}</tr>`,
    )
    .join("");
  main.innerHTML =
    '<div class="editor">' +
    heading(launch ? "Launch rollout" : "Adjust split", record.slug) +
    `<form><table class="stacked"><thead><tr><th>Cohort</th><th class="num">Saved split</th><th class="num">Proposed split (%)</th></tr></thead><tbody>${rows}</tbody></table>
<p class="total">Proposed total <output></output></p><p id="invalid" class="alert" role="alert">${text(unavailable)}</p><div class="actions"><button class="primary"${unavailable ? " disabled" : ""}>Review split</button><a href="${text(detailUrl(record.slug))}">Cancel</a></div></form></div>`;
  const form = $("form", main);
  const inputs = Array.from(form.querySelectorAll(".weight"));
  const problem = $("#invalid");
  const sum = () => inputs.reduce((total, input) => total + basis(input.value.trim()), 0);
  function update() {
    const total = sum();
    $("output", form).value = Number.isFinite(total) ? total / 100 + "%" : "Incomplete";
  }
  update();
  form.oninput = (event) => {
    event.target.removeAttribute("aria-invalid");
    if (!unavailable) problem.textContent = "";
    update();
  };
  form.onsubmit = (event) => {
    event.preventDefault();
    if (unavailable) return;
    const first = inputs.find((input) => !Number.isFinite(basis(input.value.trim())));
    if (first) {
      first.setAttribute("aria-invalid", "true");
      problem.textContent = "Enter a percentage from 0 to 100 with up to two decimal places.";
      first.focus();
      return;
    }
    if (sum() !== 10000) {
      problem.textContent = "The proposed split must total 100%.";
      inputs[0]?.focus();
      return;
    }
    problem.textContent = "";
    const proposed = new Map(record.cohorts.map((c, i) => [c.slug, inputs[i].value]));
    const allocation = record.cohorts.map((c, i) => ({
      cohort: c.slug,
      percentage: basis(inputs[i].value.trim()) / 100,
    }));
    onReview(launch ? "launch" : "adjust", allocation, proposed, event.submitter);
  };
}
