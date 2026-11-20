import { hydrate } from "@solidjs/web";

import { App } from "../fixture-shared/solid/App";
const bootstrap = JSON.parse(document.getElementById("xp-data")!.textContent!);
hydrate(() => <App bootstrap={bootstrap} />, document.getElementById("app")!);
