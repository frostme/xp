import solid from "@solidjs/vite-plugin";

import { auditBrowser } from "./fixture-shared/solid/audit.mjs";
export default ({ isSsrBuild }) => ({
  plugins: [solid({ ssr: true }), ...(!isSsrBuild ? [auditBrowser()] : [])],
  build: {
    minify: false,
    ...(!isSsrBuild && { rolldownOptions: { input: { index: "index.html", csr: "csr.html" } } }),
  },
});
