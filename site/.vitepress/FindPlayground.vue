<script setup>
import { computed, ref } from "vue";
import { findReport } from "./find-playground.mjs";

const patterns = ref(
  ["aws-keys.txt", "*.mov", "Documents/tax", "secretsdir/", "*keys.txt"].join(
    "\n",
  ),
);
const paths = ref(
  [
    String.raw`C:\Users\me\secretsdir\aws-keys.txt`,
    String.raw`C:\Users\me\Documents\tax`,
    String.raw`C:\Users\me\Documents\tax\2019.pdf`,
    String.raw`D:\Videos\2019\hike.MOV`,
    String.raw`\\nas\home\keys.txt`,
    "/home/me/secretsdir/id_rsa",
    "/home/me/Documents/old/tax",
    "/Users/me/Movies/beach.mov",
  ].join("\n"),
);

// s3cab's matcher escapes a pattern with `RegExp.escape`, which Vite doesn't
// polyfill: without it every pattern would throw.
const supported = typeof RegExp.escape === "function";
const report = computed(() => findReport(patterns.value, paths.value));
const refused = computed(() =>
  report.value.patterns.filter((pattern) => pattern.error),
);
const matches = computed(
  () => report.value.paths.filter((path) => path.matchedBy.length > 0).length,
);
</script>

<template>
  <p v-if="!supported" class="find-playground">
    This browser is too old for the playground: it needs one released in 2025 or
    later.
  </p>
  <div v-else class="find-playground">
    <div class="inputs">
      <div class="field">
        <label for="find-patterns">Patterns, one per line</label>
        <textarea
          id="find-patterns"
          v-model="patterns"
          rows="8"
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
          aria-describedby="find-refused"
        ></textarea>
      </div>
      <div class="field">
        <label for="find-paths">Paths, one per line</label>
        <textarea
          id="find-paths"
          v-model="paths"
          rows="8"
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
          wrap="off"
        ></textarea>
      </div>
    </div>
    <div id="find-refused">
      <p v-for="(pattern, i) in refused" :key="i" class="refused">
        <strong>Refused:</strong> <code>{{ pattern.pattern }}</code> —
        {{ pattern.error }}
      </p>
    </div>

    <p aria-live="polite">
      {{ matches }} of {{ report.paths.length }}
      {{ report.paths.length === 1 ? "path matches" : "paths match" }}.
    </p>
    <table>
      <thead>
        <tr>
          <th scope="col">Path</th>
          <th scope="col">Result</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, i) in report.paths" :key="i">
          <td>
            <code>{{ row.path }}</code>
          </td>
          <td v-if="row.matchedBy.length > 0">
            <span aria-hidden="true">✓ </span>matched by
            <template v-for="(pattern, j) in row.matchedBy" :key="j">
              <template v-if="j > 0">, </template><code>{{ pattern }}</code>
            </template>
          </td>
          <td v-else><span aria-hidden="true">✗ </span>no match</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.inputs {
  display: grid;
  gap: 16px;
  margin-top: 16px;
}
@media (min-width: 640px) {
  .inputs {
    grid-template-columns: 1fr 2fr;
  }
}
.field {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
label {
  font-weight: 600;
  margin-bottom: 4px;
}
textarea {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  background: var(--vp-c-bg-soft);
  font-family: var(--vp-font-family-mono);
  font-size: 0.875em;
  line-height: 1.6;
  resize: vertical;
}
textarea:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 1px;
}
.refused {
  margin: 8px 0 0;
  white-space: pre-wrap;
}
td code {
  word-break: break-all;
}
</style>
