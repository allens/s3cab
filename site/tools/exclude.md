---
title: Exclude-pattern playground
prev: false
next: false
---

# Exclude-pattern playground

Try out a set's exclude patterns before you trust a backup to them. Type
patterns on the left and paths on the right, and the table shows which paths
s3cab would leave out, and the pattern that did it: the same answer
`s3cab tree --excluded` gives for your real folders. It runs s3cab's own
pattern matcher, in your browser; nothing you type leaves the page.

- **Patterns** are read as an `exclude.txt`: one per line, `#` starts a comment.
  They start as the file a new set is born with, written with `/`, which
  Windows takes too.
- **Paths** are relative to one of the set's directories, one per line. End a
  folder with `/` (or `\` on Windows).
- **A left-out folder stands for everything inside it**, because s3cab never
  looks inside one: a path in it is left out by that folder's pattern.
- **Windows, macOS or Linux** changes how names compare: case is ignored on
  Windows and macOS, `\` separates folders only on Windows, and on macOS an
  accent matches however it is stored. On macOS and Linux `\` escapes the
  character after it instead, and one that escapes nothing, as in a pattern
  written with Windows separators, makes s3cab refuse the whole file.

The rules themselves are in [Exclude rules](https://s3cab.plantegral.com/guide/exclude).

<script setup>
import ExcludePlayground from "../.vitepress/ExcludePlayground.vue";
</script>

<ExcludePlayground />
