<script setup lang="ts">
import { Experiment, Cohort } from "@frostme/xp/vue";
import { ref } from "vue";

import Decision from "./Decision.vue";
const selected = ref("initial");
</script>
<template>
  <section v-for="name in ['initial', 'guest', 'failed', 'missing']" :key="name" :id="name">
    <Experiment :slug="name">
      <template #loading><i>pending</i></template>
      <Decision />
    </Experiment>
  </section>
  <section id="reactive">
    <Experiment :slug="selected"><Decision /></Experiment>
  </section>
  <button id="retarget" @click="selected = 'guest'">Change experiment</button>
  <Cohort slug="initial_on"><small id="standalone">qualified match</small></Cohort>
</template>
