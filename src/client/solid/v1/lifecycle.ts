import { createEffect, onCleanup, onMount, type Accessor, type Context } from "solid-js";

export function provider<T>(context: Context<T>) {
  return context.Provider;
}

export function watchMounted<T>(read: Accessor<T>, subscribe: (target: T) => () => void) {
  onMount(() => {
    createEffect(() => onCleanup(subscribe(read())));
  });
}
