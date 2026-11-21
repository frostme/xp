import { useEffect, useRef, useState } from "react";

import "./ServingLedger.css";

type Phase = "Allocating" | "Awaiting launch" | "Winner selected" | "Legacy uniform";
type Action = "create" | "launch" | "adjust" | "pause" | "resume" | "finalize";
type Entry = {
  slug: string;
  phase: Phase;
  enabled: boolean;
  winner?: string;
  names: string[];
  weights: number[];
  counts: number[];
  revision: number;
};
const fixtures: Entry[] = [
  {
    slug: "checkout-copy",
    phase: "Allocating",
    enabled: true,
    names: ["off", "short", "detailed"],
    weights: [90, 5, 5],
    counts: [84, 11, 5],
    revision: 4,
  },
  {
    slug: "delivery-promise",
    phase: "Awaiting launch",
    enabled: true,
    winner: "off",
    names: ["off", "next-day-delivery-with-order-tracking"],
    weights: [100, 0],
    counts: [0, 0],
    revision: 1,
  },
  {
    slug: "address-hint",
    phase: "Allocating",
    enabled: false,
    names: ["off", "compact"],
    weights: [75, 25],
    counts: [23, 7],
    revision: 3,
  },
  {
    slug: "cart-recap",
    phase: "Winner selected",
    enabled: true,
    winner: "off",
    names: ["off", "compact"],
    weights: [50, 50],
    counts: [36, 28],
    revision: 5,
  },
  {
    slug: "existing-banner",
    phase: "Legacy uniform",
    enabled: true,
    names: ["control", "short"],
    weights: [50, 50],
    counts: [14, 21],
    revision: 1,
  },
];
const labels: Record<Action, string> = {
  create: "Create experiment",
  launch: "Launch rollout",
  adjust: "Adjust split",
  pause: "Pause serving",
  resume: "Resume serving",
  finalize: "Select winner",
};
const title = (slug: string) => slug.charAt(0).toUpperCase() + slug.slice(1).split("-").join(" ");
const total = (ns: number[]) => ns.reduce((a, b) => a + b, 0);
const params = new URLSearchParams(location.search);
function behavior(e: Entry) {
  if (!e.enabled)
    return ["Application default", "Serving is paused. New lookups create no memberships."];
  if (e.winner)
    return [
      e.winner === "off" && e.phase !== "Legacy uniform" ? "Application default" : e.winner,
      e.phase === "Awaiting launch"
        ? "The off control is pinned until launch. New lookups create no memberships."
        : "The selected winner overrides stored assignments for all visitors.",
    ];
  return [
    e.phase === "Legacy uniform" ? "Uniform assignment" : "Weighted assignment",
    "Returning members keep their cohort. New members are assigned using the split below.",
  ];
}
function phaseLabel(e: Entry) {
  return !e.enabled ? "Paused" : e.phase;
}
function Chips({ e }: { e: Entry }) {
  return (
    <div className="xp-chips">
      <span className={e.enabled ? "xp-enabled" : "xp-disabled"}>
        {e.enabled ? "Enabled" : "Paused"}
      </span>
      <span>{e.phase}</span>
    </div>
  );
}
export function ServingLedger() {
  const [entries, setEntries] = useState<Entry[]>(params.has("empty") ? [] : fixtures);
  const locationSlug = () =>
    location.hash
      ? decodeURIComponent(location.hash.slice(1))
      : params.has("empty")
        ? "directory"
        : "checkout-copy";
  const [selected, select] = useState(locationSlug);
  const [query, search] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  const [review, setReview] = useState(false);
  const [parts, setParts] = useState<string[]>([]);
  const [winner, setWinner] = useState("");
  const [slug, setSlug] = useState("");
  const [treatments, setTreatments] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [countsFailed, setCountsFailed] = useState(params.has("count-error"));
  const [stale, setStale] = useState(false);
  const fault = useRef(params.get("failure"));
  const dialog = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const entry = entries.find((e) => e.slug === selected);
  const manager = !params.has("viewer");
  const allowCreate = manager && !params.has("no-create");
  const rows = entries.filter((e) =>
    (e.slug + " " + title(e.slug)).toLowerCase().includes(query.trim().toLowerCase()),
  );
  const isSplit = action === "adjust" || action === "launch";
  const cap = action ? labels[action] : "";
  const basis = parts.map((p) => Math.round(Number(p) * 100));
  const sum = total(basis) / 100;
  useEffect(() => {
    const change = () => select(locationSlug());
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    if (action && !dialog.current?.open) dialog.current?.showModal();
  }, [action]);
  function navigate(next: string) {
    location.hash = encodeURIComponent(next);
    select(next);
    setNotice("");
    if (next !== "directory") requestAnimationFrame(() => detailHeading.current?.focus());
  }
  function open(a: Action) {
    returnTo.current = document.activeElement as HTMLElement;
    setReview(false);
    setError("");
    setStale(false);
    setSlug("");
    setTreatments("");
    setWinner(entry?.names[0] ?? "");
    setParts(entry?.weights.map(String) ?? []);
    setAction(a);
  }
  function close(saved = false) {
    dialog.current?.close();
    setAction(null);
    setReview(false);
    requestAnimationFrame(() => {
      if (saved || !returnTo.current?.isConnected) detailHeading.current?.focus();
      else returnTo.current?.focus();
    });
  }
  function commit() {
    if (!action) return;
    const names = treatments.split(",").map((s) => s.trim());
    const kebab = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
    if (
      action === "create" &&
      (!kebab.test(slug) ||
        names.some((n) => !kebab.test(n)) ||
        new Set(["off", ...names]).size !== names.length + 1 ||
        entries.some((e) => e.slug === slug))
    ) {
      setError(
        "Use a unique kebab-case slug and distinct treatment names. The off control is added for you.",
      );
      return;
    }
    if (
      isSplit &&
      (!parts.every((p) => /^\d+(\.\d{1,2})?$/.test(p)) ||
        basis.some((b) => b > 10000) ||
        total(basis) !== 10000)
    ) {
      setError("Enter each share with up to two decimals. The total must be 100%.");
      return;
    }
    if ((!review && isSplit) || (!review && action === "finalize")) {
      setReview(true);
      setError("");
      return;
    }
    if (fault.current) {
      const f = fault.current;
      fault.current = null;
      if (f === "stale" && entry && action !== "create") {
        setEntries(
          entries.map((e) => (e.slug === entry.slug ? { ...e, revision: e.revision + 1 } : e)),
        );
        setStale(true);
        setError(
          "Another operator saved a new revision. Review the current definition before saving.",
        );
        return;
      }
      setError("The save failed. Your entries are still here. Try saving again.");
      return;
    }
    let saved: Entry;
    if (action === "create") {
      saved = {
        slug,
        enabled: true,
        phase: "Awaiting launch",
        winner: "off",
        names: ["off", ...names],
        weights: [100, ...names.map(() => 0)],
        counts: names.map(() => 0).concat(0),
        revision: 1,
      };
      setEntries([...entries, saved]);
      navigate(slug);
    } else {
      if (!entry) return;
      saved = { ...entry, revision: entry.revision + 1 };
      if (isSplit)
        Object.assign(saved, {
          phase: "Allocating",
          weights: basis.map((b) => b / 100),
          winner: undefined,
        });
      if (action === "pause" || action === "resume") saved.enabled = action === "resume";
      if (action === "finalize") {
        saved.winner = winner;
        if (saved.phase !== "Legacy uniform") saved.phase = "Winner selected";
      }
      setEntries(entries.map((e) => (e.slug === entry.slug ? saved : e)));
    }
    close(true);
    setNotice("Saved " + saved.slug + " · revision " + saved.revision + ".");
  }
  const sidebar = (
    <aside
      className={"xp-rail " + (selected === "directory" ? "xp-rail-open" : "")}
      aria-label="Experiment directory"
    >
      <div className="xp-rail-head">
        <h2>Directory</h2>
        <span>{entries.length}</span>
      </div>
      <input
        className="xp-search"
        aria-label="Search experiments"
        placeholder="Search experiments"
        value={query}
        onChange={(e) => search(e.target.value)}
      />
      <nav aria-label="Experiments">
        {rows.map((e) => (
          <a
            key={e.slug}
            href={"#" + e.slug}
            onClick={(ev) => {
              ev.preventDefault();
              navigate(e.slug);
            }}
            aria-current={selected === e.slug ? "page" : undefined}
          >
            <strong>{title(e.slug)}</strong>
            <small>{phaseLabel(e)}</small>
          </a>
        ))}
      </nav>
      {rows.length === 0 && <p>{query ? "No matching experiments." : "No experiments yet."}</p>}
      {allowCreate && (
        <button className="xp-create" onClick={() => open("create")}>
          + Create experiment
        </button>
      )}
    </aside>
  );
  return (
    <div className="xp-ledger">
      <header className="xp-mast">
        <span className="xp-wordmark">xp</span>
        <span>Experiments</span>
        <span className="xp-access">{manager ? "Manage access" : "View access"}</span>
      </header>
      <div className="xp-workspace">
        {sidebar}
        <main className={selected === "directory" ? "xp-main xp-directory" : "xp-main"}>
          {entry ? (
            <>
              <a
                className="xp-back"
                href="#directory"
                onClick={(e) => {
                  e.preventDefault();
                  navigate("directory");
                }}
              >
                ← All experiments
              </a>
              <div className="xp-title">
                <div>
                  <p className="xp-slug">{entry.slug}</p>
                  <h1 tabIndex={-1} ref={detailHeading}>
                    {title(entry.slug)}
                  </h1>
                </div>
                <Chips e={entry} />
              </div>
              <section className="xp-serving">
                <p>Serving now</p>
                <h2>{behavior(entry)[0]}</h2>
                <span>{behavior(entry)[1]}</span>
              </section>
              <section aria-labelledby="cohorts-heading">
                <div className="xp-section-head">
                  <h2 id="cohorts-heading">Cohorts</h2>
                  <span>Revision {entry.revision}</span>
                </div>
                <div className="xp-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Cohort</th>
                        <th scope="col">
                          {entry.winner || !entry.enabled ? "Saved split" : "New assignment share"}
                        </th>
                        <th scope="col">Current memberships</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entry.names.map((name, i) => (
                        <tr key={name}>
                          <th scope="row">
                            <span>{name}</span>
                            <small>{i === 0 ? "Control" : "Treatment"}</small>
                          </th>
                          <td>
                            <div className="xp-share">
                              <span>{entry.weights[i]}%</span>
                              <i aria-hidden="true">
                                <b style={{ width: entry.weights[i] + "%" }} />
                              </i>
                            </div>
                          </td>
                          <td>{countsFailed ? "Unavailable" : entry.counts[i]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {countsFailed && (
                  <p role="alert">
                    Could not read memberships.{" "}
                    <button onClick={() => setCountsFailed(false)}>Retry counts</button>
                  </p>
                )}
              </section>
              {manager && (
                <div className="xp-actions">
                  {entry.enabled &&
                    (entry.phase === "Allocating" || entry.phase === "Awaiting launch") && (
                      <button
                        className="xp-primary"
                        onClick={() => open(entry.phase === "Allocating" ? "adjust" : "launch")}
                      >
                        {entry.phase === "Allocating" ? "Adjust split" : "Launch rollout"}
                      </button>
                    )}
                  <button onClick={() => open(entry.enabled ? "pause" : "resume")}>
                    {entry.enabled ? "Pause serving" : "Resume serving"}
                  </button>
                  {entry.enabled &&
                    (entry.phase === "Allocating" ||
                      (entry.phase === "Legacy uniform" && !entry.winner)) && (
                      <button onClick={() => open("finalize")}>Select winner</button>
                    )}
                </div>
              )}
            </>
          ) : selected !== "directory" ? (
            <>
              <h1>Experiment not found</h1>
              <a href="#directory">Return to directory</a>
            </>
          ) : (
            <>
              <h1>Experiments</h1>
              <p>
                {entries.length
                  ? "Select an experiment from the directory."
                  : "Create an experiment to review its rollout."}
              </p>
            </>
          )}
          <p className="xp-notice" role="status">
            {notice}
          </p>
        </main>
      </div>
      {action && (
        <dialog
          ref={dialog}
          aria-labelledby="xp-dialog-title"
          onCancel={(e) => {
            e.preventDefault();
            close();
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              commit();
            }}
          >
            <p className="xp-slug">
              {action === "create"
                ? "New definition"
                : entry?.slug + " · revision " + entry?.revision}
            </p>
            <h2 id="xp-dialog-title">{review ? "Review changes" : cap}</h2>
            {action === "create" && (
              <>
                <label>
                  Experiment slug
                  <input
                    required
                    value={slug}
                    onChange={(e) => setSlug(e.target.value)}
                    placeholder="checkout-copy"
                  />
                </label>
                <label>
                  Treatments, separated by commas
                  <input
                    required
                    value={treatments}
                    onChange={(e) => setTreatments(e.target.value)}
                    placeholder="short, detailed"
                  />
                </label>
                <p>
                  The off control starts pinned at 100%. Visitors receive the application default
                  until launch.
                </p>
              </>
            )}
            {isSplit && (
              <>
                <div className="xp-edit-head">
                  <span>Cohort</span>
                  <span>{review ? "Proposed" : "New share"}</span>
                </div>
                {entry?.names.map((name, i) => (
                  <label className="xp-split" key={name}>
                    <span>
                      {name}
                      <small>Saved {entry.weights[i]}%</small>
                    </span>
                    {review ? (
                      <b>{parts[i]}%</b>
                    ) : (
                      <input
                        aria-label={name + " percentage"}
                        required
                        inputMode="decimal"
                        value={parts[i]}
                        onChange={(e) =>
                          setParts(parts.map((p, j) => (j === i ? e.target.value : p)))
                        }
                      />
                    )}
                  </label>
                ))}
                <p className="xp-total">
                  Total <b>{Number.isFinite(sum) ? sum : "—"}%</b>
                </p>
                <p>New members receive the proposed split. Existing members keep their cohort.</p>
              </>
            )}
            {action === "finalize" && (
              <>
                <label>
                  Winning cohort
                  {review ? (
                    <strong>{winner}</strong>
                  ) : (
                    <select value={winner} onChange={(e) => setWinner(e.target.value)}>
                      {entry?.names.map((n) => (
                        <option key={n}>{n}</option>
                      ))}
                    </select>
                  )}
                </label>
                <p>
                  Existing and new visitors receive{" "}
                  {winner === "off" && entry?.phase !== "Legacy uniform"
                    ? "the application default"
                    : winner}
                  . Current membership counts stay in storage.
                </p>
              </>
            )}
            {action === "pause" && (
              <p>
                Existing and new visitors receive the application default. Current memberships and
                the saved rollout are preserved.
              </p>
            )}
            {action === "resume" && entry && (
              <p>
                Serving resumes with {behavior({ ...entry, enabled: true })[0].toLowerCase()}.
                Existing memberships are preserved.
              </p>
            )}
            {error && (
              <p className="xp-error" role="alert">
                {error}
              </p>
            )}
            <div className="xp-dialog-actions">
              <button type="button" onClick={() => close()}>
                Cancel
              </button>
              {stale ? (
                <button
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    setStale(false);
                    setReview(false);
                    setError("Current revision loaded. Review your proposal before saving.");
                  }}
                >
                  Review latest
                </button>
              ) : (
                <button className="xp-primary">
                  {!review && (isSplit || action === "finalize") ? "Review changes" : cap}
                </button>
              )}
            </div>
          </form>
        </dialog>
      )}
    </div>
  );
}
