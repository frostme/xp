import { createServer } from "node:http";

import { handler } from "./build/handler.js";
const server = createServer(handler);
server.listen(0, "127.0.0.1", () =>
  console.log("XP_ORIGIN=http://127.0.0.1:" + server.address().port),
);
