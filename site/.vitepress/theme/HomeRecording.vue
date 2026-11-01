<script setup>
import Recording from "../Recording.vue";
import { data } from "../recording.data.mjs";
</script>

<template>
  <Recording :title="data.title" :cast="data.cast" />
</template>
