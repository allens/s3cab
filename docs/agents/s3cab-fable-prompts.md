# s3cab pre-release prompts for Claude Fable 5

Ordered by contribution to one goal: **reducing the risk that a backup reports success and cannot be restored.**

Everything here assumes Claude Code with `/effort` set per prompt. Run 1 and 2 before 3 and 4 — their findings become the target list for the test work. Run 1 before you freeze the format for 1.0, because a real durability flaw may want a change to the bucket layout, and that is cheap now and expensive later.

Where a prompt says "analysis only", keep it that way. The whole point of the first two is an independent opinion you can compare against your own; letting the same session fix what it finds contaminates that.

Prompt 7 sits last because it contributes least to restore risk on AWS, which is where most people will run this. It is still a release blocker, for a different reason: you currently advertise compatibility with three object stores whose versioning and multipart behaviours differ, and nothing checks it. Treat its position as "last of the things you must do", not "optional".

---

## 1. Repository protocol model and durability audit

**Effort: xhigh. Analysis only, no code changes. Expect a long single run.**

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

## 2. Independent restorer built from the spec alone

**Effort: xhigh. Start this in a fresh session with no prior context.**

> s3cab's core promise is that its stored format is open enough that you could recover everything without the tool, or write a replacement in an afternoon. I want to test that claim literally rather than take my own word for it.
>
> Read `guide/format.md` and nothing else from this repository. Do not open `src/`, the other guides, the ADRs, or the tests at any point — if you find yourself wanting to, that is itself a finding: record what you needed and why. Working only from the spec, implement a minimal independent restorer in Python: given a bucket and a snapshot, reconstruct the files byte-for-byte.
>
> Then verify it differentially. I'll give you credentials for a test bucket with several real repositories in it. For each snapshot, restore with your implementation and with s3cab, and compare the results byte-for-byte including paths and modification times. Investigate every difference.
>
> Deliverable: the restorer, and a report on the spec itself. List every point where `format.md` was ambiguous, silent, or wrong — anywhere you had to guess, and what you guessed. Rank those by whether a wrong guess would corrupt a restore or merely inconvenience the implementer. That list is the real output; the code is the means of finding it.

---

## 2b. Second clean-room restorer, against the revised spec

**Effort: xhigh. Start in a fresh session with no prior context — the run is void if the session has ever opened `docs/format-spec-audit.md`, anything under `scripts/cleanroom/`, or `docs/design/repository-protocol.md`.** Prompt 2's findings were folded back into `guide/format.md` (the sixteen pinned ambiguities, the hoisted reading rules, ADR-0082's `#END` trailer), so a second fresh reader now tests the fixes rather than the original text. When it reports, diff its ambiguity list against `docs/format-spec-audit.md` yourself: a reappearing item is a fix that didn't land, a new one is a fresh gap. The session must see neither list beforehand — hand it this prompt and nothing else.

> s3cab's core promise is that its stored format is open enough that you could recover everything without the tool, or write a replacement in an afternoon. The spec has been revised since that claim was last tested, and I want it tested again by a fresh reader.
>
> Read `guide/format.md` and nothing else from this repository. Do not open `src/`, the other guides, the ADRs, `docs/`, or the tests at any point — in particular not `docs/format-spec-audit.md`, anything under `scripts/cleanroom/`, or `docs/design/repository-protocol.md`, artifacts of earlier independent runs whose findings must not reach you. If you find yourself wanting any of them, that is itself a finding: record what you needed and why. Working only from the spec, implement a minimal independent restorer in modern C++ on Ubuntu LTS: the newest standard the distribution's own default compiler already supports, and only libraries it packages. Don't build a compiler or a library from source, and don't spend the run fighting a toolchain — if something you want isn't packaged, choose a different library. Given a bucket and a snapshot, reconstruct the files byte-for-byte. Libraries for transport, hashing and decompression are expected — the clean-room constraint is where the format knowledge comes from, not the dependency count.
>
> Then verify it differentially. I'll give you credentials for a test bucket with several real repositories in it. For each snapshot, restore with your implementation and with s3cab, and compare the results byte-for-byte including paths and modification times. Investigate every difference.
>
> Deliverable: the restorer, and a report on the revised spec. List every point where `format.md` was ambiguous, silent, or wrong — anywhere you had to guess, and what you guessed. Rank those by whether a wrong guess would corrupt a restore or merely inconvenience the implementer. That list is the real output; the code is the means of finding it.

---

## 3. Model-based test suite with restore as the invariant

**Effort: high. This is the long autonomous run — expect hours. Tier 1 needs nothing external; Tiers 2/3 use a pre-provisioned bucket named in the prompt.**

> I want s3cab's test suite to be strong enough that I'd stake real data on a green build. The property I care about is not coverage, it's that every snapshot the tool reports as backed up can be restored byte-for-byte.
>
> Build a model-based test harness. Maintain a model of expected repository state, generate random valid command sequences (`snapshot`, `backup`, `forget`, `cleanup`, `restore`, `verify`, `reattach`), and after every step assert the invariants: every snapshot listed as complete restores byte-identically; every stored object's content matches its name; identical content is stored exactly once; no snapshot references a missing object; `cleanup` and `forget` never remove a referenced object; and `verify`'s verdict agrees with the model. On failure, shrink to a minimal reproducing sequence.
>
> **Make the storage backend a parameter of the harness from the start**, not something bolted on later. Two backends ship with the suite: an in-memory fake at the `s3.mjs` seam, and real S3 reached through the environment (bucket, credentials, `AWS_ENDPOINT_URL_S3` for a custom endpoint) — which is how the same suite later runs unmodified against other S3-compatible providers. Where a test can only pass on a backend with a particular capability, express that as a declared capability requirement the test skips on, rather than an assumption baked into the test body. Keep a written list of every capability the suite depends on — versioning, delete markers, lifecycle expiry of noncurrent versions, multipart, conditional writes, listing semantics — because that list is the real compatibility contract and I'll want it separately. The fake declares only the capabilities it truly models: an optimistic fake that claims what it fakes poorly is how a suite passes against broken code.
>
> Then split the runs into three tiers:
>
> - **Tier 1, in-memory fake, per-commit and nightly.** The high-volume loop: thousands of sequences, full shrinking, and all fault injection. The backend is an in-process fake behind the `s3.mjs` seam — the seam ADR-0019 already designates for deterministic error injection — modelling only the operations s3cab actually performs, not S3 at large. Add a fault-injecting layer in front of the backend that can produce throttling, 500s, timeouts, truncated responses, and duplicated requests, with a seed so any failure replays identically. No container, no credentials: this tier must run anywhere, including Windows CI runners and fork PRs.
> - **Tier 2, real AWS S3, pre-release and nightly.** A much smaller conformance subset — tens of cases, not thousands — targeting exactly where the fake is most likely to diverge from the real thing: versioning and delete-marker behaviour, multipart ETag format, conditional-write atomicity if the set-name claim relies on it, listing pagination past a thousand keys, delimiter handling with awkward key names, real throttling responses, and credentials expiring mid-run.
> - **Tier 3, real AWS, manual or scheduled slow-clock.** The things that need wall time, chiefly lifecycle expiry of noncurrent versions, which is the mechanism by which `cleanup` actually reclaims space. If it can't be tested in a normal run, write down the procedure and how often to run it.
>
> The real-AWS bucket for Tiers 2 and 3 already exists: `test-s3cab-allen-conformance` (eu-west-1, versioning enabled, versioned-aware expiry baseline), reached via the `test-s3cab-allen` AWS profile. It is reserved for this harness as its sole owner, so whole-bucket assertions are safe, and its lifecycle configuration is yours to mutate. The scoped identity deliberately cannot flip bucket versioning (`s3:PutBucketVersioning` is denied) — treat versioned-ness as fixed at provisioning. The naming convention and both bucket subtypes are documented in `docs/integration-testing.md` ("Create a bucket"); when you wire up the nightly Tier 2 run in CI, provision `test-s3cab-ci-conformance` with `node scripts/setup-test-bucket.mjs --conformance` — the CI role's policy already covers `test-s3cab-ci-*`.
>
> Pair all of this with a generator of hostile file trees. s3cab is Windows-first, so cover paths beyond MAX_PATH, reserved device names, trailing dots and spaces, mixed-case collisions, unicode and normalisation differences, junctions, symlinks, hardlinks, zero-byte files, files above the multipart threshold, files with implausible timestamps, and files that change or vanish mid-scan.
>
> Prove the suite works rather than assuming it. Seed a set of deliberate bugs — a skipped upload, an off-by-one in the hash comparison, a `cleanup` that ignores one snapshot, a path normalisation error — and confirm the harness catches each one and shrinks to something a human can read. A suite that passes against broken code is worse than no suite. Do the same across tiers: seed a bug that only manifests under real S3 semantics and confirm Tier 2 catches what Tier 1 misses.
>
> Fit the project's existing conventions in `CLAUDE.md`, keep Tier 1 within a sensible CI time budget with a longer nightly mode, and don't refactor production code beyond what the tests require. Establish a way to check your own work as you build: every hour or so, dispatch a fresh-context subagent to verify what you've produced against this brief. Before reporting progress, audit each claim against a tool result — if tests fail, say so with the output; if you skipped something, say that.

---

## 4. Crash injection and multi-machine concurrency

**Effort: high. Run after 1, using its findings as the target list.**

> Separate from the property tests, I want a harness that specifically attacks the two conditions most likely to produce an unrestorable backup: interruption and concurrency.
>
> For interruption: kill the process at every point where a multi-step transition can be torn — between object uploads, between the last object and the snapshot write, mid-multipart, during `cleanup`'s delete pass, during `forget`. After each kill, assert the repository is in a restorable state, that no snapshot references a missing object, and that re-running the command recovers cleanly rather than compounding the damage.
>
> For concurrency: this must be genuinely multi-process, since one bucket is designed to hold sets from several machines sharing `objects/`. Run backups and maintenance commands simultaneously from separate processes with separate s3cab homes against one bucket, in every combination, and assert the same invariants throughout. Pay particular attention to a `cleanup` overlapping an in-flight `backup` whose objects are uploaded but whose snapshot file is not yet written.
>
> Report findings as you go rather than only at the end. If a scenario is genuinely safe, say why and name the mechanism.

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

> This repo has `docs/adr/`, `guide/format.md`, `CONTEXT.md`, and 465 commits of history. Tell me where the code no longer matches what those documents say.
>
> Go through the ADRs and the format spec and check each documented decision against current behaviour. I want three lists: decisions the code has quietly diverged from; behaviour the code has that no document records; and documents describing things that no longer exist. Use the commit history to work out when a divergence happened where that's cheap to establish.
>
> For each item say whether the document or the code should change. Report and stop — don't edit either.

---

## 7. Provider conformance suite

**Effort: high. Run after 3, reusing its backend abstraction. Needs an account with each provider.**

> s3cab advertises support for AWS S3 and for S3-compatible providers including Cloudflare R2, Backblaze B2 and Wasabi. Nothing currently verifies that claim, and these providers differ in exactly the areas s3cab's safety properties rest on. I want a conformance suite and an honest support matrix before 1.0.
>
> Start from the capability list produced by the test harness in the previous piece of work — the things s3cab depends on the object store doing. Build a suite that probes each capability directly against a live provider and reports what it actually does, rather than whether s3cab happens to pass. At minimum: bucket versioning and whether deletes become delete markers; whether noncurrent versions are listable and restorable; lifecycle rules for expiring noncurrent versions, or their absence; multipart upload thresholds and the ETag format returned; conditional writes and whether `If-None-Match` is genuinely atomic under contention; listing pagination past a thousand keys and delimiter handling; error codes and throttling behaviour under load; checksum and storage-class support; and the semantics of overwriting an existing key.
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

**Give it a sandbox that can actually execute.** The test buckets are already stood up — prompt 3 names its conformance bucket, and Tier 1's in-memory fake needs nothing external. The value here is in verification loops, and a model that can only read code is doing a fraction of the work you're paying for.

**Let it keep notes between runs.** A `notes/` directory with one lesson per file, referenced at the start of each session, meaningfully improves later runs on the same codebase.

**Add a scope brake if it starts tidying.** At high effort it will refactor things you didn't ask about. `Don't add features, refactor, or introduce abstractions beyond what the task requires` handles most of it.

**Findings are hypotheses, not proof.** Prompt 1 will hand you a list containing real races, things you already guard against, and misreadings. Prompts 3 and 4 are how you sort them. Don't let a clean audit substitute for an executable check — false confidence is the exact failure mode you're trying to design out.

**On the credential paths:** reviewing the auth chain and Roles Anywhere handling may trip Fable's safety classifiers and fall back to Opus 5 mid-run. Benign request, just don't be thrown by it.
