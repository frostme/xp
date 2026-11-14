import type { ReactElement } from "react";

import { render as renderInk } from "ink";
import { PassThrough } from "node:stream";

const instances: { unmount(): void; cleanup(): void }[] = [];

/** Real Ink renderer with in-memory terminal streams; works with isolated package installs. */
export function render(element: ReactElement) {
  const stdout = Object.assign(new PassThrough(), { columns: 100, rows: 30, isTTY: true });
  const stderr = Object.assign(new PassThrough(), { columns: 100, rows: 30, isTTY: true });
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: (_value: boolean) => {},
    ref: () => {},
    unref: () => {},
  });
  const frames: string[] = [];
  stdout.on("data", (data) => frames.push(String(data)));
  const app = renderInk(element, {
    stdout,
    stderr,
    stdin,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  instances.push(app);
  return { stdin, frames, lastFrame: () => frames.at(-1), unmount: () => app.unmount() };
}

export function cleanup() {
  for (const app of instances.splice(0)) {
    app.unmount();
    app.cleanup();
  }
}
