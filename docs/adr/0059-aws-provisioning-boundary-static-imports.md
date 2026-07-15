# AWS provisioning is quarantined to the `aws` command; static imports over lazy loading

**Status:** accepted. Extends
[0015](0015-standard-aws-credential-chain.md) (credential acquisition is the pluggable seam),
[0056](0056-onboarding-via-cloudformation.md)/[0057](0057-roles-anywhere-credential-mode.md)
(the provisioning that this boundary contains), and applies
[0006](0006-minimal-code.md). Named the *provider boundary*.

s3cab is an **S3** backup tool that happens to target AWS first; it also targets non-AWS
S3-compatible providers (Cloudflare R2, Backblaze B2, Wasabi, MinIO — the
`s3-provider-compatibility` design doc). Two questions kept recurring: *what may depend on the
AWS CLI or on non-S3 AWS APIs?* and *may we lazy-import a heavy dependency to keep it off the
common path?* This ADR settles both, because they turn out to be the same question — **where
AWS-specific weight is allowed to sit** — and the honest answer to the second is *placement, not
a dynamic import*.

## The boundary: three planes, one quarantine

- **Data plane — the S3 protocol, everywhere.** `@aws-sdk/client-s3` + `@aws-sdk/lib-storage`
  (`src/lib/s3.mjs`). Provider-agnostic by construction; this is what lets a non-AWS endpoint work
  at all. Available to every command.
- **Auth plane — credential acquisition, pluggable.** `@aws-sdk/credential-providers`,
  `@smithy/shared-ini-file-loader`, and (for Roles Anywhere) `@smithy/signature-v4`, in
  `src/lib/auth.mjs` / `aws-profiles.mjs` / `roles-anywhere.mjs`. These are AWS-specific but
  intrinsic to *authenticating to S3 itself* ([0015](0015-standard-aws-credential-chain.md)), so
  they legitimately run on every remote command. A non-AWS provider slots its own (usually static
  keys) into the same seam. **This is why the boundary is not "no non-S3 AWS API off the `aws`
  command"** — RA's `CreateSession` and the SDK's STS/SSO exchanges are non-S3 AWS calls made on
  the data path, and that is correct.
- **Provisioning plane — quarantined to `aws`.** Standing up buckets/identities: CloudFormation,
  IAM, trust anchors. `@aws-sdk/client-cloudformation` is the only such dependency today. It — and
  any AWS-**CLI**-shaped copy-paste s3cab emits — lives only under the `aws` command.

**The enforceable rule:** no command but `aws` may (a) require the AWS CLI or emit output that
does, or (b) import an AWS **provisioning** client. The data and auth planes are unrestricted.
This generalizes to a second provider: `aws` is the first *provider-onboarding* command, and a
future `r2`/`b2` would be its sibling — each an island; the shared core never learns provider
identity beyond the endpoint.

## Placement over deferral — why this dep is statically imported

This is *not* a blanket rule against runtime `import()` (an earlier draft's overreach, rooted in a
mistaken belief that esbuild drops dynamic imports — it does not). The default is a static
`import` because `tsc` checks it; a dynamic `import()` is fine with a reason, and the only real
trap is a *computed-specifier* import of our own code (`./commands/${name}.mjs`), which trades
that checking for a magic string. A lazy third-party import earns its keep only when the dep is
**heavy AND on a rarely-taken, localized path**. `@aws-sdk/client-cloudformation` is the one dep
that clears that bar (one call site, the `aws --save` flow only) — yet it is **statically**
imported, because the right lever is *where the code lives*, not deferral:

- The CloudFormation read (`saveArnsFromStack`) sits in **`src/lib/stack-arns.mjs`**, a module
  imported by nothing but `src/commands/aws.mjs`. So CloudFormation loads only when `aws` loads —
  never on the backup/restore path — with a plain static import. The boundary is enforced by
  **structure**, checked by `tsc`.
- Previously this function lived in the hot-path `roles-anywhere.mjs` (which `s3.mjs`/`auth.mjs`
  import) and used a lazy `import("@aws-sdk/client-cloudformation")` *to keep CloudFormation off
  that path*. That dynamic import was masking a misplacement, not making a design choice. Moving
  the function to an `aws`-only module removes both the misplacement and the sole dynamic import.

Bundling was **not** the reason to avoid the dynamic import: esbuild bundles a string-**literal**
`import()` (and glob-bundles a `./dir/${x}` template) exactly like a static import — only a fully
computed specifier escapes the bundle and would break the SEA. The reason is compile-time
checking + not blessing a lone special case.

## Rejected

- **A lazy `import()` of the CloudFormation client** (the prior state) — works and bundles fine,
  but it is our only dynamic import, and it exists solely to keep a provisioning dep out of a
  hot-path module. Fixing placement removes the need. See above.
- **Static-import CloudFormation where it was, in `roles-anywhere.mjs`** — would load the
  provisioning client on every remote command (that module is on the auth path). Worst of both:
  no dynamic import, but provisioning weight on the data path.
- **Dynamic-import our own command modules** (`await import(\`./commands/${key}.mjs\`)`) to make
  `help`/`tree`/`prop` skip loading the S3 SDK — viable in esbuild (glob bundling, deferred
  per-module init), but it trades `tsc`'s compile-time import checking for an un-checked
  filename-equals-command-key coupling. Not worth it for startup time on a heavy CLI. The eager
  registry barrel ([`src/commands.mjs`](../../src/commands.mjs)) stays.
- **A lint rule enforcing the import boundary** — a one-file check that
  `@aws-sdk/client-cloudformation` appears only under `aws` is cheap, but per
  [0006](0006-minimal-code.md) the boundary is checked in review, like the other structural
  conventions.

## Consequences

- New `src/lib/stack-arns.mjs` (aws-only, static CloudFormation import) holds `saveArnsFromStack`;
  its unit tests move to `stack-arns.test.mjs`. `roles-anywhere.mjs` keeps the pure
  `arnsFromOutputs`/`ARN_ENV` contract and the identity/signer code, and no longer touches
  CloudFormation; `identityEnvPath` is now exported for the moved function.
- The mocked `saveArnsFromStack` tests follow the house `mock.module` idiom (one top-level mock +
  a top-level dynamic import of the subject, the per-test result varied through a module-scoped
  mutable) — the per-`it` re-mocking the old tests used only worked *because* the CloudFormation
  import was dynamic, so it went with it.
- Adding a non-AWS provisioning helper later means a new sibling command + its own aws-style
  module, not new branches in the shared core.
