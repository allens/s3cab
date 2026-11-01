<script setup>
import { defineAsyncComponent } from "vue";
import { data } from "./.vitepress/recording.data.mjs";
const Recording = defineAsyncComponent(() => import("./.vitepress/Recording.vue"));
</script>

<Recording :title="data.title" :cast="data.cast" />

<!--@include: ../README.md-->
