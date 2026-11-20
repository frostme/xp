import type { AstroComponentFactory } from "astro/runtime/server/index.js";

import type { createXpRequest } from "../index.js";

/** Add this interface to App.Locals after registering the xp request middleware. */
export interface XpLocals {
  xp: ReturnType<typeof createXpRequest>;
}

export type AstroCohortProps =
  | { experiment?: string; slug: string; default?: false }
  | { experiment: string; default: true; slug?: never };

export declare function Experiment(props: { slug: string }): ReturnType<AstroComponentFactory>;
export declare function Cohort(props: AstroCohortProps): ReturnType<AstroComponentFactory>;
