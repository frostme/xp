<script lang="ts">
  import type { LayoutProps } from "./$types";
  import { invalidate } from "$app/navigation";
  let { children, data }: LayoutProps = $props();
</script>
<header>{data.title}</header>
<button onclick={async () => { document.cookie = "viewer=other; Path=/"; await invalidate("account:revision"); }}>Rotate account</button>
<main>{@render children()}</main>
