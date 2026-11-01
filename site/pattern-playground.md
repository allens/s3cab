---
title: Pattern playground
---

<script setup>
import FindPlayground from "./.vitepress/FindPlayground.vue";
</script>

# Pattern playground

## `find` patterns

Check a [`s3cab find`](../guide/find.md) pattern against some paths before
you trust what it prints: that list is what
[`s3cab delete`](../guide/maintenance.md#deleting-files-from-every-backup-delete)
removes from every backup, for good. The page runs s3cab's own matcher, in your
browser; nothing you type leaves it.

Paste paths the way a snapshot stores them: absolute, one per line. Windows paths
(`C:\Users\me\…`, `\\server\share\…`) and macOS or Linux ones (`/home/me/…`) can
sit side by side, and each is read by its own rules.
[What a pattern matches](../guide/find.md#what-a-pattern-matches) has the rules
for the patterns. Write `/` between directories: `s3cab find` on Windows takes
`\` too, but this page reads a pattern the way s3cab on macOS or Linux does.

These are not [exclude patterns](../guide/exclude.md): the two follow different
rules, so a pattern can mean one thing in an exclude file and another here.

<FindPlayground />
