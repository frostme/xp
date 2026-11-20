import { Component, inject, input, signal } from "@angular/core";
import {
  XpCohort,
  XpDecisions,
  XpDefault,
  XpExperiment,
  XpLoading,
  XpProvider,
  type XpAngularOptions,
} from "@frostme/xp/angular";

import { FixtureSession } from "./session";

@Component({ selector: "never-visible", template: "" })
class NeverVisible {
  constructor() {
    throw new Error("A hidden treatment was constructed");
  }
}

@Component({
  selector: "decision-card",
  imports: [XpExperiment, XpCohort, XpDefault, XpLoading, NeverVisible],
  template: `
    <section [xpExperiment]="slug()" [attr.data-card]="slug()">
      <span data-xp-status>{{ decision().status }}</span>
      <span data-xp-error>{{ decision().error !== null }}</span>
      <span data-xp-slug>{{ decision().slug }}</span>
      <span *xpLoading data-loading>pending</span>
      <span *xpCohort="'on'" data-xp-branch>on</span>
      <span *xpCohort="'off'" data-xp-branch>off</span>
      <span *xpCohort="'control'" data-xp-branch>control</span>
      <span *xpCohort="'short'" data-xp-branch>short</span>
      <span *xpCohort="'detailed'" data-xp-branch>detailed</span>
      <span *xpDefault data-xp-branch>default</span>
      <never-visible *xpCohort="'unused'" />
      <button (click)="decision().refresh()">Retry</button>
    </section>
  `,
})
class DecisionCard {
  readonly slug = input.required<string>();
  readonly decision = inject(XpDecisions).cohort(this.slug);
}

@Component({
  selector: "app-root",
  imports: [DecisionCard, XpProvider, XpCohort],
  template: `
    @if (journey) {
      <decision-card [slug]="journey" />
    } @else {
      <decision-card slug="banner" />
      <i *xpCohort="'banner_on'" data-duplicate>on</i>
      <decision-card slug="guest" />
      <decision-card slug="failed" />
      <decision-card [slug]="selected()" />
      <button id="retarget" (click)="selected.set('other')">Change experiment</button>
      <button id="graphql" (click)="host.graphql.set(true)">Use GraphQL</button>
      <button id="endpoint" (click)="host.path.set('/replacement')">Change endpoint</button>
      @if (nested()) {
        <aside [xpProvider]="options"><decision-card slug="nested" /></aside>
      }
      <button id="nested" (click)="nested.set(!nested())">Toggle nested provider</button>
      <span data-custom>{{ calls() }}</span
      ><span data-abort>{{ aborted() }}</span>
    }
    <button data-xp-switch (click)="host.revision.update(increment)">Switch account</button>
  `,
})
export class App {
  readonly host = inject(FixtureSession);
  readonly journey =
    this.host.url.pathname === "/journey"
      ? (this.host.url.searchParams.get("slug") ?? "delivery-copy")
      : null;
  readonly selected = signal("absent");
  readonly increment = (value: number) => value + 1;
  readonly nested = signal(false);
  readonly calls = signal(0);
  readonly aborted = signal(false);
  readonly options: XpAngularOptions = {
    loader: async (_slug, { signal }) => {
      this.calls.update((n) => n + 1);
      return new Promise((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            this.aborted.set(true);
            resolve("nested_on");
          },
          { once: true },
        ),
      );
    },
  };
}
