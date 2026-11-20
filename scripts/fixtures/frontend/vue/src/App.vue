<script setup lang="ts">
import { Experiment } from "@frostme/xp/vue";
import { inject } from "vue";

import Decision from "../fixture-shared/vue/Decision.vue";
import Gallery from "../fixture-shared/vue/Gallery.vue";
import { routeKey } from "./route";
const route = inject(routeKey);
</script>
<template>
  <main v-if="route?.journey">
    <Experiment :slug="route.slug"><Decision /></Experiment>
    <button data-xp-switch @click="route.rotate">Switch session</button>
  </main>
  <Gallery v-else />
</template>
