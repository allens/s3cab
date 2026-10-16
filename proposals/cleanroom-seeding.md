# Seeding the restore fixtures per platform: what's left

The seed itself is built: every platform seeds its own sets in GitHub Actions
([scripts/cleanroom/README.md](../scripts/cleanroom/README.md), the seed). The sessions' side of
CI is [cleanroom-ci.md](cleanroom-ci.md).

- **A reseed under a running session voids the run.** The shared bucket's cost is that a reseed
  can still land under a running session, so the build records the stamp it saw and the check
  reads it again: if they differ, the run is void, as it is for an audit stray. Nothing should
  reseed during a real set, since its spec is frozen.
- **The personal restore buckets go**, now that every run reads the CI one.

## Sessions

Sessions read the restore fixtures; they never seed. A run names the OSes to run sessions on, and
a preflight confirms each is supported — Node, the repo, AWS credentials, and Claude installed
and signed in — before anything is built. WSL alone doesn't make Linux supported; Claude
installed inside it does.
