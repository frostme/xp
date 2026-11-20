import type { InjectionKey } from "vue";
export const routeKey: InjectionKey<{ journey: boolean; slug: string; rotate(): void }> =
  Symbol("route");
