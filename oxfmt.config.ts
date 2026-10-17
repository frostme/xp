import { defineConfig } from "oxfmt";

export default defineConfig({
  printWidth: 100,
  embeddedLanguageFormatting: "auto",
  ignorePatterns: ["dist", ".cache", "out", ".swc", ".wireit", ".vitest"],
  sortImports: {
    groups: [
      "type-import",
      ["value-builtin", "value-external"],
      "type-internal",
      "value-internal",
      ["type-parent", "type-sibling", "type-index"],
      ["value-parent", "value-sibling", "value-index"],
      "unknown",
    ],
  },
});
