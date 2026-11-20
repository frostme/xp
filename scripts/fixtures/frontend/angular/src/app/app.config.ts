import { type ApplicationConfig, Component, inject } from "@angular/core";
import { provideClientHydration } from "@angular/platform-browser";
import { provideRouter } from "@angular/router";

import { APP_XP_OPTIONS } from "../xp/providers";
import { FixtureSession } from "./session";

@Component({ template: "" })
class JourneyRoute {}

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter([
      { path: "", component: JourneyRoute },
      { path: "journey", component: JourneyRoute },
    ]),
    provideClientHydration(),
    { provide: APP_XP_OPTIONS, useFactory: () => inject(FixtureSession).options },
  ],
};
