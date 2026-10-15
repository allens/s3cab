# Seeding the restore fixtures per platform

**Proposed.** Seeding runs in GitHub Actions; the sessions' side of CI is
[cleanroom-ci.md](cleanroom-ci.md).

Every snapshot in the restore fixtures today is a Linux backup, so no restorer ever reads one with
drive letters and backslashes, and a Windows backup restored on Windows — the commonest real
restore — is the case nothing tests. Seed per platform into the one restore bucket, sets suffixed
by the platform that backed them up (`edge-linux`, `edge-windows`, …): a matrix job, one runner
per OS, taking turns on the bucket. Linux keeps the POSIX-only fixtures; Windows adds drive
letters, backslashes, Windows-reported casing and long paths; macOS adds APFS's view. Every
restorer restores every platform's sets, and each restore build already makes its reference with
s3cab's own restore on the OS under test. **Seeded in CI on all three platforms:** seeding runs no
Claude session, so it costs runner minutes and no tokens, and one job keeps the three seeds
consistent.

**Decided: only in GitHub Actions.** It is the one system that runs all three platforms, so the
restore fixtures are always complete — never two platforms out of three — and macOS's backups
reach restorers written on machines without a Mac. Every run, at home or in CI, reads the CI
restore bucket, `test-s3cab-ci-cleanroom-restore`. A home identity gets read-only access to it,
which is all a restore build needs: s3cab's reattach and its restore into `reference/` only
read. The personal restore buckets go.

**Decided: the platform's name in every file's content.** An object's key is the hash of its
bytes, so two platforms' backups of identical files would store one object, and the seed's
damage — `faults`' torn object, `corrupt`'s wrong bytes — would reach the other platforms' sets,
or be undone by the next platform's upload. With the platform's name in each backup fixture's
content, no two platforms share an object, and ADR-0096's reason for one backup per bucket holds
inside one bucket. The deletion records are bucket-wide but list hashes, so they stay apart too.
The cost is that hashes match only between runs on the same platform
([cleanroom-harness.md](cleanroom-harness.md)).

**Decided: the seeds take turns,** one platform after another behind one concurrency group: two
deletes finishing in the same minute collide on the deletion record. The first turn empties the
bucket and removes the stamp; the last writes it.

**Decided: the stamp covers what changes the restore fixtures:** the spec date on `format.md`'s
first line, which changes when the format does and never for a change of wording; `fixtures.mjs`;
and the seed script. The workflow runs when any of the three changes on `main`, and by hand; it
computes the stamp and reseeds only when the bucket's differs. A restore build refuses a bucket
whose stamp differs or that lacks any platform's sets. Nothing should reseed during a real set,
since its spec is frozen. The shared bucket's cost is that a reseed can still land under a
running session, so the build records the stamp it saw and the check reads it again: if they
differ, the run is void, as it is for an audit stray.

## Before it can run

- **Each platform's seed checks only what its OS can hold.** Today's seed stops if any fixture
  group was skipped, which was right while only Linux seeded. It needs the harness's
  per-platform fixture sections, each declaring what its OS holds, with every fixture read back
  after it is built.
- **`test-s3cab-ci-cleanroom-restore`,** and the read-only grant on it for home identities, in
  the platform repo's Terraform.

## Sessions

Sessions read the restore fixtures; they never seed. A run names the OSes to run sessions on, and
a preflight confirms each is supported — Node, the repo, AWS credentials, and Claude installed
and signed in — before anything is built. WSL alone doesn't make Linux supported; Claude
installed inside it does.
