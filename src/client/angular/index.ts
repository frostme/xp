import {
  DestroyRef,
  Directive,
  Injectable,
  InjectionToken,
  Injector,
  TemplateRef,
  ViewContainerRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  makeEnvironmentProviders,
  runInInjectionContext,
  signal,
  untracked,
  type EnvironmentProviders,
  type Signal,
} from "@angular/core";
import { createXpSession, type CohortResult, type XpSessionOptions } from "@frostme/xp/client";

import { matchesGate, parseGate } from "#xp-gates";

export type { CohortResult } from "@frostme/xp/client";
export type XpAngularOptions = XpSessionOptions & { sessionKey?: string | number };
type Source = XpAngularOptions | (() => XpAngularOptions);

const OPTIONS = new InjectionToken<Source>("xp provider options");
const EXPERIMENT = new InjectionToken<Signal<string> | null>("xp enclosing experiment");

@Injectable()
export class XpDecisions {
  private readonly source = inject(OPTIONS);
  private readonly injector = inject(Injector);
  private readonly mounted = signal(false);

  // Select synchronously so descendants cannot see another account's decision.
  private readonly session = computed(() => {
    const source = this.source;
    const options =
      typeof source === "function" ? runInInjectionContext(this.injector, source) : source;
    const { loader, endpoint, experimentHost, sessionKey } = options;
    const previous = this.current;
    if (
      !previous ||
      previous.loader !== loader ||
      previous.endpoint !== endpoint ||
      previous.experimentHost !== experimentHost ||
      previous.sessionKey !== sessionKey
    ) {
      untracked(() => previous?.store.dispose());
      const store = createXpSession(previous ? { loader, endpoint, experimentHost } : options);
      this.current = { loader, endpoint, experimentHost, sessionKey, store };
      return store;
    }
    return previous.store;
  });
  private current?: Pick<
    XpAngularOptions,
    "loader" | "endpoint" | "experimentHost" | "sessionKey"
  > & {
    store: ReturnType<typeof createXpSession>;
  };

  constructor() {
    afterNextRender(() => this.mounted.set(true));
    inject(DestroyRef).onDestroy(() => this.current?.store.dispose());
  }

  /** Call during component/directive initialization so the caller owns the subscription. */
  cohort(slug?: string | (() => string)): Signal<CohortResult> {
    const context = slug === undefined ? inject(EXPERIMENT, { optional: true }) : null;
    const name = computed(() => {
      const value = typeof slug === "function" ? slug() : (slug ?? context?.());
      if (value === undefined) throw new Error("Provide a slug or an enclosing xpExperiment");
      return value;
    });
    const revision = signal(0);
    effect((onCleanup) => {
      if (!this.mounted()) return;
      const session = this.session();
      const experiment = name();
      onCleanup(
        untracked(() => session.subscribe(experiment, () => revision.update((n) => n + 1))),
      );
    });
    return computed(() => {
      revision();
      const session = this.session();
      const experiment = name();
      return { ...session.getSnapshot(experiment), refresh: () => session.refresh(experiment) };
    });
  }
}

export function provideXp(options: Source = {}): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: OPTIONS, useValue: options },
    { provide: EXPERIMENT, useValue: null },
    XpDecisions,
  ]);
}

@Directive({
  selector: "[xpProvider]",
  standalone: true,
  providers: [
    XpDecisions,
    { provide: OPTIONS, useFactory: () => inject(XpProvider).xpProvider },
    { provide: EXPERIMENT, useValue: null },
  ],
})
export class XpProvider {
  readonly xpProvider = input<XpAngularOptions>({});
}

@Directive({
  selector: "[xpExperiment]",
  standalone: true,
  providers: [{ provide: EXPERIMENT, useFactory: () => inject(XpExperiment).xpExperiment }],
})
export class XpExperiment {
  readonly xpExperiment = input.required<string>();

  constructor() {
    const decision = inject(XpDecisions).cohort(this.xpExperiment);
    effect(() => void decision());
  }
}

function renderWhen(matches: () => boolean) {
  const template = inject(TemplateRef);
  const views = inject(ViewContainerRef);
  effect(() => {
    const visible = matches();
    untracked(() => {
      if (visible && !views.length) views.createEmbeddedView(template);
      if (!visible && views.length) views.clear();
    });
  });
}

@Directive({ selector: "[xpCohort]", standalone: true })
export class XpCohort {
  readonly xpCohort = input.required<string>();
  constructor() {
    const context = inject(EXPERIMENT, { optional: true });
    const gate = computed(() => parseGate(context?.(), this.xpCohort()));
    const decision = inject(XpDecisions).cohort(() => gate().experiment);
    renderWhen(() => matchesGate(gate(), decision()));
  }
}

@Directive({ selector: "[xpDefault]", standalone: true })
export class XpDefault {
  constructor() {
    const context = inject(EXPERIMENT, { optional: true });
    const gate = computed(() => parseGate(context?.(), undefined, true));
    const decision = inject(XpDecisions).cohort(() => gate().experiment);
    renderWhen(() => matchesGate(gate(), decision()));
  }
}

@Directive({ selector: "[xpLoading]", standalone: true })
export class XpLoading {
  constructor() {
    const decision = inject(XpDecisions).cohort();
    renderWhen(() => decision().status === "loading");
  }
}
