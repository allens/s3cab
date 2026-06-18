# The npm package ships source, not the bundle

npm installs a file tree and resolves imports, so the package ships the plain `src/` modules
with `bin` pointing at the entry — no bundle, no build step on publish. (The SEA channel is
separate: [0016](0016-native-executable-build.md).)

## Why

Readable source over an opaque blob is the [0002](0002-no-lock-in-hard-constraint.md) /
[0007](0007-plain-js-via-jsdoc.md) choice: the code you install is the code that runs.

## Consequences

- The `files` allowlist uses **negation** (`"!src/**/*.test.mjs"`) to keep co-located tests out
  of the tarball — verify with `npm pack --dry-run` after touching it.
- The **AWS SDK is a normal npm `dependency`** here; in the SEA channel the same dep is inlined
  into the bundle. One dependency, two fates.
- **Publishing uses npm Trusted Publishing (OIDC)** — no long-lived `NPM_TOKEN`; provenance
  attestation comes free (fits [0002](0002-no-lock-in-hard-constraint.md)). Needs npm ≥ 11.5.1.
  A guard fails the job if the tag ≠ `package.json` version. Only a semver prerelease
  (`v*-alpha.N`) goes to npm's `next`; a plain `v0.x` publishes to `latest`.
