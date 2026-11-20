import type { FrontendProfile } from "./types";

import { react } from "./react";
import { vue, nuxt } from "./vue";

export const profiles: FrontendProfile[] = [react, vue, nuxt];
