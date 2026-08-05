# Cloud bucket & onboarding follow-ups

Epic: what's left over after the bucket-onboarding command (`s3cab aws`) shipped. Its built
parts are of record in
[ADR-0032](../docs/adr/0032-generative-onboarding-not-active-provisioning.md) /
[0033](../docs/adr/0033-bucket-onboarding-security-model.md) /
[0034](../docs/adr/0034-bucket-command-shape.md) and [guide/aws.md](../guide/aws.md).

_(Was `cloud-cleanup.md`. Renamed 2026-07-18: its headline item — the mark-and-sweep `cleanup`
command — is **built**, so the design narrative it carried moved out to those ADRs and
[docs/design/backup.md](../docs/design/backup.md), where decisions of record belong. What's
left is onboarding follow-ups.)_

- **Roles Anywhere's live path is unverified end-to-end.** Both phases are built and the
  runtime signer shipped in [PR #191](https://github.com/allens/s3cab/pull/191)
  ([ADR-0057](../docs/adr/0057-roles-anywhere-credential-mode.md) /
  [0058](../docs/adr/0058-roles-anywhere-cert-generation.md)), proven byte-for-byte against the
  reference formula in a unit test. But
  [test/integration/roles-anywhere.test.mjs](../test/integration/roles-anywhere.test.mjs)'s live
  `CreateSession` + backup/restore round trip **has never actually run** — it skips without a
  deployed trust anchor and `S3CAB_TEST_RA_HOME`, which neither the dev box nor CI has. To close
  it: run the Phase A-2 flow against the test bucket (`s3cab aws <bucket> --roles-anywhere` →
  deploy → `--save --from-stack`), export `S3CAB_TEST_RA_HOME`, then `npm run test:integration`.
- **Per-prefix IAM policy.** The natural future tightening of the security model
  ([ADR-0033](../docs/adr/0033-bucket-onboarding-security-model.md)) — append-only on
  `objects/`+`snapshots/`, delete confined to `sets/` — if identities split or versioning is
  dropped. Not done now: with versioning as the backstop the marginal gain is small and it
  adds policy surface. (Weighed and parked in ADR-0033 §2.)
- **`--run` active mode** for the non-secret bucket steps (create/versioning/lifecycle, which
  need no IAM dependency and handle no secret) — left explicitly open but out of scope for v1
  ([ADR-0032](../docs/adr/0032-generative-onboarding-not-active-provisioning.md)).

See also [storage-tiers.md](storage-tiers.md): the tiering strategy may end up expressed in
the generated CloudFormation template, which would make it this file's neighbour.
