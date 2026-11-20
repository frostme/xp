<script setup lang="ts">
import { Cohort, useCohort } from "@frostme/xp/vue";
const state = useCohort();
</script>
<template>
  <span data-xp-status>{{ state.status }}</span>
  <span data-xp-slug>{{ state.slug }}</span>
  <span data-xp-error>{{ !!state.error }}</span>
  <button data-retry @click="state.refresh">Retry</button>
  <Cohort v-for="name in ['on', 'off', 'control', 'short', 'detailed']" :key="name" :slug="name"
    ><b data-xp-branch>{{ name }}</b></Cohort
  >
  <Cohort default><b data-xp-branch>default</b></Cohort>
</template>
