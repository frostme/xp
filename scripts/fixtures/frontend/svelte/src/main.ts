import { hydrate } from "svelte";

import App from "./App.svelte";

const props = JSON.parse(document.querySelector("#bootstrap")!.textContent!);
hydrate(App, { target: document.querySelector("#app")!, props });
