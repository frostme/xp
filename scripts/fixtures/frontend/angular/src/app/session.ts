import type { XpAngularOptions } from "@frostme/xp/angular";

import { DOCUMENT, Injectable, inject, signal, REQUEST } from "@angular/core";

@Injectable({ providedIn: "root" })
export class FixtureSession {
  readonly url = new URL(inject(REQUEST)?.url ?? inject(DOCUMENT).location.href);
  readonly revision = signal(0);
  readonly path = signal("");
  readonly graphql = signal(false);
  readonly options = (): XpAngularOptions => ({
    ...(this.revision() ? { sessionKey: "next-" + this.revision() } : {}),
    ...(this.graphql() ? { loader: "graphql" as const, endpoint: "/graphql-test" } : {}),
    ...(this.path() ? { endpoint: this.path() } : {}),
  });
}
