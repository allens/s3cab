# Snapshot format

Epic: the shape of the snapshot file itself — its columns, its row types and what each one
records. The spec is [guide/format.md](../guide/format.md); this is what might change in it.

- **People-only rows a program could use.** Each would promote a row from people to the code,
  which is a feature change, not a format one:
  - `@S3CAB VERSION`, to name the release that wrote a file the unknown-type rule refuses, so
    the error says what to upgrade to;
  - `#excluded` rows, so `compare` reports a path a newly added pattern drops as excluded, not
    deleted. That reopens the choice `snapshot-file.mjs` records as settled (only
    `tree --excluded` answers "what are my patterns dropping?"), though it answers a different
    question;
  - `@SET BUCKET`/`ENDPOINT`, to restore from a lone snapshot with no set configured. The most
    speculative of the three.
