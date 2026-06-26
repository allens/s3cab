# Cloud onboarding — the `bucket` command

Epic: make first-run onboarding as painless as possible while staying secure — help a user
stand up a cloud backup *destination* (an S3 bucket) **and** a locked-down identity for s3cab
to use, without s3cab becoming a manager of cloud infrastructure.

Status: **designed, not built.** Grilled to closure 2026-06-26 (see the decisions below). The
one decision worth pinning as a decision-of-record — *generative, not active* — is
[ADR-0032](../docs/adr/0032-generative-onboarding-not-active-provisioning.md); the rest stays
here until build time. Provisional command name **`bucket`** (sleep-on-it rename allowed
pre-1.0).

## The problem

Today a new user who wants their own bucket has to know, unaided: that they need a bucket;
that pointing their `admin` profile at s3cab is a bad idea; that they should mint a
least-privilege identity instead; what S3 actions that identity needs; that they want
versioning + lifecycle; and where the resulting key goes. That is a lot of undocumented
tribal knowledge, and it is the friction this command removes.

The north star (the user's words): **make onboarding as painless as possible, in a secure
way.** Everything below is subordinate to that.

## Decision 1 — Generative, not active (pinned: ADR-0032)

s3cab **prints** the exact commands + policy/JSON for the user to run; it does **not** call
AWS APIs to create things itself. Rationale and the rejected "active" alternatives (incl. the
tempting bucket-only-active variant) live in [ADR-0032](../docs/adr/0032-generative-onboarding-not-active-provisioning.md).
The short version: active only helps AWS users who already have admin creds (≈ already have
the CLI, so can paste), optimizes the *cheap* steps while the fiddly key/secret steps stay
manual anyway, and reintroduces s3cab wielding admin power + owning secrets — the posture
[ADR-0015](../docs/adr/0015-standard-aws-credential-chain.md) deliberately shed. Generative
serves *every* provider (incl. the IAM-less ones) at near-zero cost and full transparency.

A future optional `--run` for the **non-secret** bucket steps (create/versioning/lifecycle,
which need no IAM dep and handle no secret) is *not ruled out forever* — but it is explicitly
out of scope for v1 and was considered-and-rejected for now (ADR-0032).

## Decision 2 — Three pieces; only the identity step forks

The feature decomposes cleanly, which is what keeps the SSO/non-AWS variants small:

1. **Bucket setup** — create + versioning + lifecycle. *Identity-agnostic*; same for everyone.
2. **The policy** — `bucketPolicy()` JSON. *Identity-agnostic*; same JSON, only *how you
   attach it* differs.
3. **Identity** — the only A/B fork:
   - **A — IAM user** (default, simplest): create user → attach policy → create access key →
     wire via `aws configure` / `s3cab aws --profile`.
   - **B-light — reuse your existing SSO identity** (the common SSO case): attach the policy to
     the permission set/role you already sign in with → `aws sso login` → `s3cab aws --profile`.
   - **B-dedicated — a locked-down s3cab-only permission set** (advanced/optional): more setup,
     tighter scope. Console-first hints + a CLI appendix with `<placeholders>` (the IDs can't be
     pre-filled). Captured for completeness; prune later if it earns its keep.
   - **Non-AWS** (R2/B2/Wasabi/…): no IAM exists — best-effort console steps + a ready-to-paste
     `~/.s3cab/env` template (endpoint/key/secret). Auto-selected when an endpoint is set.

We do **not** teach standing up IAM Identity Center from scratch (heavy, tiny audience,
re-treads removed login ground — [ADR-0015](../docs/adr/0015-standard-aws-credential-chain.md)).
Worth a one-line doc acknowledgement that AWS now funnels even basic users toward Identity
Center over IAM users, so we are not seen as pushing a deprecated path.

## Decision 3 — The AWS security model

The everyday identity and the bucket together give a backup tool the property it should have:
**a leaked everyday key can add to your backup and tweak its own set markers, but can never
*permanently destroy* your content or history.**

- **One everyday identity** (no extra users for the common case). Policy = explicit verbs
  `s3:GetObject` / `s3:PutObject` / `s3:DeleteObject` on `<bucket>/*` plus `s3:ListBucket` on
  `<bucket>`. (Per-prefix scoping — append-only on `objects/`+`snapshots/`, delete only on
  `sets/` — was analyzed and **parked**: with versioning as the backstop the marginal gain is
  small and it adds policy surface. Revisit only if identities split or versioning is dropped.)
- **`DeleteObject` is in** — it's already required by `setup` (the stale-`exclude.txt` cleanup
  in `set-marker.mjs`) and by the future cleanup command. It is the *soft* delete: on a
  versioned bucket it writes a delete marker; the bytes survive as a noncurrent version.
- **The privilege seam is soft-vs-permanent, not per-prefix.** The everyday key has
  `DeleteObject` but **not** `DeleteObjectVersion`, so it can never truly destroy. An optional,
  **rare** elevated identity holds `DeleteObjectVersion` — needed only to reclaim space *before*
  the lifecycle window or to permanently scrub. Most users never create it.
- **Versioning ON** is the backstop that makes the above safe.

### Bucket config the command generates

| Setting | Value | Why |
| --- | --- | --- |
| Versioning | Enabled | recover any deleted/overwritten backup |
| Lifecycle: noncurrent version expiry | ~90 days | the disaster-recovery window; a documented cost/safety **dial** (longer = safer, shorter only to reclaim pruned space sooner). In a CAS store this costs ≈0 in steady state — objects are immutable, so noncurrent versions arise only from deletes. |
| Lifecycle: abort incomplete multipart | 1 day | pure waste with zero recovery value (s3cab does not resume multiparts). Raise only if a *single file* legitimately takes >24 h to upload. |
| Lifecycle: current-object expiry | **none** | the cardinal sin — never auto-delete live backups. |

## Decision 4 — Dogfood the policy; keep lifecycle apart

The least-privilege bucket policy currently exists **twice and disagrees with itself**:
`bucketPolicy()` in `src/lib/s3.mjs` (emits `s3:*Object`, and is otherwise **dead code** —
no caller) and the hand-written JSON in `docs/integration-testing.md` §1 (explicit
`Get/Put/Delete`). The onboarding command would be a third copy.

- **Unify on `bucketPolicy()`** with the **explicit verbs** (`Get/Put/Delete` + `ListBucket`).
  The command emits it and the testing doc references the same source. This finally gives the
  dead `bucketPolicy()` a caller. With explicit verbs the everyday backup policy is *identical*
  to the test policy, so one definition genuinely serves both.
- **Do NOT share lifecycle.** Test bucket expires **current** objects after 1 day (cost cap +
  self-heal); backup bucket expires **noncurrent** versions after 90 days and never touches
  current objects. They are deliberately opposite and must never be unified — accidentally
  doing so would expire someone's backups. (`scripts/setup-test-bucket.mjs` stays the test-only
  active provisioner; its us-east-1 `LocationConstraint` handling is the shared *knowledge* the
  generated bucket command mirrors.)

## The command

- **Name:** `bucket` (provisional). Noun-command (à la `git remote`); honest for a generative
  command (does not over-claim creation); `bucket` is already first-class s3cab vocabulary.
- **Separate top-level command, not part of `setup`.** Provisioning is a rare, one-time,
  per-bucket bootstrap; `setup` is a per-set operation run many times. Also **outside the `aws`
  command's concern** — `aws` is the narrow "point at an *existing* profile" door
  ([ADR-0031](../docs/adr/0031-aws-profile-config-door.md)); `bucket` is "create the destination
  + scoped identity." They *compose*: `bucket`'s final step is `s3cab aws --profile <name>`.
- **Generative ⇒ local & offline.** Calls no AWS APIs, needs no credentials to *run* — you can
  read the whole plan before you have any creds. All output to stdout
  ([ADR-0010](../docs/adr/0010-cli-output-conventions.md)).
- **Flags:**
  - positional `<bucket>` (required) — the bucket name.
  - `--sso` (boolean) — print the SSO recipes (B-light, then a clearly separated advanced
    B-dedicated block) instead of the IAM-user recipe. Boolean rather than `--identity iam|sso`
    so the simplest user (who may not know "IAM") types nothing for the default, and `--sso` is
    the term its own audience reaches for. The default (IAM) output ends with a one-line *"Using
    AWS IAM Identity Center / SSO? Re-run with --sso"* pointer, so SSO is advertised, not hidden.
  - `--profile <name>` — optional output *sugar*: interpolated into the printed `aws …` commands
    (`--profile admin`); omitted otherwise. Never *used* (generative).
  - `--region <region>` — for the bucket-creation command; defaults like the test-bucket script.
    The us-east-1 `LocationConstraint` quirk is handled in the generated text.
  - Non-AWS is **auto-detected** (an `AWS_ENDPOINT_URL_S3` / `AWS_ENDPOINT_URL` present), not a
    flag.

### Output UX (default IAM path)

`s3cab bucket my-backups --region eu-west-1 --profile admin` prints numbered, goal-framed steps
([ADR-0030](../docs/adr/0030-error-message-guidelines.md)), each with a copy-pasteable command
on its own line. Sequential by necessity — step 4 emits the secret step 5 consumes, so it is
human-in-the-loop, not one paste-all. JSON is printed inline and saved to `policy.json` /
`lifecycle.json`, referenced via `file://` (avoids cross-shell quoting hell).

```
To set up "my-backups" as an s3cab backup destination on AWS, run these steps.

1. Create the bucket:
   aws s3api create-bucket --bucket my-backups --region eu-west-1 \
     --create-bucket-configuration LocationConstraint=eu-west-1 --profile admin

2. Turn on versioning — your safety net, so a deleted or overwritten backup
   stays recoverable:
   aws s3api put-bucket-versioning --bucket my-backups \
     --versioning-configuration Status=Enabled --profile admin

3. Add lifecycle rules (reclaim deleted space after 90 days; clear stalled
   uploads after 1). Save as lifecycle.json:
   { …the rules… }
   aws s3api put-bucket-lifecycle-configuration --bucket my-backups \
     --lifecycle-configuration file://lifecycle.json --profile admin

4. Create a locked-down identity for s3cab. Save as policy.json:
   { …bucketPolicy("my-backups")… }
   aws iam create-user --user-name s3cab --profile admin
   aws iam put-user-policy --user-name s3cab --policy-name s3cab-backup \
     --policy-document file://policy.json --profile admin
   aws iam create-access-key --user-name s3cab --profile admin

5. Point s3cab at the new key (paste the key + secret from step 4):
   aws configure --profile s3cab
   s3cab aws --profile s3cab

Next — create a backup set in this bucket:
   s3cab setup <name> <folder>... --bucket my-backups

Using AWS IAM Identity Center / SSO instead? Re-run with --sso.
```

- `--sso` swaps steps 4–5 for **B-light** (save `policy.json` → "attach as an inline policy to
  the permission set you already sign in with" → `aws sso login` → `s3cab aws --profile <sso>`),
  then a separated `--- Advanced: a dedicated s3cab-only identity ---` block (console-first
  hints + placeholder CLI appendix).
- **Non-AWS** swaps to provider-neutral guidance: create the bucket + a scoped token in the
  provider console, enable versioning if supported, then a ready-to-paste `~/.s3cab/env`
  template → `setup`.

## The cleanup relationship (informs this, but is its own future command)

This design assumes a future **cleanup** command (name TBD — avoid `gc`/`prune` jargon per
[ADR-0012](../docs/adr/0012-consumer-vocabulary-naming.md)). It is classic **mark-and-sweep**
over the bucket-*global* object pool ([ADR-0013](../docs/adr/0013-one-repository-one-bucket.md)):

1. Read **every snapshot of every set** (from the **remote** — the authoritative copy) to mark
   the live set of hashes. Marking from one set's snapshots would delete objects another set
   still needs — the #1 way CAS GC eats live data.
2. Sweep `objects/` for unreferenced orphans and `DeleteObject` them (soft).

Key insight: **snapshot deletion is the precondition for cleanup.** While any snapshot
references a hash, that object is live; an object becomes an orphan only when the last snapshot
referencing it is pruned. So `objects/` grows monotonically until old snapshots are deleted.
Snapshots are therefore "append-only in everyday use, pruned during retention" — the same
category as objects, not a separate one. Retention *policy* (keep-last-N, time-based, GFS) is
its own future design.

Cleanup runs on the **everyday key** (all soft-deletes; versioning backstops even a buggy
sweep — recoverable for 90 days, which also cushions the classic mark-while-uploading race).
Space comes back **automatically** via the lifecycle within the window — most users never need
the elevated `DeleteObjectVersion` identity.

## Parked / out of scope (recorded so they aren't lost)

- **Storage access tiers.** Cost is a first-class concern and the intent is to use **cheap
  async storage** (Glacier / Deep Archive family). s3cab already uploads AWS objects with
  `StorageClass: INTELLIGENT_TIERING` (provider-compat finding #2) — a good baseline. Two things
  to chew on when this is picked up: (a) async tiers make `restore` a **two-phase** operation
  (initiate retrieval → wait hours → download) — a real shape change to the restore command, not
  just a config knob; (b) Intelligent-Tiering does not monitor objects <128 KB, and a CAS store
  can have *many* tiny objects, so the small-file cost story needs its own look.
- **Per-prefix IAM policy** (see Decision 3) — the natural future tightening if identities split
  or versioning is dropped; not v1.
- **`--run` active mode** for the non-secret bucket steps — see Decision 1 / ADR-0032.
- **`emptyBucket()`** in `src/lib/s3.mjs` is currently **dead code** (no caller) — a future
  delete/teardown primitive. Flagged here, not removed (convention #6).

## Build-time follow-ups

- Switch `bucketPolicy()` to explicit verbs and give it its first caller; point
  `docs/integration-testing.md` §1 at the same source.
- ADR-ify the security model + command shape at build time (left in this proposal for now to
  avoid churn while unbuilt).
- Settle the final command name and the cleanup command's name.
- Add glossary terms for the command + cleanup once their names settle (orphan is added now,
  being name-independent).
