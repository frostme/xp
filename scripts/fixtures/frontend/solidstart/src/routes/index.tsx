import { A } from "@solidjs/router";

import { Results } from "../../fixture-shared/solid/App";

export default function Home() {
  return (
    <>
      <Results />
      <A href="/next">Next experiment</A>
    </>
  );
}
