# Metadata privacy

Epic: decide what s3cab attaches to the objects it stores, and give the user a say.

Split out of `engine-robustness.md` 2026-07-18 — it is a privacy/product decision, not an
engine-robustness one, and it likely wants settling before release since the metadata is
written into every object of every existing backup.

- **`upload` attaches hostname, username, and the full local path to every object.** Useful
  provenance, but it is PII sitting in object metadata, and the local path reveals directory
  structure that the content-addressed layout otherwise hides (`objects/<sha256>` is opaque by
  design — the metadata undoes that). Make it opt-in/opt-out and document it.

Points worth settling when this is picked up (_my framing, not decisions taken_):

- **Which default?** Provenance-on is friendlier for debugging a shared bucket; provenance-off
  is the privacy-respecting default and matches what the object layout already implies.
- **Retroactivity.** A switch only affects new uploads; existing objects keep whatever they
  were written with, and content-addressing means an unchanged file is never re-uploaded to
  pick up the new setting. So "turn it off" does not scrub history — say so plainly.
- **Where the switch lives** — per set at `setup`, or a global preference.
- The **format spec** ([guide/format.md](../guide/format.md)) describes the stored contract, so
  a change here is a documented format change, not just a flag.
