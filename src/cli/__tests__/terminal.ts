import type { ReactElement } from "react";

import { render as renderInk } from "ink";
import { PassThrough } from "node:stream";
import { act } from "react";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const instances: { unmount(): void; cleanup(): void }[] = [];

/** Real Ink renderer with in-memory terminal streams; works with isolated package installs. */
export async function render(element: ReactElement, dimensions = { columns: 100, rows: 30 }) {
  const stdout = Object.assign(new PassThrough(), { ...dimensions, isTTY: true });
  const stderr = Object.assign(new PassThrough(), { ...dimensions, isTTY: true });
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode: (_value: boolean) => {},
    ref: () => {},
    unref: () => {},
  });
  const frames: string[] = [];
  stdout.on("data", (data) => frames.push(String(data)));
  let app!: ReturnType<typeof renderInk>;
  await act(async () => {
    app = renderInk(element, {
      stdout,
      stderr,
      stdin,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });
  });
  instances.push(app);
  return {
    stdin,
    frames,
    async input(value: string) {
      await act(async () => {
        stdin.write(value);
        await app.waitUntilRenderFlush();
        // A standalone Escape is buffered by Ink while it waits for a possible
        // ANSI sequence. This delay is for that parser, not React scheduling.
        if (value === "\u001b") await new Promise((resolve) => setTimeout(resolve, 20));
      });
    },
    async resize(columns: number, rows: number) {
      await act(async () => {
        stdout.columns = columns;
        stdout.rows = rows;
        stdout.emit("resize");
      });
    },
    lastFrame: () => frames.at(-1),
    unmount: () => app.unmount(),
  };
}

export async function cleanup() {
  await act(async () => {
    for (const app of instances.splice(0)) {
      app.unmount();
      app.cleanup();
    }
  });
}
