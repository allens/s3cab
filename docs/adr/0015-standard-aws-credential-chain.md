# Standard AWS credential chain; bespoke SSO login removed

**Status:** accepted

Credential resolution is `resolveCredentials` in [src/lib/auth.mjs](../../src/lib/auth.mjs):
s3cab's layered env files → the standard AWS SDK credential chain → an actionable error.
s3cab never writes `~/.aws/*`. Full model and history: [docs/design/auth.md](../design/auth.md).

## The decisions

- **Files beat the shell ("Model A").** A value in an s3cab env file wins over the inherited
  environment, enforced by s3cab's own merge (built-in `util.parseEnv`, no dotenv dep —
  [0005](0005-builtins-over-dependencies.md)).
- **Set layer**, not per-dir. `~/.s3cab/sets/<set>/env` (written by `setup`) is wired into
  `loadEnv({ set })`; `backup`/`status`/`list --remote` consume it. Local set commands need no
  credentials, so they don't ([0014](0014-backup-sets.md)).
  _(The decision stands; the wiring named here does not — `loadEnv` is gone and the set layer
  is applied by `loadSet`. See [0022](0022-prepare-remote-set-front-door.md), as amended.)_

## The removed SSO login — don't rebuild it

A bespoke SSO `login` command was built and **deliberately removed** (2026-06), along with its
`credential-process` companion and the `~/.s3cab/auth.json` session cache. Interactive sign-in
is the **AWS CLI's job**; s3cab consumes the session via the standard chain. The planned
alternative for long-lived keys (mainly non-AWS providers) is an optional **OS secure-storage**
layer (DPAPI / Keychain / libsecret, via OS CLIs — no native dep), slotting into
`resolveCredentials` as another source. The once-open "bespoke SSO vs standard chain" question
is **settled** in favour of the standard chain.
