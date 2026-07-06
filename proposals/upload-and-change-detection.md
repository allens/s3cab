# Upload consolidation & change-detection simplification

Epic: fold "upload one file" and "upload a snapshot's objects" into a single **`upload`**
plumbing command, make **`backup`** a clean `snapshot()` + `upload()` composition, and
replace the persistent per-bucket objects cache with a simpler change-detection model
(local-snapshot baseline, or an on-demand `LIST`, with the conditional PUT as the correctness
backstop).

This came out of revisiting the stale `--if-modified-from` TODO in
[`src/commands/upload.mjs`](../src/commands/upload.mjs) and discovering the TODO's premise
("load-bearing for `backup`") was false — `backup` shipped as `snapshot()` + `uploadSnapshot()`
and never routes through `upload`. Pulling that thread led to the reshape below.

> **Provenance note (per the global "stick to the user's words" rule):** the brief below is
> the user's design. Lines tagged **_[CN]_** ("Claude's note") are my framing/suggestions, not
> part of the brief — kept visibly separate so they can be taken or dropped independently.

---

## The `upload` command (plumbing)

`upload` is plumbing: its one job is to **get objects into the store**. It is always
**set-scoped** — the first positional is a **set** (which supplies the bucket), never a raw
bucket. Two modes, told apart by whether `--file` is present:

- **Single object** — `upload <set> --file <path>` **or** `upload --bucket <bucket> --file <path>`
  Hash the file, one conditional PUT into the object store. **No `LIST`, no baseline.** Used to
  seed a large object out-of-band / by hand before a backup. Two ways to name the target,
  mutually exclusive (`--file` mode takes a **`<set>` positional xor `--bucket`**):
  - **Set-scoped** (`<set>`) — the set resolves to its bucket **and** its env layer (auth /
    endpoint / region — `loadSet`, ADR-0022). The normal form: seed into one of your own sets.
  - **Raw bucket** (`--bucket`) — no set: PUT the object into `objects/<hash>` in that bucket
    directly, on **ambient / user credentials** (the `~/.s3cab/env` user layer + the AWS default
    chain, *not* a set env layer). This is the true plumbing primitive (it carries forward
    today's `upload <bucket> <file>` capability) and the escape hatch for seeding into a bucket
    that isn't one of your sets — even a foreign one.
    - **Auth caveat:** because there's no set env layer, a **non-AWS** bucket whose
      endpoint/region/profile lives in *set* config won't be reachable this way unless you
      supply those via the user env / ambient chain. Fine for AWS/ambient; document it. (This is
      exactly today's raw-upload behaviour.)
  - `--force` (today's behaviour: flips `noClobber`) overwrites an existing object — the
    paranoid/repair hatch: since s3cab trusts the hash on write and only verifies on read, this
    is how you overwrite a corrupt/truncated remote object with a known-good local copy. Valid
    in **both** single-file forms; **rejected in snapshot mode** (see below).
  - **`--bucket` is single-file-mode-only.** Snapshot mode always needs a set — a snapshot
    belongs to a set and its manifest goes to `snapshots/<set>/`, so `--bucket` never applies
    there.

- **Snapshot's objects** — `upload <set> [<snapshot>]`
  Upload every object referenced by `<snapshot>` (**optional; defaults to the latest local
  snapshot**), then upload the **snapshot manifest last** — preserving the
  objects-first/manifest-last invariant. Errors if a *named* snapshot is absent.
  - A **manifest opt-out** ("upload the objects but not the snapshot file") is a *possible*
    flag. **_[CN]_** Defer it until a use appears (#7); name TBD (`--no-manifest` /
    `--objects-only`). Orphan objects with no manifest are the *safe* direction (wasted space,
    not corruption), so it's harmless if we do add it.
  - **`--force` is rejected here** — `upload <set> <snapshot> --force` errors ("`--force`
    applies only to `--file` uploads"). Two reasons: (1) it would tangle with the baseline layer
    (does it bypass just the conditional PUT, or `--since`/`LIST` too?), whereas single-file mode
    has no baseline so force means one unambiguous thing; (2) snapshot mode also writes the
    **immutable** manifest (a duplicate remote name is a hard error, never an overwrite), and
    force must never touch that — keeping force out of snapshot mode sidesteps the exception
    entirely. Wholesale "re-push an entire snapshot's objects regardless" is niche repair
    territory that belongs with `verify`/`cleanup`, not `upload` (#7).

Predictable-by-design: `upload` never goes hunting for "which snapshot is latest/previous" as a
*baseline* — that smart choice belongs to `backup` (porcelain). Plumbing is explicit; porcelain
is smart. **_[CN]_** This is just ADR-0023 (porcelain/plumbing) applied.

## Change detection — the baseline

Deciding what *not* to re-upload is a baseline question. `upload` gets its baseline one of two
ways, by a **fixed deterministic rule** (not state-dependent "auto"):

- `upload <set> <snapshot> --since <baseline-snapshot>` → skip objects already in
  `<baseline-snapshot>`. No `LIST`.
- `upload <set> <snapshot>` (no `--since`) → **`LIST` the store** and use that as the baseline.
- `upload <set> --file …` (single-object mode) → **neither**: just the one conditional PUT.
  `LIST`ing the whole store to check a single file would be silly; `--since` doesn't apply here.

So the rule is: **snapshot mode, no `--since` ⇒ implicit `LIST`; single-file mode ⇒ no `LIST`.**
It does slightly different things by mode, but each is a fixed rule you can read off the command
line — not worth extra flags to make every case super-explicit.

Chosen name: **`--since <snapshot>`** (git `--since` / HTTP `If-Modified-Since` lineage; reads
naturally because snapshot names are timestamps). It replaces the old `--if-modified-from`
wording. **_[CN]_** Runner-up was `--baseline`; confirm against the `cli-design` skill when built.

**Whichever baseline (or none), the conditional PUT still guards every actual write, so
correctness never rides on the baseline** — the baseline is purely a round-trip optimization.

### Why `LIST` and not a persistent cache

Today `uploadSnapshot` narrows the upload set three ways: diff vs the **latest remote snapshot**,
minus a **persistent per-bucket objects cache** (`~/.s3cab/objects.<bucket>`), with the
conditional PUT as the net. We're **dropping the persistent cache** and replacing its one real
benefit with an on-demand `LIST`:

- The cache never changes *what gets uploaded* — the conditional PUT (and the ≥8 MB HEAD
  preflight) already prevent any wasted upload. The cache only ever saved **round-trips**, and
  only for objects present in the bucket but absent from your diff baseline (cross-set,
  cross-machine, or churned out of the latest snapshot).
- Its cost is real: it's the one component that can be **poisoned** (a cached-but-absent entry →
  a silently skipped upload), which is why `verify`/`cleanup` carry cache-rewrite/healing
  machinery. A whole subsystem to defend a round-trip saving that's **zero in the common case**.
- The cache's useful core — "batch-check many objects with one `LIST` instead of N round-trips"
  — becomes a **one-shot, stateless `LIST`**, triggered exactly when there's no `--since`
  baseline (i.e. a first backup). It's free when the store is empty/small and valuable when it's
  large; and because keys are SHA-256 hex (uniformly distributed), the `LIST` can be
  prefix-parallelised (16/256-way) from minutes down to seconds on a million-object store.

The set-ownership model makes the **local** previous snapshot the authoritative baseline: a set
is owned by exactly one machine (the `sets/<name>/` marker; `--inherit` *re-stamps* the owner,
never shares), so there is no other machine whose uploads the local history wouldn't know about.
Hence no need to fetch the remote snapshot for the diff — `backup` diffs against the local
previous snapshot. **_[CN]_** This corrects an earlier wrong assumption of mine that a set could
be backed up from several machines; it can't.

### Accepted trade-off

`LIST` cost scales with the **bucket**; its benefit scales with your **candidates**. So a *tiny*
first backup into a *huge* shared bucket pays a big `LIST` to save few round-trips. **Accept
this for now** — it's a one-time first-run cost. **_[CN]_** Add an opt-*out* only if it ever
bites (#7); don't build the escape hatch speculatively.

## The `backup` command (porcelain)

`backup [set]` = take a fresh snapshot (`snapshot()`), then upload it (`upload()`). It **always**
snapshots and uploads — no mode to skip either.

- **`backup --snapshot <name>` retires.** "Upload an existing snapshot without taking a fresh
  one" is now just `upload <set> <name>`. The flag existed only because plumbing wasn't exposed;
  now it is.
- `backup` does the smart baseline choice and hands `upload` explicit params: on a normal run it
  passes `--since <previous-snapshot>` (resolved via the existing
  [`listSnapshotNames(dir, { latest: true })`](../src/lib/snapshot-file.mjs)); on a first backup
  it passes no `--since`, so `upload` does the implicit `LIST`.
- The objects-first/manifest-last invariant lives **in one place** — `upload` (snapshot mode) —
  and `backup` just composes. `backup` remains the only command that takes a *fresh* snapshot
  and uploads it; committing the manifest itself is delegated to `upload`.

---

## Multipart + conditional-write findings (preserve these)

Verified while designing the backstop; worth keeping so it isn't re-litigated:

- **Conditional writes work with multipart on AWS S3.** `If-None-Match: *` is supported on
  `CompleteMultipartUpload` (general-purpose buckets, Nov 2024; `PutObject` Aug 2024), and the
  SDK's `lib-storage` `Upload` forwards it (blanket `{ ...this.params }` spread into the
  completion call). So the `IfNoneMatch` on our multipart path is *not* dead code.
- **But the check is evaluated only at completion** — after every part has uploaded. So relying
  on the conditional alone for a large already-present object would burn the whole transfer.
  That's exactly why [`putFile`](../src/lib/s3.mjs) does a **HEAD preflight for files ≥ 8 MB**
  before starting a multipart upload. Keep that preflight.
- **Open risk — off-AWS providers.** Whether R2 / B2 / MinIO / Wasabi support conditional writes
  on multipart is **unverified**. If the conditional PUT is the correctness backstop, its
  reliability off-AWS needs a per-provider check
  ([docs/design/s3-provider-compatibility.md](../docs/design/s3-provider-compatibility.md))
  before we lean on it there.

Sources: [S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html) ·
[enforcement, Nov 2024](https://aws.amazon.com/about-aws/whats-new/2024/11/amazon-s3-enforcement-conditional-write-operations-general-purpose-buckets/) ·
[CompleteMultipartUpload API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html) ·
[lib-storage Upload.ts](https://github.com/aws/aws-sdk-js-v3/blob/main/lib/lib-storage/src/Upload.ts).

---

## What this touches (amends / supersedes)

- **[docs/design/backup.md](../docs/design/backup.md)** — the "How `backup` computes the upload
  set" section (drop cache step 3, the cache staleness-asymmetry paragraph), and the
  `verify`/`cleanup` cache-rewrite/healing passages. Add the local-snapshot-baseline + on-demand
  `LIST` model and the `upload`/`backup` command reshape.
- **The `--if-modified-from` TODO** in [`src/commands/upload.mjs`](../src/commands/upload.mjs)
  and the matching **CLAUDE.md "Known gaps"** note — resolved/rewritten (becomes `--since`, and
  the "load-bearing for backup" premise was wrong).
- **New ADR(s)** likely warranted: (a) *drop the persistent objects cache; change detection =
  local-snapshot baseline + on-demand `LIST` + conditional-PUT backstop*; (b) *the `upload`
  unification and retirement of `backup --snapshot`* (a command-surface decision → run the
  `cli-design` skill).
- **Code to remove with the cache:** `knownObjects` / `recordObjects` / `writeObjectsCache` /
  `objectsCachePath` in [`src/lib/objects.mjs`](../src/lib/objects.mjs), the `--skip-cache` flag,
  and the cache wiring in [`src/lib/remote.mjs`](../src/lib/remote.mjs)'s `uploadSnapshot`. Keep
  `verify`/`cleanup`'s `LIST`-based integrity roles; they just no longer heal a cache.

## Open points

- **Manifest opt-out flag** — needed now? (defer, #7). Name if so.
- **Off-AWS conditional-write-on-multipart** — verify before relying on the backstop there.
- **`cli-design` pass** on the whole `upload`/`backup` surface before coding.
- **Slice ordering** — this is a sizeable reshape; likely wants breaking into PRs (e.g. drop
  cache → unify `upload` → recompose `backup` / retire `--snapshot`). Pre-1.0, so bold refactor
  is fine (#7 / version gate).
