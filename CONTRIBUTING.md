# Contributing to s3cab

Thanks for wanting to help. The public s3cab repository is licensed
**GPL-3.0-or-later** and always will be; contributions are welcome and stay GPL for
everyone. (The CLA below adds the option to *also* offer the same code under other terms
in future — it never removes the GPL.)

## Before you write code

Read **[CLAUDE.md](CLAUDE.md)** — it documents the architecture, the design philosophy,
and the conventions the codebase is held to (built-ins over dependencies, minimal
surface area, no third-party test framework — tests use Node's built-in `node:test`,
and so on). A change that fits the design lands far faster than one that fights it.

## Contributor License Agreement (one-time)

s3cab keeps the option, in future, to offer the same code under additional terms (e.g. a
commercial licence alongside the GPL — the standard dual-licensing model). For that to be
possible, contributions are accepted under a lightweight **[Contributor License
Agreement](CLA.md)**. You keep the copyright to your work; you grant the project a broad
enough licence to relicense it, and every contribution stays available to everyone under
the GPL regardless.

**Signing is one comment, once.** On your first pull request, add a comment containing
exactly this sentence (the agreement is in [CLA.md](CLA.md)):

> I have read the s3cab CLA and I agree to it.

That covers all of your future contributions. There is no form to fill in or send.

## Submitting changes

1. Open an issue first for anything non-trivial, so the approach can be agreed before you
   invest the work.
2. Keep each pull request to one logical change. A small refactor or doc fix riding along
   with a feature is fine; unrelated changes belong in separate PRs.
3. Make sure the project's lint, type-check, and tests pass (see [package.json](package.json)
   scripts and the [README](README.md)).
4. Write tests for new behaviour — Node's built-in `node:test`, co-located as `*.test.mjs`
   (see [test/README.md](test/README.md)).

## Changes to the S3 path

Most of the suite runs offline with no credentials. The real-S3 round-trips
(backup→restore, listing, verified download) are **gated** on `S3CAB_TEST_BUCKET` and
are skipped (with a message) without it — and a fork PR can't run them in CI, because GitHub gives a
fork-triggered run no credentials by design.

So if your change touches the S3 path — [`src/lib/s3.mjs`](src/lib/s3.mjs),
[`src/lib/remote.mjs`](src/lib/remote.mjs), or the `backup` / `restore` / `status`
commands — please **run the gated suites against a bucket of your own and paste the
result in your PR**. That's how we see they pass before merge (a maintainer otherwise
reproduces the branch in-repo to run them). Any S3-compatible provider works (AWS, R2,
B2, MinIO, …); the one-time, cross-platform setup is in
[doc/integration-testing.md](doc/integration-testing.md).

## Questions

Open an issue, or reach the maintainer at allen@shiels.dev.
