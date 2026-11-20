import { hydrateRoot } from "react-dom/client";

import { App, type Bootstrap } from "./App";

const bootstrap: Bootstrap = JSON.parse(document.getElementById("data")!.textContent!);
hydrateRoot(document.getElementById("root")!, <App bootstrap={bootstrap} />);
