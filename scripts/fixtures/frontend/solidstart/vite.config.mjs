import { solidStart } from "@solidjs/start/config";
import { nitro } from "nitro/vite";

import { auditBrowser } from "./fixture-shared/solid/audit.mjs";

export default {
  plugins: [
    solidStart({ ssr: true }),
    nitro(),
    { ...auditBrowser(), applyToEnvironment: (environment) => environment.name === "client" },
  ],
};
