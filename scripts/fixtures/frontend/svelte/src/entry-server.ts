import type { ComponentProps } from "svelte";

import { render } from "svelte/server";

import App from "./App.svelte";

export const renderApp = (props: ComponentProps<typeof App>) => render(App, { props });
