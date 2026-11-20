import { createEffect, createSignal, onSettled, type Accessor, type Context } from "solid-js";

export function provider<T>(context: Context<T>) {
  return context;
}

export function watchMounted<T>(read: Accessor<T>, subscribe: (target: T) => () => void) {
  const [mounted, setMounted] = createSignal(false);
  onSettled(() => {
    setMounted(true);
  });
  createEffect(
    () => (mounted() ? { target: read() } : null),
    (current) => {
      if (current) return subscribe(current.target);
    },
  );
}
