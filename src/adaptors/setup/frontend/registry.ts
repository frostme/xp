import type { FrontendProfile } from "./types";

import { angular } from "./angular";
import { react } from "./react";
import { svelte, sveltekit } from "./svelte";
import { vue, nuxt } from "./vue";

export const profiles: FrontendProfile[] = [react, vue, nuxt, angular, svelte, sveltekit];
