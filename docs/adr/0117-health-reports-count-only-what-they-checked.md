# A health report says all is well only of what it checked

**Status:** accepted & implemented (2026-11-05). Extends [0042](0042-verify-bucket-operand.md)'s
exit rule; amends the `#error` exit rule in [guide/format.md](../../guide/format.md).

## Context

Two cold durability audits (2026-11-05, one on Claude Opus 5.5 and one on Claude Fable 5.1;
[proposals/bugs.md](../../proposals/bugs.md) has the roll-up) were briefed on two failures: a
backup that reports success but can't be restored, and **a health or status report that says
all is well over a store that can't restore.** They found four of the second kind, each
measured on Windows and in WSL:

- **`verify` said `0 sets, 0 objects checked — all verified ✓`, exit 0**, over an empty bucket
  and over a set whose marker, config and objects were all there and whose every snapshot was
  gone. `listSnapshotFiles` never saw the `<set>.info` marker and `readReferencedObjects`
  dropped a set with no snapshot names before anything reported it, so the set vanished from
  the report instead of appearing in it. `s3cab verify <bucket> || alert`, which
  [guide/maintenance.md](../../guide/maintenance.md) calls the whole cron job, stayed silent
  through the loss of everything — and through a mistyped bucket name.
- **`verify` passed an object a lifecycle rule had moved to `GLACIER`**, where `restore`
  then failed on every file with `The operation is not valid for the object's storage class`.
  `listStoredObjects` kept the LIST's `Key` and `Size` and dropped its `StorageClass`.
- **`status` said `up to date`** under `latest snapshot 20260105T0001 / backed up
  20260105T0000`: `renderStatus` printed it whenever nothing was left to upload, whatever the
  two names said. A rename, a deletion, or a reverted file produces a snapshot whose objects
  are all stored, so the line read as done when the bucket held only the old layout, and a
  restore from it would bring the deleted files back under the old names.
- **`upload --snapshot` exited 0 over `#error` rows.** `uploadSnapshot` read the snapshot's
  `entries` and ignored its `errors`, and the upload-failed error a `backup` throws named the
  retry without mentioning the files it couldn't read; the retry exited 0, and every report
  after it read clean. The code comment in `commands/backup.mjs` calls exit 0 over an omitted
  file "the machine-readable half lying", and this was a second route to the same lie.

Each report was true of what it had counted and false of what it hadn't: a verdict drawn
from zero snapshots, a size check over an object no GET can read, a verdict about objects
asked of a question about snapshots, and an exit code that saw only the upload.

An adversarial read of those fixes (2026-11-09) found the same lie by other routes: a set
whose marker went with its snapshots dropped out of `verify` again; `cleanup` read a set with
no snapshots as referencing nothing, and deleted its store; and `status` judged "in the
bucket" by name, which two machines can share, and "latest" by name, which a clock set back
can mint out of order.

## Decision

**A report's clean verdict and exit 0 are made only of what the run actually checked, and the
report says what it didn't.**

1. **`verify` exits 1 when it verified nothing.** A bucket with no set is
   `nothing to verify ✗`: "all verified" can't be said of nothing, and the likely story is the
   wrong bucket. A set named in the bucket — by its marker, its folder under `snapshots/`, or
   s3cab's copy of its config under `.s3cab/sets/` — with no snapshots is a finding,
   `no snapshots` — nothing to restore from, nothing this run could verify. `all verified ✓`
   and exit 0 mean at least one snapshot was read and every file it references is stored at
   its recorded size. A set that has been set up and not yet backed up is in the same state
   and reads the same way, on purpose (user, 2026-11-05: "yes, always"): the report can't tell
   a set that never had a snapshot from one that lost them all — nothing in the format records
   which snapshots should exist — and for both the honest answer to "would I get it back?" is
   no. Its first backup clears it. **A set leaves the bucket with its last snapshot:**
   `forget` of every snapshot a set has also removes its marker and config, so retiring a set
   on purpose leaves nothing to report, and the next backup of it starts with `takeover`.
2. **An object in a storage class a plain GET can't read is a finding, `archived`**, one row
   per path that references it, naming the class. The classes are `GLACIER` and
   `DEEP_ARCHIVE`, the two S3 reports in a LIST and refuses to serve without a restore
   request. `GLACIER_IR`, which s3cab writes ([0066](0066-glacier-ir-storage-tier.md)), reads
   at once and is not one. `INTELLIGENT_TIERING`'s archive access tiers are invisible to a
   LIST — only a HEAD's `x-amz-archive-status` shows them — so verify doesn't see those; 0042
   keeps verify to one LIST, and a HEAD per object is what it rejects. For the same reason
   the finding stands until the object is moved back to an instant-access class: a
   `RestoreObject` request lands a temporary readable copy the LIST doesn't show, and the
   copy expires.
3. **`status` says `up to date` only when the latest local snapshot is in the bucket** — the
   question [guide/getting-started.md](../../guide/getting-started.md) says `status` asks.
   In the bucket, not the bucket's latest: another machine's later backup of the set, or a
   newest local snapshot file removed by hand, leaves the bucket newer than this machine with
   nothing of this machine's missing. In the bucket means byte for byte
   ([0084](0084-snapshot-identity-byte-equality.md)): another machine's snapshot can hold the
   same minute's name, and then the line says the bucket's is a different one. Otherwise it
   says `latest snapshot not backed up`, followed by the objects a backup would send or
   `its objects are all stored`: the snapshot itself is what's missing, and that is the line
   a user reads before deciding whether to run `backup`. A test blessed
   `backedUp: null, toUpload: 0` as `up to date`; it now reads `never`. "Latest" stays the
   name-latest, as everywhere, but a local snapshot the bucket lacks whose file was written
   after the latest's — a clock set back, daylight saving's repeated hour — is named as not
   backed up, so `up to date` is never said over the snapshot taken last.
4. **`upload` of a snapshot exits 1 over `#error` rows and lists them**, under `backup`'s
   `Couldn't be backed up` heading with the same `backup` retry, so a snapshot with a file it
   couldn't read never exits 0 from any command that publishes it. The rule in
   [guide/format.md](../../guide/format.md) now names `backup`, `snapshot` and `upload`. The
   upload-failed error `backup` throws counts the unread files beside the retry it names
   ("it holds nothing for 1 file that couldn't be read; the upload lists them"), so the retry
   is not the first a user hears of them.
5. **`cleanup` refuses to delete while any set has no snapshots**, beside its missing-objects
   interlock: such a set references nothing, so everything only its lost snapshots referenced
   would read as orphaned. The refusal names each set and both ways out — upload its
   snapshots again from the machine that holds them, or back it up. A dry run still reports.
   A retired set can't trip it, since `forget` took it out of the bucket (§1).

## Considered and rejected

- **Exit 0 when there is nothing to check**, as before, with only the wording changed — a
  freshly set-up set is a healthy state, after all. But it is the identical report to a set
  that lost everything, and the cron job reads only the exit code. The two differ in the
  user's head, not in the bucket, so the report can't be the one to say which.
- **A dedicated exit code for "nothing checked"**, or for "damaged" against "check failed".
  0042's rule stands: no code until a script actually needs to tell them apart.
- **Recording which snapshots a set should have**, so a single lost snapshot among several
  becomes detectable. A format change that adds a second place the list of snapshots lives,
  to catch a loss from outside s3cab that `list --remote` already shows. Not done; a single
  lost snapshot stays undetectable, and the set-level finding covers the total loss.
- **A HEAD per object for Intelligent-Tiering's archive tiers.** 0042 rejected per-object
  requests for the whole check; a tier s3cab never writes doesn't reopen it.
- **Keeping `up to date` for a snapshot whose objects are all stored**, as one audit read the
  documented definition. The content is safe, but `status` answers "is the latest snapshot
  backed up", and the answer was no.
- **`status` comparing names only**, and saving the GET. Two machines can mint one minute's
  name, and the bucket's is then not this machine's snapshot. The bucket's latest is read
  anyway for the upload count, so the comparison costs a GET only when the local latest isn't
  the bucket's latest.
- **Ordering `status`'s latest by file time instead of by name.** Every other command picks
  the latest by name; one that disagreed would report on a snapshot `backup` doesn't diff
  against. Naming the later-taken one beside it keeps both true.
- **Letting `cleanup` treat a set with no snapshots as one that references nothing**, as a
  retired set legitimately does. The bucket can't tell retired from lost, so retiring now
  removes the set (§1), and an empty set left behind is damage.

## Consequences

- `s3cab verify <bucket> || alert` fires on an empty bucket and on a set whose snapshots are
  gone. It also fires, once, on a set between its `setup` and its first `backup`, and
  `cleanup` refuses over that set until then.
- Forgetting a set's last snapshot is how a set is retired; the old holder's next `backup`
  is refused until it runs `takeover`.
- `restore` still aborts on an archived object with S3's own error; `verify` is the command
  that names the class and the paths, before a restore is attempted.
- The model-based suite's verify oracle (`RepoModel.expectedVerifyFindings`) carries the three
  verify rules, so every seeded sequence expects them; the handcrafted cleanup-bug sequence
  dropped its verify steps, since the blinded verify now trips before the cleanup does. Its
  runner expects `cleanup` to refuse while `RepoModel.setsWithNoSnapshots` names a set.
- [guide/maintenance.md](../../guide/maintenance.md)'s findings table gains `archived` and
  `no snapshots`; [guide/output.md](../../guide/output.md)'s exit-code table names `upload`
  beside `backup` and `snapshot`.
