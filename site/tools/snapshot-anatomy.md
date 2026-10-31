---
aside: false
---

<script setup>
import { data } from "../.vitepress/snapshot-sample.data.mjs";
import {
  ColumnReference,
  RowReference,
  SnapshotSample,
} from "../.vitepress/snapshot-anatomy-view.mjs";
</script>

# Anatomy of a snapshot

A snapshot is a gzip-compressed text file, one row per line, that anyone can open: decompress
it with `gunzip` and read it in a text editor or a spreadsheet. Below is a real one, written by
s3cab itself when this page was built, for a set called `photos` that backs up two folders.

The [format spec](https://s3cab.plantegral.com/guide/format#snapshot-files) is the authority
on every row and column. This page says what each one is for, and links to the part of the
spec that defines it.

<SnapshotSample :text="data" />

Each line is five fields separated by tabs, so a script splits it cleanly, and the first four
are padded with spaces, so the raw file reads as a table:
[the columns](https://s3cab.plantegral.com/guide/format#the-columns) and
[canonical form](https://s3cab.plantegral.com/guide/format#canonical-form) say how. Tabs are
shown ten characters wide here, so every column lines up.

## What every row means

<RowReference />

## What every column holds

<ColumnReference />

<style>
.anatomy-sample {
  margin: 16px 0;
  padding: 16px 20px;
  max-height: 60vh;
  overflow: auto;
  border-radius: 8px;
  background: var(--vp-code-block-bg);
  font-family: var(--vp-font-family-mono);
  font-size: var(--vp-code-font-size);
  line-height: 1.5;
  tab-size: 10;
}
.anatomy-sample:focus-visible {
  outline: 2px solid var(--vp-c-brand-1);
  outline-offset: 2px;
}
.anatomy-sample code {
  padding: 0;
  background: none;
  color: var(--vp-code-block-color);
  font-size: inherit;
}
.anatomy-sample .cell {
  cursor: pointer;
}
.anatomy-sample .current .cell {
  background: var(--vp-c-default-soft);
}
.anatomy-sample .cell.selected {
  background: var(--vp-c-brand-soft);
  outline: 1px solid var(--vp-c-brand-1);
}
.anatomy-sample .tab {
  position: relative;
}
.anatomy:has(.anatomy-toggle input:checked) .pad {
  background-image: radial-gradient(circle, var(--vp-c-text-3) 1px, transparent 1.5px);
  background-size: 1ch 100%;
  background-repeat: repeat-x;
}
.anatomy:has(.anatomy-toggle input:checked) .tab::before {
  content: "→";
  position: absolute;
  left: 0;
  color: var(--vp-c-brand-1);
}
.anatomy-toggle {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  cursor: pointer;
}
.anatomy-panel {
  min-height: 6em;
  padding: 4px 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg-soft);
}
.anatomy-spec {
  white-space: nowrap;
}
</style>
