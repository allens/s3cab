# AWS onboarding: one stack for the bucket, one per identity; Roles Anywhere addresses per bucket

**Status:** accepted, being implemented. Amends [0056](0056-onboarding-via-cloudformation.md) —
its *Resources & names* (one stack per bucket, a shared managed policy) and its closing line
calling `--roles-anywhere` recommended; and [0057](0057-roles-anywhere-credential-mode.md) — the
identity model's "one trust anchor, one role/profile". Everything else in both stands: the
templates are still generated, never applied by s3cab ([0032](0032-generative-onboarding-not-active-provisioning.md)),
and the certificate is still one per machine.

0056 put the bucket and its identity in one stack, `s3cab-<bucket>`, and 0057 kept one set of
Roles Anywhere addresses (trust anchor, profile and role ARNs) per machine. Four things break
on that layout, none of them with an error at the moment it happens:

- **A second machine on the same bucket** generates its own CA, and its template targets the same
  stack. Deploying it replaces the CA in the trust anchor, and the first machine's sessions are
  refused from then on.
- **A second bucket on the same machine** writes its addresses over the first bucket's. Every set
  on the first bucket then signs in as the second bucket's role and is denied.
- **A bucket that already exists** can't be onboarded at all: the stack tries to create it.
- **Switching a bucket between access keys and Roles Anywhere** deploys a template without the
  other path's identity, so the deploy deletes it.

## Decision

### Two kinds of stack

| Stack | Holds | Name |
| --- | --- | --- |
| **Bucket stack** | the bucket and every [0033](0033-bucket-onboarding-security-model.md) protection — nothing else | `s3cab-<bucket>` |
| **Identity stack** | one identity and its access policy | keys: `s3cab-<bucket>-user`; Roles Anywhere: `s3cab-<bucket>-<fingerprint>` |

The bucket stack is the same for both paths and every machine, so deploying it again changes
nothing. The recipe deploys it with `--no-fail-on-empty-changeset`, so a second machine (or a
switch between paths) can run every step as printed. A bucket that already exists outside s3cab
skips the bucket stack.

A Roles Anywhere identity stack holds the trust anchor, role and profile for one machine's CA.
Its name carries the first eight hex digits of the CA certificate's SHA-256, not the hostname:
unique per CA by construction, unchanged when the identity is reused, and immune to two machines
sharing a hostname or one being renamed. The `user@machine` that generated it goes in a tag and
the stack description, for people reading the console.

### The access policy lives on each identity

`bucketPolicy()` moves from a managed policy in the bucket stack to an **inline** policy on each
user and role. A bucket stack that s3cab never deployed (the existing-bucket case) then still
gets the policy, and no two identity stacks compete for one managed-policy name. This reverses
0056's "one managed policy, reused": with one identity per stack there is nothing left to reuse.

### Roles Anywhere addresses are per bucket

The certificate belongs to the machine; the trust anchor, profile and role belong to a bucket.
`--save` writes them to `~/.s3cab/roles-anywhere/<bucket>.env`, keyed by a `Bucket` output the
template now carries (the stack name can't be turned back into a bucket name, since a leading
`s3cab-` is stripped). The signer reads the file for the set's bucket. A set still carries only
the `S3CAB_RA=1` marker.

## Rejected

- **Split only from the second machine.** The first machine's combined stack is exactly what a
  second machine's run would overwrite, so the trap stays.
- **Both CAs in one trust anchor.** Each new machine must gather every earlier CA or its deploy
  drops them — the same trap, harder to hit — and AWS doesn't document that a bundle holds more
  than one CA.
- **One CA, s3cab signs a certificate per machine.** Either the CA key spreads to every machine
  or the files go both ways; cutting off one machine needs a revocation list s3cab doesn't make.
- **Copying `~/.s3cab/roles-anywhere/` to the second machine.** Spreads the CA key and makes
  revocation all-or-nothing. It still works — two machines then share one identity stack — but
  the guide doesn't offer it as the path.
- **Refuse a second bucket's `--save`.** Turns the silent break into an error but keeps the limit.
- **Detect the conflict when generating.** `s3cab aws` makes no AWS calls (0032); by the time a
  check could run, the deploy has replaced the CA.

## Consequences

- An access-key onboarding deploys two stacks instead of one.
- The bucket-name length cap is per path: a Roles Anywhere role name (`s3cab-<bucket>-<fingerprint>-role`)
  is longer than an IAM user name and must still fit IAM's 64 characters.
- Regenerating the CA (a lost or compromised key) gives a new identity stack name; the old stack
  is deleted by hand.
