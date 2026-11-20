import type { XpPreload } from "@frostme/xp/client";

import {
  mergeApplicationConfig,
  inject,
  REQUEST_CONTEXT,
  type ApplicationConfig,
} from "@angular/core";
import { provideServerRendering, RenderMode, withRoutes } from "@angular/ssr";

import { provideAppXpPreload } from "../xp/providers";
import { appConfig } from "./app.config";

const serverConfig: ApplicationConfig = {
  providers: [
    provideServerRendering(withRoutes([{ path: "**", renderMode: RenderMode.Server }])),
    provideAppXpPreload(() => inject(REQUEST_CONTEXT) as XpPreload & { sessionKey: string }),
  ],
};
export const config = mergeApplicationConfig(appConfig, serverConfig);
