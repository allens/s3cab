# s3cab pre-release prompts for Claude Fable

Ordered by contribution to one goal: **reducing the risk that a backup reports success and cannot be restored.**

Everything here assumes Claude Code with `/effort` set per prompt. Run 1 before you freeze the format for 1.0, because a real durability flaw may want a change to the bucket layout, and that is cheap now and expensive later.

A lettered prompt (1b) re-asks its parent's question after the subject moved — run one when the parent's findings have stopped being about current code.

Where a prompt says "analysis only", keep it that way. The whole point of the first two is an independent opinion you can compare against your own; letting the same session fix what it finds contaminates that.

Prompt 7 sits last because it contributes least to restore risk on AWS, which is where most people will run this. It is still a release blocker, for a different reason: you currently advertise compatibility with three object stores whose versioning and multipart behaviours differ, and nothing checks it. Treat its position as "last of the things you must do", not "optional".

---

## 1. Repository protocol model and durability audit

**Effort: high; raise to xhigh only if a `high` run comes back shallow. Analysis only, no code changes. Expect a long single run.**

> I'm preparing s3cab for a 1.0 release. It's a content-addressable backup tool, and the only failure that really matters is a backup that reports success but cannot be restored. Before I freeze the on-disk and in-bucket format, I want an independent, adversarial assessment of whether the durability invariants actually hold.
>
> First, build an explicit state model of the repository protocol. Read the source and `guide/format.md`, and write down: the legal states of `objects/` and `snapshots/` in a bucket; every transition each command performs (`backup`, `upload`, `forget`, `cleanup`, `verify`, `reattach`, `restore`); and which of those transitions are atomic versus multi-step. Make the model concrete enough that a reader can check a claim against it.
>
> Then attack it. The stated invariant is that a snapshot file only appears in `snapshots/` after every object it references is in `objects/`. Try to find sequences that break it, or that leave a snapshot unrestorable by any other route. Cover at least: process termination at each step of a multi-step transition; a `cleanup` on one machine running concurrently with an in-flight `backup` on another machine against the same bucket; `forget` and `cleanup` interleaved; S3 request retries and duplicate delivery; aborted or orphaned multipart uploads; a file mutating mid-scan; clock skew or collision in snapshot naming; a set name being claimed or reattached from two machines; and a bucket where versioning was never enabled.
>
> Deliverable: the state model, plus a findings table. For each finding give a severity based solely on whether it can produce an unrestorable or silently incomplete backup, a concrete reproduction sequence, and the file and line the reasoning rests on. Separate the findings into confirmed (you traced the code path), suspected (plausible but not confirmed), and ruled out (you checked and the guard exists — name the guard). I need the ruled-out list as much as the others.
>
> Before reporting any finding, audit each claim against a tool result from this session. If you have not actually read the code path, say so and put it under suspected. Do not fix anything, do not refactor, and do not open a branch. The deliverable is your assessment.

---

## 1b. Adversarial audit of `delete` and the deletion record

**Effort: high; raise to xhigh only if a `high` run comes back shallow. Analysis only, no code changes.** `find` and a rewritten hash-operand `delete` landed 2026-08-22 ([ADR-0088](../adr/0088-find-matches-like-posix-find.md)/[0089](../adr/0089-hash-operand-delete.md)/[0090](../adr/0090-deletion-record-format-compaction.md)), after prompt 1 ran. They replaced the path-scoped delete and the `deletions/<timestamp>.tsv` files with root-level `objects.deleted-<n>.tsv` records that `cleanup` now **compacts and trims** — the first transition in the tool that deliberately destroys the record of a destructive act. [docs/design/repository-protocol.md](../design/repository-protocol.md) was updated with it, so this run starts from a model instead of deriving one.

One thing to know before you run it: the model suite does **not** exercise this. [runner.mjs](../../test/model/harness/runner.mjs) has no `delete` case and [sequence.mjs](../../test/model/harness/sequence.mjs) never emits one, while [invariants.mjs](../../test/model/harness/invariants.mjs) has grown an exception for recorded hashes — so Tier 1 green is not evidence about any of it.

> s3cab is a content-addressable backup tool heading for a 1.0 format freeze. `delete` was rewritten on 2026-08-22 to take content hashes instead of paths, and the record of what it deleted was redesigned with it. It is the only irreversible bucket-wide operation in the tool, and no independent reader has looked at it. I want an adversarial assessment before the format freezes.
>
> Rank findings against three failures. Two are the usual ones: **a backup that reports success but cannot be restored**, and **content destroyed that the user did not name**. The third belongs to this subsystem — **an absence that can no longer be explained**, because the record is the only thing standing between a deliberate deletion and what a user reads as data loss.
>
> Start from `docs/design/repository-protocol.md`. It already models the legal states, every transition, and which are atomic, including `delete` and `cleanup`'s new compaction step — so check the code against it rather than re-deriving it, and treat any place they disagree as a finding in its own right. Then read `src/commands/delete.mjs`, `src/lib/deletion-record.mjs`, `src/lib/cleanup.mjs`, `src/commands/cleanup.mjs`, and the four consumers that read the record: `verify`, `restore`, `backup`'s baseline subtraction in `src/lib/upload.mjs`, and `cleanup`'s missing-object interlock. ADR-0089 and ADR-0090 give the reasoning; `guide/format.md` gives the promise made to users.
>
> Attack at least these:
>
> - **The trim rule.** Compaction drops any row no snapshot references, on the argument that every consumer reaches the record *through* a snapshot that references that hash, so an unreferenced row is unreachable. Find a reader that arrives another way, or a window where the referenced set is incomplete — a manifest mid-publish, a snapshot on a machine that has not uploaded yet, a set attached but not synced, an unreadable snapshot the interlock is meant to catch.
> - **The empty merge.** A compaction whose surviving rows are empty writes no file at all, then deletes the files it absorbed. Unlike the crash-between-write-and-delete case, that one is unrecoverable. Establish whether it can ever run against an incomplete referenced set.
> - **Record-first ordering under interruption.** Kill between the record PUT and each object delete, and between the merge PUT and each absorbed-file delete. The claim is that every intermediate state reads correctly — over-recording is safe, duplicated rows are safe. Check both, and check what a *second* run does to each state it leaves.
> - **The index allocator.** LIST, conditional PUT, walk upward on a lost race. Two concurrent deletes; a delete concurrent with a compaction; two concurrent compactions; a paginated or truncated LIST. Whether an index can be reused, or skipped in a way that loses a file, or exhausted.
> - **Hash handling end to end.** What `delete` accepts as an operand, what it writes into a row, and what the record parser will read back. In particular, whether any spelling of a hash can be accepted by the command but ignored by the parser — that combination deletes the object and leaves the absence unexplained. Check the `--from-file` path separately from the positional one; they are two entry points to the same destruction.
> - **The dedup blast radius.** `delete` hard-refuses the empty-file hash because it backs every zero-byte file. Work out whether that is the only pathological case or merely the only one anyone thought of, and whether the refusal covers every entry point.
> - **`restore`'s graceful skip.** A recorded hash makes restore skip the file and exit 0. Work out what a user actually sees when that happens to one file in ten thousand, and whether a silently incomplete restore is reachable through it.
> - **`backup` against a concurrent delete.** Every delete is now bucket-wide by construction. Check whether the baseline subtraction can publish a *fresh* snapshot that references content already deliberately gone.
>
> Deliverable: a findings table. Per finding, a severity against the three failures above, a concrete reproduction sequence, and the file and symbol the reasoning rests on — not line numbers, they rot. Separate confirmed (you traced the code path) from suspected (plausible, not confirmed) from ruled out (you checked and the guard exists — name the guard). I need the ruled-out list as much as the others. Say specifically where `docs/design/repository-protocol.md` and `guide/format.md` are now wrong.
>
> Before reporting any finding, audit each claim against a tool result from this session. If you have not actually read the code path, say so and put it under suspected. Do not fix anything, do not refactor, do not open a branch. The deliverable is your assessment.

---

## 2. Independent restorer built from the spec alone

**Effort: high; raise to xhigh only if a `high` run comes back shallow. Not a pasted prompt.** A clean-room run is built by [scripts/cleanroom/build-restore-cleanroom.mjs](../../scripts/cleanroom/build-restore-cleanroom.mjs), which writes the brief as the clean room's own `CLAUDE.md` in a sandbox outside the repo — open a fresh session in its `cleanroom` directory and say "go". [scripts/cleanroom/README.md](../../scripts/cleanroom/README.md) has the procedure, on Linux and on Windows, and links every run's report. When the run reports, diff its ambiguity list against the last report yourself: a reappearing item is a fix that didn't land, a new one is a fresh gap.

---

## 5. Recovery rehearsal as a release gate

**Effort: medium. Cheap, and the closest thing to evidence a user would accept.**

> Write and then actually execute a full disaster-recovery rehearsal for s3cab, as a repeatable release gate.
>
> On a clean machine with no s3cab state, against a real S3 bucket: `reattach` to an existing set, restore the whole thing, and byte-compare against the original tree. Then the everyday cases — restoring a single deleted file, restoring an older version of a modified file, restoring with `--overwrite` and without, restoring to a different layout with `--output`. Include a restore onto a different operating system from the one that made the backup. Include a hand recovery with no s3cab at all: decompress a snapshot, pick a hash, pull `objects/<hash>` directly, confirm it's the file.
>
> Produce a checklist I can run before every release, with the exact commands and the expected output, plus a record of this run's results. Where reality diverged from the guides, tell me which is wrong.

---

## 6. Drift between the ADRs, the spec, and the code

**Effort: medium. Short run, useful before a release announcement.**

> This repo has `docs/adr/`, `guide/format.md`, `CONTEXT.md`, and a full commit history. Tell me where the code no longer matches what those documents say.
>
> Go through the ADRs and the format spec and check each documented decision against current behaviour. I want three lists: decisions the code has quietly diverged from; behaviour the code has that no document records; and documents describing things that no longer exist. Use the commit history to work out when a divergence happened where that's cheap to establish.
>
> For each item say whether the document or the code should change. Report and stop — don't edit either.

---

## 7. Provider conformance suite

**Effort: high. Reuses the model-based harness's backend abstraction (`test/model/harness/`). Needs an account with each provider.**

> s3cab advertises support for AWS S3 and for S3-compatible providers including Cloudflare R2, Backblaze B2 and Wasabi. Nothing currently verifies that claim, and these providers differ in exactly the areas s3cab's safety properties rest on. I want a conformance suite and an honest support matrix before 1.0.
>
> Start from the capability list in `test/model/CAPABILITIES.md` — the things s3cab depends on the object store doing. Build a suite that probes each capability directly against a live provider and reports what it actually does, rather than whether s3cab happens to pass. At minimum: bucket versioning and whether deletes become delete markers; whether noncurrent versions are listable and restorable; lifecycle rules for expiring noncurrent versions, or their absence; multipart upload thresholds and the ETag format returned; conditional writes and whether `If-None-Match` is genuinely atomic under contention; listing pagination past a thousand keys and delimiter handling; error codes and throttling behaviour under load; checksum and storage-class support; and the semantics of overwriting an existing key.
>
> Test the atomicity claims by contention, not by reading documentation. If two processes race to create the same key, find out empirically what each provider does.
>
> Then run the Tier 2 subset of the main harness against each provider and record what passes.
>
> Deliverables: the suite, runnable per provider from credentials; a support matrix saying what works, what works with caveats, and what doesn't; and — most importantly — a statement per provider of **which s3cab safety properties are weakened or absent there**. If a provider has no lifecycle expiry, say what that means for `cleanup`. If soft-delete-only can't be guaranteed, say that the ransomware backstop doesn't hold. Then tell me where `guide/aws.md` and the README overstate compatibility, and draft the corrected wording.
>
> Report findings per provider as you finish each one rather than saving everything for the end. Where a provider fails, distinguish a genuine incompatibility from an s3cab bug that only shows up there.

---

## Notes on running these

**Give it a sandbox that can actually execute.** The test buckets are already stood up ([docs/integration-testing.md](../integration-testing.md)). The value here is in verification loops, and a model that can only read code is doing a fraction of the work you're paying for.

**Let it keep notes between runs.** A `notes/` directory with one lesson per file, referenced at the start of each session, meaningfully improves later runs on the same codebase.

**Add a scope brake if it starts tidying.** At high effort it will refactor things you didn't ask about. `Don't add features, refactor, or introduce abstractions beyond what the task requires` handles most of it.

**Findings are hypotheses, not proof.** Prompt 1 will hand you a list containing real races, things you already guard against, and misreadings. Sort them by turning each into a case in the model-based or crash-injection suite. Don't let a clean audit substitute for an executable check — false confidence is the exact failure mode you're trying to design out.

**On the credential paths:** reviewing the auth chain and Roles Anywhere handling may trip Fable's safety classifiers and fall back to an Opus model mid-run. Benign request, just don't be thrown by it.
