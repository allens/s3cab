# `_poc/` — experimental sandbox

Proof-of-concept code for the **not-yet-built S3 upload/download path** (see the
status and design intent in [../../CLAUDE.md](../../CLAUDE.md)). This is the _only_
place the AWS SDK is currently used.

**Status:** experimental. Nothing here is wired into the live CLI
([../cli.mjs](../cli.mjs)). Some of it will be promoted into the real codebase once
the content-addressable object store (`objects/<sha256>`) milestone begins; some will
be rewritten or deleted. Treat it as a reference, not as shipping code — it is not held
to the project's type/test standards (the `tsc` helper in `.claude/settings.json`
filters it out).

## Inventory

| File | What it is | Likely fate |
| --- | --- | --- |
| [login.mjs](login.mjs) | AWS SSO/OIDC login flow | promote (SSO is the sanctioned AWS SDK use, #5) |
| [s3.mjs](s3.mjs) | S3 client wrappers (put/get/head/list) | promote, likely reshaped around `objects/<sha256>` |
| [upload.mjs](upload.mjs) | `upload-file` command, multipart + skip-if-unmodified | revisit — overlaps the planned snapshot-driven upload |
| [list-objects.mjs](list-objects.mjs) | `list-objects` command | revisit / likely drop |
| [upload.test.mjs](upload.test.mjs) | tests for `upload.mjs` (`describe.skip`, all `it.skip`) | revive with the upload path, or drop |
| [helper.mjs](helper.mjs) | mock-`$HOME` test scaffolding (points at `test/_poc/home/`) | currently unused; lives here so the test runner doesn't execute it |
| [.env.testing](.env.testing) | sets `AWS_PROFILE=s3cab-test` for the POC tests/CLI | kept until the upload path lands |

## Working on the POC

The default `npm test` gate stays free of AWS/experimental coupling: the POC suite
is `describe.skip`, so plain `node --test` reports it as skipped and needs no flags.
To actually run/iterate on it, un-skip the suite and run it directly with the
experimental module-mock flag and the AWS profile env:

```sh
node --test --experimental-test-module-mocks --env-file=src/_poc/.env.testing src/_poc/upload.test.mjs
```

To clear the test bucket between runs (was the old root `clean` npm script; removed
from `package.json` because it's POC-only and needs AWS credentials):

```sh
aws --profile s3cab-test s3 rm s3://s3cab-test --recursive
```
