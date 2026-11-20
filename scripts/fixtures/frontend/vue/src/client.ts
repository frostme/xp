import { makeApp } from "./universal";
makeApp(new URL(location.href), JSON.parse(document.querySelector("#preload")!.textContent!)).mount(
  "#app",
);
