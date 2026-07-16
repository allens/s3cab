# Bugs / correctness suspicions

> **Interim home — must reach zero before release.** Bugs belong in **GitHub Issues**, but the
> repo won't use Issues until pre-release. So this file is the stop-gap tracker in the
> meantime. It is the **one file in `proposals/` that should be gone by release** — i.e. *no
> known bugs* at ship. After that, file bugs as GitHub Issues, not here.

- **A file changing on disk between snapshot and upload silently stores wrong bytes under a
  hash.** `uploadSnapshot` PUTs each planned object from the *current* file at the
  snapshot-recorded path, and the store trusts the caller's hash on write (objects.mjs). If the
  file changed since the snapshot, object `<H>` receives content that isn't `H`. The correct bytes
  are then **never stored at all** — that snapshot cannot restore that file, and the backup
  reports success.

  **Not confined to the `upload --snapshot <old>` plumbing form.** The window for any one file is
  snapshot-time → *that file's* upload, not snapshot-time → upload-*start*. The plan loop is
  strictly sequential (`for … await putObject` in [upload.mjs](../src/lib/upload.mjs)), so on a
  large set the last objects go up potentially hours after the snapshot was taken. A file edited
  during a long backup is ordinary, not exotic.

  **The blast radius follows the dedup graph.** Object `H` is written once; corrupt it and *every*
  snapshot and *every* other path resolving to `H` breaks — including files nobody touched.
  Today it surfaces only at restore's integrity check (`getObject` verifies on read, so you get a
  loud failure rather than wrong bytes) or via `verify` if the size drifted — i.e. at the worst
  possible moment, and unfixable by then.

  **Leading fix** (cheap, no interface churn): an `lstat` size/mtime staleness check per *planned*
  upload — only the objects actually being sent, where an lstat is noise next to the upload, and
  never per *walked* file, where it would be ruinous — skipping-with-warning on drift.
  `uploadSnapshot` already has `target` (the snapshot entries, carrying size and mtime) in scope
  beside the plan loop, so this needs no `putFile` parameter, no `planUpload` contract change, and
  no s3.mjs change.

  **A HEAD-side `ContentLength` check is _not_ a substitute** (considered and dropped 2026-07-16):
  when staleness strikes the object is being *created*, so the HEAD 404s and there is nothing to
  compare against. It could only spot the wreckage on a later backup that re-encounters `H`, and
  only for bodies ≥ `partSize`.

  <sub>Provenance: surfaced by the 2026-07-16 eighth architecture pass, which recorded it in
  `engine-robustness.md` as "a deliberate design stance today, not a defect" — an AI-invented
  verdict (commit 6d3b84f) that no one held. Reclassified as a bug 2026-07-16 on the owner's
  call.</sub>
