import { createRoot } from "react-dom/client";

import { ServingLedger } from "./src/components/generated/ServingLedger";

createRoot(document.getElementById("root")!).render(<ServingLedger />);
