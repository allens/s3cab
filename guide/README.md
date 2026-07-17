# s3cab guides

The full documentation, for when you want more than `--help`. New to s3cab? The
[README](../README.md) has the install and a quick start; start there and come back.

Each of these has a terminal-sized counterpart: run `s3cab help <topic>` or
`s3cab <command> --help` for what you need mid-task without reaching for a browser. These
pages are the sit-down read.

## Everyday

- **[Getting files back](restore.md)** — recovering a deleted file, an older version, or
  everything onto a fresh machine. The job the backup exists for.
- **[Reading a compare report](compare.md)** — what added / renamed / moved / modified /
  deleted mean, and why a "rotated" file reads as modified.
- **[Exclude rules](exclude.md)** — the glob patterns that keep files out of a backup set.
  (Quick reference: `s3cab help exclude`.)
- **[Looking after a backup](maintenance.md)** — checking backups are still restorable
  (`verify`), dropping snapshots (`delete`), reclaiming storage (`cleanup`), and why bucket
  versioning makes all of it safe to get wrong.

## Setting up

- **[Setting up a cloud bucket](aws.md)** — standing up an AWS bucket and a locked-down
  identity, the versioning/lifecycle model, keyless
  [Roles Anywhere](aws.md#--roles-anywhere--keyless-certificate-based-access) access, and
  [non-AWS providers](aws.md#non-aws-providers) (R2, B2, Wasabi, MinIO, …).
  (Credentials mid-task: `s3cab help provider`.)

## Reference

- **[The format spec](format.md)** — the repository layout, the snapshot-file grammar, and
  recovering by hand with no s3cab at all. The stored format is a promise, and this is it
  written down.
- **[Output formats](output.md)** — human-readable text by default, `--json` for scripts.
