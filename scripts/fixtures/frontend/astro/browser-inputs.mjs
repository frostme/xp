import { writeFileSync } from "node:fs";

export function browserInputs() {
  return {
    name: "xp-browser-inputs",
    generateBundle(_, bundle) {
      if (this.environment?.name !== "client") return;
      const ids = Object.values(bundle).flatMap((entry) => Object.keys(entry.modules ?? {}));
      writeFileSync("browser-inputs.json", JSON.stringify(ids));
    },
  };
}
