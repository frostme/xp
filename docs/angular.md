# Angular standalone applications

Install Angular core 22.3 or later in the 22.x line and import Angular bindings from `@frostme/xp/angular`. The package ships partial-compiled ESM and Angular declarations. The project's Angular compiler links the adapter when building the application.

From the Angular application directory, preview and apply a standalone registration.

```sh
xp setup --scope frontend --frontend angular --transport graphql --endpoint /graphql --dry-run
xp setup --scope frontend --frontend angular --transport graphql --endpoint /graphql --non-interactive --yes
```

Setup appends `provideAppXp()` to a recognized `ApplicationConfig.providers` or inline bootstrap config. With a shared server configuration, it follows the imports from both bootstrap files. For a custom bootstrap, import `provideAppXp` from the generated `src/xp/providers.ts` and add it to the application config used by both roots. Keep your existing hydration provider. The generated `src/xp/checkout-example.ts` exports a standalone component for a seeded `checkout-banner` experiment.

```ts
import { Component, inject } from "@angular/core";
import { XpCohort, XpDecisions, XpDefault, XpExperiment, XpLoading } from "@frostme/xp/angular";

@Component({
  selector: "shop-checkout",
  imports: [XpExperiment, XpCohort, XpDefault, XpLoading],
  template: `
    <section xpExperiment="checkout-banner">
      <span *xpLoading>Checking…</span>
      <strong *xpCohort="'on'">New checkout</strong>
      <span *xpDefault>Standard checkout</span>
    </section>
    <button (click)="decision().refresh()">Retry</button>
  `,
})
export class ShopCheckout {
  readonly decision = inject(XpDecisions).cohort("checkout-banner");
}
```

Create the decision signal in a component or directive initializer. Pass an Angular signal or getter for a changing experiment name. Within an experiment, `cohort()` reads the nearest boundary. A standalone gate uses a qualified name, such as `*xpCohort="'checkout-banner_on'"`. Structural templates instantiate the selected branches. The default is visible for an explicit null or failure. The signal exposes `status`, `slug`, `error` and `refresh()`.

Without setup, add `provideXp({ loader: "graphql", endpoint: "/graphql" })` to the standalone application providers. For reactive account and endpoint changes, pass a getter that reads signals. With generated setup, register the exported `APP_XP_OPTIONS` token in the host application's config. Its value is a getter returning your app's `sessionKey`, `loader`, `endpoint` or `experimentHost` overrides. A new opaque session revision discards the previous account's decisions. To scope a subtree independently, import the standalone `XpProvider` directive and bind options with `<section [xpProvider]="accountOptions()">…</section>`.

## Authenticated SSR and hydration

After authenticating a request, create a request-local loader and preload the experiments needed for this route. With Angular's Node SSR engine, pass public data as the second argument to `handle`.

```ts
const decisions = createXpRequest(async (slug) => (await xp.resolveCohort(account?.id, slug)).slug);
const preload = await decisions.preload(["checkout-banner"]);
const response = await angularApp.handle(req, { ...preload, sessionKey: publicSessionRevision });
response?.headers.set("Cache-Control", "private, no-store");
```

In the app's server configuration, use the generated helper to transfer those decisions with Angular's `TransferState`.

```ts
import type { XpPreload } from "@frostme/xp/client";

import { REQUEST_CONTEXT, inject } from "@angular/core";

import { provideAppXpPreload } from "../xp/providers";

// Append this provider to the request's existing server config.
const decisionsProvider = provideAppXpPreload(
  () => inject(REQUEST_CONTEXT) as XpPreload & { sessionKey: string },
);
```

The browser reads the public state during its first render. Preloaded assignments, nulls and sanitized failures make zero decision requests until refresh. An absent decision renders the loading template until a mounted subscriber resolves it. A static application can omit the request preload and use the same pending-first behavior. The server authenticates the request independently on every REST or GraphQL call.
