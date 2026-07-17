# Cutting a release

How to **check** the release pipeline and how to **cut** a real release of s3cab. This is the
*operator procedure*; the workflow internals (build matrix, signing, OIDC publish) are
documented where they live, in the comments of
[.github/workflows/release.yml](../.github/workflows/release.yml) — this guide doesn't repeat
them.

> A release ships two things from one `v*` tag: the **npm package** (source — the `files`
> allowlist, not a build) and a **GitHub Release** carrying the four native binaries plus the
> portable `dist/s3cab.js` bundle. Both are gated on the tag and on the build passing.

---

## Two ways the workflow runs

| Trigger | What runs | Publishes? |
| --- | --- | --- |
| **`workflow_dispatch`** (manual, any branch) | verify → build (4 native binaries + macOS sign + archive) → bundle | **No.** The `release` and `publish-npm` jobs are gated on `refs/tags/`, so they're skipped. |
| **push of a `v*` tag** | the same, **plus** the GitHub Release and the npm publish | Yes — to npm and GitHub. |

This split is what makes a **safe dry run** possible: a manual dispatch exercises the whole
heavy half of the pipeline (the part that rots when releases sit idle — action versions, the
pinned Node, the SEA build, glibc floor, codesign) and produces **no outward artifact** — no
npm publish, no GitHub Release, no version number consumed.

### Dry run (recommended after any long gap)

```sh
gh workflow run release.yml --ref main
gh run watch        # or: gh run list --workflow=release.yml
```

Green means the machinery still builds — and, when the `S3CAB_TEST_BUCKET` repo var is
configured, that each platform's **built binary** passed the gated real-S3
`setup → backup → restore` round-trip in the build job (the per-platform ship-gate,
[ADR-0049](adr/0049-centralize-cross-cutting-test-tiers.md); without the var it's skipped and
the dry run only proves the build). The only things a dry run **cannot** prove are the two
skipped steps themselves — `gh release create` and `npm publish` (the OIDC trusted-publishing
path); those only run on a real tag.

---

## Versioning

- **`package.json` `version` is the single source of truth.** The publish job fails fast if the
  git tag (minus its leading `v`) doesn't equal it — so the tag and `package.json` must always
  agree.
- **Prereleases use `-alpha.N`** (e.g. `0.1.0-alpha.1`), not `-rc`/`-beta` — one house style.
  (The old `0.0.1-rc.1` predates this convention.)
- **The leading `v` on the tag is required** (`v0.1.0-alpha.1`); the workflow only triggers on
  `v*`.

### What the version string controls

Two independent rules key off the tag (both in release.yml — summarised here, not duplicated):

| Tag shape | npm dist-tag | GitHub Release flagged |
| --- | --- | --- |
| plain `vX.Y.Z` (incl. `v0.x`) | `latest` (the default `npm install`) | **prerelease** if `v0.x`, else Latest |
| any `-suffix` (`v…-alpha.1`) | `next` (opt-in: `npm install s3cab@next`) | prerelease |

The two rules **deliberately differ**: a plain `v0.x` is a *GitHub* prerelease but still goes
to npm **`latest`**. So the lever that controls who gets a release on a plain `npm install` is
the **version string**, not the GitHub flag — a `-alpha.N` keeps it off `latest`.

> **While pre-public, prefer `-alpha.N`.** It publishes to `next` and leaves `latest` untouched,
> so the default `npm install s3cab` doesn't move to something that isn't ready. Reserve a plain
> `vX.Y.Z` (→ `latest`) for a release you mean to put in public hands.

---

## Cutting a real release

1. **Decide the version** per the rules above (e.g. `0.1.0-alpha.1` for a preview, `0.1.0` for a
   public cut).
2. **Bump `package.json` (+ `package-lock.json`) via a PR.** `main` is protected — no direct
   pushes — so the bump rides a small `chore/release-<ver>` branch through the required `ci gate`
   check and merges like any other change:
   ```sh
   git checkout -b chore/release-0.1.0-alpha.1
   npm version 0.1.0-alpha.1 --no-git-tag-version   # edits package.json + lock, no commit/tag
   git commit -am "chore: release 0.1.0-alpha.1" && git push -u origin HEAD
   gh pr create --fill && gh pr merge --squash       # once ci gate is green
   ```
3. **Tag the merged commit** on `main` with the matching `v` tag and push the tag (tags aren't
   branch-protected):
   ```sh
   git checkout main && git pull
   git tag v0.1.0-alpha.1 && git push origin v0.1.0-alpha.1
   ```
   The tag's commit must be the one where `package.json` already equals the version — i.e. *after*
   the bump PR merges — or the release job's tag-vs-package guard fails.
4. The tag push triggers release.yml: it re-verifies, builds + signs + archives all four
   binaries, creates the GitHub Release (prerelease-flagged per the table), and publishes to
   npm with provenance under the right dist-tag.
5. **Confirm:** `npm view s3cab dist-tags` and the repo's Releases page.

A published npm version is **immutable** — you can't re-publish the same number, and unpublishing
is restricted. Pick the number deliberately.

---

## Where the rest lives

- **Why it builds natively per-runner, the macOS labelling, packaging decisions** —
  [ADR-0016](adr/0016-native-executable-build.md) and the release.yml header comment.
- **Why npm ships source, not the binary** — [ADR-0017](adr/0017-npm-ships-source.md).
- **The OIDC trusted-publishing setup** (no long-lived `NPM_TOKEN`) — the `publish-npm` job
  comments in release.yml.
