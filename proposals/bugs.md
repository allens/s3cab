# Bugs / correctness suspicions

> **Interim home — must reach zero before release.** Bugs belong in **GitHub Issues**, but the
> repo won't use Issues until pre-release. So this file is the stop-gap tracker in the
> meantime. It is the **one file in `proposals/` that should be gone by release** — i.e. *no
> known bugs* at ship. After that, file bugs as GitHub Issues, not here.

<sub>Last cleared 2026-07-19: the HIGH baseline-trust hole (`backup` trusting a local
`--since` baseline whose remote snapshot a `forget` + `cleanup --delete` had since removed —
publishing a snapshot referencing a deleted object) was fixed by trusting the baseline **iff
it still exists remotely**: `uploadSnapshot` HEADs the baseline's remote snapshot before
believing it, and on a miss drops the baseline and LISTs the store as a first backup would.
The same check also covers a baseline snapshotted locally but never uploaded. The deletion
rework's interlock — subtracting deletion-record hashes from any trusted baseline — landed
with the path-scoped `delete`
([ADR-0064](../docs/adr/0064-path-scoped-delete-deletion-record.md)). The name-only HEAD that
fix introduced has since become a byte-identity GET
([ADR-0084](../docs/adr/0084-snapshot-identity-byte-equality.md), 2026-08-14).</sub>

---

<sub>An **adversarial durability audit of the 1.0 format freeze** (2026-08-12, Claude Fable at
xhigh reasoning, reading `88fbc70`) contributed five entries; its brief was the one failure that
matters — *a backup that reports success but cannot be restored*. Each entry was pinned by a
deterministic current-behaviour test in the model-based suite ([test/model/](../test/model/)),
and **all five are fixed, 2026-08-14**, their pinning tests flipped to the correct behaviour: a
file mutated *during* its upload stored as wrong bytes under a right hash, by `putFile`'s
streamed-digest check ([ADR-0083](../docs/adr/0083-streamed-digest-upload-guard.md)); `backup`
exiting 0 with unreadable files, by setting `process.exitCode = 1` whenever the pass recorded
`#ERROR` rows; the pair rooted in snapshot *names* not identifying snapshots — another machine's
same-name snapshot vouching for a never-uploaded baseline, and a retried manifest PUT harvesting
a 412 from its own lost-response success — by keying both checks on byte-identity with the local
file ([ADR-0084](../docs/adr/0084-snapshot-identity-byte-equality.md)); and the mtime-precision
staleness escape (a same-size rewrite that puts the old mtime back, confirmed on real NTFS), by
distrusting any size+mtime match whose ctime postdates the baseline's instant
([ADR-0085](../docs/adr/0085-ctime-cross-check-on-hash-reuse.md)). The audit's full report —
state model, reproduction sequences, and the **ruled-out** list (what was attacked and which
guard held) — is kept **outside the repo** as `s3cab-durability-audit-2026-08-12.pdf`; the state
model is now [docs/design/repository-protocol.md](../docs/design/repository-protocol.md).
Headline result: the objects-first/snapshot-last invariant **holds under process termination at
every step** — what broke was concurrency and time.</sub>

<sub>The model-based test suite itself (prompt #3, 2026-08-14) found three more, **all fixed
2026-08-14**, each pinned by a test that now asserts the correct behaviour: a truncated stored
manifest parsing as a valid empty snapshot while `verify` called the store healthy, by the
`#END` trailer ([ADR-0082](../docs/adr/0082-snapshot-end-trailer.md)); case-colliding manifest
paths restoring to one silently-overwritten file with exit 0 — the same hazard APFS's
unicode-normalisation folding poses for NFC/NFD neighbour paths — by keying collision detection
on the filesystem's own equivalence rather than lowercasing
([ADR-0086](../docs/adr/0086-restore-collision-filesystem-equivalence.md)); and the latent
percent-encoding of non-ASCII S3 keys (`parseS3Uri` took `new URL(...).pathname`, so a set
named `café` — reachable only if `validateSetName`'s `[a-z0-9-]+` charset is ever loosened —
stored its manifests under `snapshots/caf%C3%A9/…`, breaking
[guide/format.md](../guide/format.md)'s promise that keys are `snapshots/<set>/…`), by parsing
the URI as a plain string split so keys reach the bucket verbatim; only the Tier 2 inspector
could see that one, since every seam call encoded identically
([test/model/conformance/store-semantics.test.mjs](../test/model/conformance/store-semantics.test.mjs)).</sub>

<sub>The two **minute-resolution name** entries are fixed, 2026-08-18, and they wanted opposite
answers. The *deletion record* stopped refusing: a second `delete` finishing inside the same
minute used to abort with "wait for the next minute" as the entire remedy — two people sharing a
bucket hit it, and CI hit it for real (2026-08-15, run
[31852887331](https://github.com/allens/s3cab/actions/runs/31852887331), two workflow runs from a
stack of back-to-back merges overlapping on the shared bucket, since serialized by the `s3
integration` job's own repo-wide `concurrency` group). A record's name is read by nobody —
`readDeletionRecords` LISTs the prefix and unions every file — so the refusal it inherited from
the snapshot name grammar bought nothing; a taken name now takes the next one (`-2`, `-3`, …),
the PUT stays conditional on every attempt, and the read side accepts `<timestamp>[-<n>].tsv`
([ADR-0087](../docs/adr/0087-deletion-record-suffix-on-collision.md)). The *snapshot* kept
refusing, because there the name is an identity users type and refusing a repeat is what stops an
accidental double-run rewriting history — what changed is the message. Confirmed live,
multi-process (2026-08-14, crash tier — *"same set, same snapshot name"* in
[test/crash/concurrency.test.mjs](../test/crash/concurrency.test.mjs)): the loser of the manifest
no-clobber race failed with *"Snapshot '…' is already backed up"*, true of the **name** and false
of the loser's **data**, which its objects-first upload had already stored. `uploadSnapshotFile`
now branches on
[ADR-0084](../docs/adr/0084-snapshot-identity-byte-equality.md)'s byte comparison: *different*
says the name holds a different backup, the files are safe, re-run to record them under the next
minute's name; *absent* (the colliding snapshot deleted between the 412 and the read) gets its
own, since "already backed up" was flatly false there. Nothing remains: two live machines on one
set is a **settled** discouraged-but-tolerated state, never locked out
([ADR-0024](../docs/adr/0024-set-name-is-the-whole-identity.md)), which is precisely why the
loser's message — not a lock — was the thing to fix.</sub>

**No known bugs** — the state this file has to be in at release, and the point at which it should
be deleted rather than kept empty. Anything found before Issues open goes back in the list here.
