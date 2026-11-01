<script setup>
import { computed, onMounted, ref } from "vue";
import { excludeReport } from "./exclude-playground.mjs";
import { data as starter } from "./starter-exclude.data.mjs";

const platforms = [
  { value: "win32", label: "Windows" },
  { value: "darwin", label: "macOS" },
  { value: "linux", label: "Linux" },
];
const remembered = "s3cab-exclude-playground-os";

const patterns = ref(starter);
const paths = ref(
  [
    "Photos/beach.jpg",
    "Photos/.DS_Store",
    "Photos/2019 hike/",
    "Projects/app/src/main.js",
    "Projects/app/node_modules/",
    "Projects/app/node_modules/left-pad/index.js",
    "Projects/app/.git/",
    "Documents/report.docx",
    "Documents/thumbs.db",
  ].join("\n"),
);
const platform = ref("linux");

onMounted(() => {
  try {
    const saved = localStorage.getItem(remembered);
    if (platforms.some(({ value }) => value === saved)) {
      platform.value = saved;
      return;
    }
  } catch {
    // Storage blocked: fall back to guessing from the browser.
  }
  const agent = navigator.userAgent;
  platform.value = /Windows/.test(agent)
    ? "win32"
    : /Mac/.test(agent)
      ? "darwin"
      : "linux";
});

/** @param {string} value - The option just chosen */
function remember(value) {
  try {
    localStorage.setItem(remembered, value);
  } catch {
    // Not remembered, which is all that is lost.
  }
}

const report = computed(() =>
  excludeReport(patterns.value, paths.value, platform.value),
);
const verdicts = computed(() => report.value.verdicts);
const leftOut = computed(
  () => verdicts.value.filter(({ pattern }) => pattern).length,
);
</script>

<template>
  <div class="playground">
    <fieldset class="platform">
      <legend>Match the way s3cab does on</legend>
      <label v-for="option in platforms" :key="option.value">
        <input
          v-model="platform"
          type="radio"
          name="exclude-playground-os"
          :value="option.value"
          @change="remember(option.value)"
        />
        {{ option.label }}
      </label>
    </fieldset>

    <div class="inputs">
      <div>
        <label for="exclude-playground-patterns">Patterns (exclude.txt)</label>
        <textarea
          id="exclude-playground-patterns"
          v-model="patterns"
          aria-describedby="exclude-playground-summary"
          rows="16"
          wrap="off"
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
        ></textarea>
      </div>
      <div>
        <label for="exclude-playground-paths">
          Paths, one per line (end a folder with /)
        </label>
        <textarea
          id="exclude-playground-paths"
          v-model="paths"
          rows="16"
          wrap="off"
          spellcheck="false"
          autocapitalize="off"
          autocomplete="off"
        ></textarea>
      </div>
    </div>

    <p
      id="exclude-playground-summary"
      class="summary"
      :class="{ refused: report.refusal }"
      aria-live="polite"
    >
      <template v-if="report.refusal">{{ report.refusal }}</template>
      <template v-else>
        {{ leftOut }} of {{ verdicts.length }}
        {{ verdicts.length === 1 ? "path" : "paths" }} left out.
      </template>
    </p>

    <table v-if="verdicts.length">
      <thead>
        <tr>
          <th scope="col">Path</th>
          <th scope="col">Backed up?</th>
          <th scope="col">Left out by</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(verdict, i) in verdicts"
          :key="i"
          :class="{ out: verdict.pattern }"
        >
          <td>
            <code>{{ verdict.path }}</code>
          </td>
          <td>{{ verdict.pattern ? "✗ Left out" : "✓ Kept" }}</td>
          <td>
            <template v-if="verdict.pattern">
              <code>{{ verdict.pattern }}</code
              ><span v-if="verdict.folder"
                >, by leaving out its folder
                <code>{{ verdict.folder }}</code></span
              >
            </template>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.platform {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1.25rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  padding: 0.5rem 1rem 0.75rem;
}
.platform legend {
  padding: 0 0.25rem;
  font-weight: 600;
}
.platform label {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  cursor: pointer;
}
.inputs {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
  gap: 1rem;
  margin-top: 1rem;
}
.inputs label {
  display: block;
  font-weight: 600;
  margin-bottom: 0.25rem;
}
textarea {
  width: 100%;
  font-family: var(--vp-font-family-mono);
  font-size: 0.85rem;
  line-height: 1.5;
  padding: 0.5rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
  color: var(--vp-c-text-1);
  resize: vertical;
}
textarea:focus-visible,
.platform input:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}
.summary {
  font-weight: 600;
}
.summary.refused {
  font-weight: normal;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
tr.out td:nth-child(2) {
  color: var(--vp-c-danger-1);
  font-weight: 600;
}
td {
  vertical-align: top;
}
</style>
