import type { XpBootstrap } from "../xp/options";
export default defineNuxtPlugin(async () => {
  const requestFetch = useRequestFetch();
  const { data } = await useAsyncData("session-bootstrap", () =>
    requestFetch<XpBootstrap>("/api/bootstrap"),
  );
  useState<XpBootstrap>("xp:bootstrap", () => ({})).value = data.value ?? {};
});
