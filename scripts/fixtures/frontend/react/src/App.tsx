import type { XpPreload } from "@frostme/xp/client";

import { Cohort, Experiment, useCohort } from "@frostme/xp/react";
import { useState } from "react";

import { AppXp } from "./xp/provider";

function Status() {
  const result = useCohort();
  return (
    <>
      <output>{result.status}</output>
      <button onClick={() => void result.refresh()}>Retry</button>
    </>
  );
}

export type Bootstrap = XpPreload & { sessionKey: string };

export function App({ bootstrap }: { bootstrap: Bootstrap }) {
  const [clicks, setClicks] = useState(0);
  return (
    <AppXp {...bootstrap}>
      {["offer", "guest", "failed", "missing"].map((slug) => (
        <section id={slug} key={slug}>
          <Experiment slug={slug} loading={<b>pending</b>}>
            <Cohort slug="on">
              <b>on</b>
            </Cohort>
            <Cohort slug="off">
              <b>off</b>
            </Cohort>
            <Cohort default>
              <b>default</b>
            </Cohort>
            <Status />
          </Experiment>
        </section>
      ))}
      <button id="interact" onClick={() => setClicks(clicks + 1)}>
        {clicks}
      </button>
    </AppXp>
  );
}
