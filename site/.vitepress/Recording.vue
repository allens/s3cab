<script setup>
// Plays a cast (cast.mjs) as plain text. Not asciinema-player: what s3cab
// prints to a pipe has no colour and no cursor movement, so there is no escape
// code to interpret and no terminal emulator worth bundling.
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef } from "vue";

const props = defineProps({
  title: { type: String, required: true },
  cast: { type: String, required: true },
});

const [header, ...events] = props.cast
  .trimEnd()
  .split("\n")
  .map((line) => JSON.parse(line));
const textOf = (count) =>
  events
    .slice(0, count)
    .map(([, , data]) => data)
    .join("")
    .replaceAll("\r\n", "\n");
const transcript = textOf(events.length);

// Events on screen. All of them until the page knows motion is welcome, so
// the server-rendered page and a reduced-motion reader see the whole session.
const shown = ref(events.length);
const playing = ref(false);
const text = computed(() => textOf(shown.value));
const label = computed(() =>
  playing.value ? "Pause" : shown.value < events.length ? "Play" : "Replay",
);

const figure = useTemplateRef("figure");
const screen = useTemplateRef("screen");
let timer;
let observer;

function next() {
  if (shown.value >= events.length) {
    playing.value = false;
    return;
  }
  const delay = events[shown.value][0] - (events[shown.value - 1]?.[0] ?? 0);
  timer = setTimeout(() => {
    shown.value += 1;
    // A terminal keeps its newest line in view.
    requestAnimationFrame(() => {
      screen.value.scrollTop = screen.value.scrollHeight;
    });
    next();
  }, delay * 1000);
}

function play() {
  if (shown.value >= events.length) {
    shown.value = 0;
  }
  playing.value = true;
  next();
}

function pause() {
  clearTimeout(timer);
  playing.value = false;
}

onMounted(() => {
  screen.value.scrollTop = screen.value.scrollHeight;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }
  shown.value = 0;
  observer = new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting) {
      observer.disconnect();
      play();
    }
  });
  observer.observe(figure.value);
});

onBeforeUnmount(() => {
  clearTimeout(timer);
  observer?.disconnect();
});
</script>

<template>
  <figure ref="figure" class="recording">
    <figcaption>{{ title }}</figcaption>
    <!-- The transcript below is the same text, for a screen reader. -->
    <pre
      ref="screen"
      class="screen"
      :style="{ height: `${header.height}lh` }"
      aria-hidden="true"
      >{{ text }}</pre>
    <button type="button" @click="playing ? pause() : play()">
      {{ label }}
    </button>
    <details>
      <summary>Transcript</summary>
      <pre>{{ transcript }}</pre>
    </details>
  </figure>
</template>

<style scoped>
.recording {
  margin: 0 0 32px;
}
figcaption {
  font-weight: 600;
  margin-bottom: 8px;
}
pre {
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  line-height: 1.5;
  overflow: auto;
  margin: 0;
  padding: 12px 16px;
  border-radius: 8px;
  background: var(--vp-code-block-bg);
  color: var(--vp-code-block-color);
}
.screen {
  box-sizing: content-box;
}
button {
  margin-top: 8px;
  padding: 2px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  font-weight: 500;
}
button:hover {
  border-color: var(--vp-c-brand-1);
}
button:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
}
details {
  margin-top: 8px;
}
summary {
  cursor: pointer;
}
details pre {
  margin-top: 8px;
}
</style>
