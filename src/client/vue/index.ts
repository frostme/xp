import {
  computed,
  defineComponent,
  inject,
  onMounted,
  onScopeDispose,
  provide,
  shallowRef,
  toValue,
  watch,
  type ComputedRef,
  type InjectionKey,
  type MaybeRefOrGetter,
  type PropType,
  type Ref,
} from "vue";

import type { XpPreload } from "../preload";

import { isSlugPart } from "../../entities/slug";
import { matchesGate, parseGate } from "../gates";
import {
  createXpSession,
  type CohortResult,
  type XpSession,
  type XpSessionOptions,
} from "../session";

const sessions: InjectionKey<Readonly<Ref<XpSession>>> = Symbol("xp session");
const experiments: InjectionKey<Readonly<Ref<string>> | null> = Symbol("xp experiment");

export const XPProvider = defineComponent({
  name: "XPProvider",
  props: {
    sessionKey: [String, Number],
    loader: [String, Function] as PropType<NonNullable<XpSessionOptions["loader"]>>,
    endpoint: String,
    experimentHost: String,
    initialAssignments: Object as PropType<XpPreload["initialAssignments"]>,
    initialErrors: Array as PropType<XpPreload["initialErrors"]>,
  },
  setup(props, { slots }) {
    function start(preloaded: boolean) {
      return createXpSession({
        ...(props.loader !== undefined && { loader: props.loader }),
        ...(props.endpoint !== undefined && { endpoint: props.endpoint }),
        ...(props.experimentHost !== undefined && { experimentHost: props.experimentHost }),
        ...(preloaded &&
          props.initialAssignments && { initialAssignments: props.initialAssignments }),
        ...(preloaded && props.initialErrors && { initialErrors: props.initialErrors }),
      });
    }
    const session = shallowRef(start(true));
    watch(
      [
        () => props.sessionKey,
        () => props.loader,
        () => props.endpoint,
        () => props.experimentHost,
      ],
      () => {
        session.value.dispose();
        session.value = start(false);
      },
    );
    provide(sessions, session);
    provide(experiments, null);
    onScopeDispose(() => session.value.dispose());
    return () => slots["default"]?.();
  },
});

/** Read a stable decision during SSR, then subscribe to its session and slug after hydration. */
export function useCohort(slug?: MaybeRefOrGetter<string>): ComputedRef<CohortResult> {
  const session = inject(sessions);
  if (!session) throw new Error("useCohort requires an XPProvider");
  const enclosing = inject(experiments, null);
  const target = computed(() => {
    const value = slug === undefined ? enclosing?.value : toValue(slug);
    if (!isSlugPart(value))
      throw new Error("Provide a kebab-case experiment slug or an enclosing Experiment");
    return value;
  });
  const revision = shallowRef(0);
  const refresh = () => session.value.refresh(target.value);
  onMounted(() => {
    watch(
      [session, target],
      ([store, name], _, cleanup) => {
        cleanup(
          store.subscribe(name, () => {
            revision.value++;
          }),
        );
        // Another mounted subscriber may have started work first.
        revision.value++;
      },
      { immediate: true, flush: "sync" },
    );
  });
  return computed(() => {
    void revision.value;
    return { ...session.value.getSnapshot(target.value), refresh };
  });
}

export const Experiment = defineComponent({
  name: "Experiment",
  props: { slug: { type: String, required: true } },
  setup(props, { slots }) {
    const slug = computed(() => props.slug);
    const state = useCohort(slug);
    provide(experiments, slug);
    return () => [state.value.status === "loading" && slots["loading"]?.(), slots["default"]?.()];
  },
});

export const Cohort = defineComponent({
  name: "Cohort",
  props: { slug: String, default: Boolean },
  setup(props, { slots }) {
    const enclosing = inject(experiments, null);
    const gate = computed(() => parseGate(enclosing?.value, props.slug, props.default));
    const state = useCohort(() => gate.value.experiment);
    return () => (matchesGate(gate.value, state.value) ? slots["default"]?.() : null);
  },
});
