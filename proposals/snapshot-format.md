# Snapshot format

Epic: the shape of the snapshot file itself — its columns, its row types and what each one
records. The spec is [guide/format.md](../guide/format.md); this is what might change in it.

- **Decided, not built: every s3cab file ends with a lone `.` line, replacing `@S3CAB END`.**
  For snapshots and deletion records alike:
  - It is the completeness check (ADR-0082) and a row after it refuses the file (ADR-0101),
    but it is a terminator, not a row: the one stated exception to five fields and a type.
  - `@SNAPSHOT FINISH`, after `SIZE`, takes `END`'s instant in column 4 (rounded up) and the
    run's duration in column 5, in the closing report's compact form (`12m 21s`), as free text.
  - A deletion record gets no finish instant; each `#deleted` row has its own.

  Why: `END`'s empty last field made it the one line ending in a tab, which an editor's
  trim-on-save deletes, and a strict reader then refuses the four-field line. `.` is the
  established terminator (SMTP, POP3, NNTP), can't be torn or trimmed, and can't collide with a
  row. A time zone in `FINISH` was dropped: `START` has it. Touches ADR-0082, 0098, 0101 and
  0102; find the code, tests, clean-room scripts and docs with
  `S3CAB\s+END|S3CAB END|endRow|isEndLine`. After it merges, reseed the clean-room restore
  bucket's golden set.

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
