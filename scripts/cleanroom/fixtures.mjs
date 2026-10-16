/**
 * The clean-room fixtures (ADR-0096): the backup sets' trees, built the same way into a
 * backup sandbox and for the restore bucket's golden set. One table, `fixtures`, declares
 * every entry — its set, its name (as code points, or as bytes where it has no UTF-8
 * form), its kind and its attributes — and `buildFixtures` creates each one and then
 * **reads every one back**: the raw name from `readdir`, the kind from `lstat`, hidden and
 * system from `attrib`, a link's target from `readlink`. The creating tool is not trusted,
 * because what works depends on the Node version, the machine (symlinks need Developer
 * Mode or elevation), and the filesystem (NTFS strips a trailing space, APFS folds case
 * and normal form, a lone surrogate written through a string path lands as U+FFFD with no
 * error). Never checked through `s3cab snapshot`: an s3cab bug and a broken fixture would
 * agree.
 *
 * Content is deterministic and carries the platform's name, so two builds on one platform
 * share every hash and their rows diff directly, while the three platforms' backups share
 * no object but the empty file's even in one bucket. Modification times are left natural except where the
 * value is itself the test: `utimes` takes a float, which can't pin a sub-millisecond
 * value, and the rounding is what F6 observes.
 *
 * WHY THIS IS CODE AND NOT A CHAT. The first clean-room run (docs/format-spec-audit.md)
 * was staged by hand, and its harness "was a session artifact and is not preserved", so
 * run 2 could not be compared with run 1 on equal data. The point of a re-run is diffing
 * its ambiguity list against the last one, and that needs the same fixtures underneath.
 *
 * WHAT A GOOD SET MEANS. Every Tier 1/2 finding of the audits is a place the spec was
 * silent and an implementer could go wrong; each has a fixture that would catch a
 * regression or a misreading, named in its entry's `why`. Findings no fixture can provoke
 * are listed here rather than dropped so the table looks complete:
 *
 *   F4  duplicate path rows  a hand-edited snapshot in the restore fixtures, not a tree
 *   F12 `info` syntax        the backup checker's, not a tree's
 *   F15 storage class        needs a Glacier lifecycle on the bucket
 *
 * The sets. `edge` is the crafted adversarial set, one fixture per finding; `docs` ordinary
 * data; `bulk` past ListObjectsV2's 1000-key page; `media` one object over the multipart
 * part size; `hollow` a set with no files (F16); `spread` the only set with more than one
 * member directory, which is what makes the restore layout question answerable (two
 * member directories sharing a basename are deliberately absent: s3cab refuses that under
 * `--output`, so the set would have no reference tree); `faults` and `corrupt` are the raw
 * material for the golden set's damage (seed-restore-cleanroom-bucket.mjs), ordinary
 * trees in a backup room. Two sets a backup must **refuse** rather than publish: `scans`,
 * one file whose name has no UTF-8 form (a lone surrogate on Windows, a stray byte
 * elsewhere), and `ledger`, one file with a tab in its name. The seed has exclude
 * patterns, so there the surrogate sits in `edge` under one and the restore fixtures carry
 * its `#excluded` row; the backup clean room has none, so there the name is a set of its
 * own.
 *
 * Which platform holds what is declared per entry (`on`), not guessed from the OS: NTFS
 * forbids characters 1–31 and `: * ? " < > |` in a name; `a:b.txt` there makes a file `a`
 * with an alternate data stream. Windows' own oddities (a trailing dot, hidden and system,
 * a junction, reserved names such as `CON` that are hostile to a plain-path open) are the
 * Windows section at the foot of the table. macOS is declared as its runners' APFS holds
 * it: case- and normalization-insensitive, so the case and NFC/NFD pairs fold; UTF-8 names
 * only; and mtimes as 64-bit nanoseconds, so nothing past 2262. The read-back still checks
 * every entry built. Whatever fails to build is removed with everything sharing its `why`,
 * and named in a loud notice: a partial corpus that reads as a complete one is the
 * silent-shortening failure the exercise hunts. A set with nothing left is removed and
 * reported too, so a refused set is never an empty set that publishes.
 *
 * The out-of-range mtimes (before 1970, after 2262) are off Windows for now: there
 * `statSync` wraps a time outside 1970–2106 (proposals/bugs.md), so s3cab's own reference
 * row would be wrong and the checker would fail a correct program.
 */
import { execFileSync } from "node:child_process";
import { createCipheriv, createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

/** @import { Stats } from "node:fs" */

/** @typedef {"linux" | "windows" | "macos"} Platform */

/** Every platform the restore bucket holds sets from. @type {Platform[]} */
export const platforms = ["linux", "windows", "macos"];

const windows = process.platform === "win32";

/**
 * This machine's platform: in every file's content, and the suffix on every set it seeds.
 * @type {Platform}
 */
export const platform = windows
  ? "windows"
  : process.platform === "darwin"
    ? "macos"
    : "linux";

/**
 * @typedef {object} BackupSet
 * @property {string} name
 * @property {string[]} dirs member directories, relative to the set's tree (`.` is the
 *   tree itself)
 * @property {boolean} [refused] a backup must stop on this set rather than publish it,
 *   and s3cab does, so no s3cab snapshot of it exists: not seeded, never handed over
 */

/** The sets, in backup order. Each one's tree is `<fixtures>/<name>`. @type {BackupSet[]} */
export const sets = [
  { name: "edge", dirs: ["."] },
  { name: "docs", dirs: ["."] },
  { name: "bulk", dirs: ["."] },
  { name: "media", dirs: ["."] },
  { name: "hollow", dirs: ["."] },
  { name: "spread", dirs: ["alpha", "beta"] },
  { name: "faults", dirs: ["."] },
  { name: "corrupt", dirs: ["."] },
  // Named like ordinary data on purpose: a label saying what is wrong with the set would
  // prime the backup room, where finding that out from the spec is the test.
  { name: "scans", dirs: ["."], refused: true },
  { name: "ledger", dirs: ["."], refused: true },
];

export const setNames = sets.map(({ name }) => name);

/** The sets the golden set holds: every one s3cab can back up. */
export const seeded = sets.filter((set) => !set.refused);

/**
 * A set's name in the golden set: each platform seeds every set s3cab can back up,
 * suffixed with its name (`edge-linux`), so the three seeds share one bucket and no set.
 * @param {string} name
 * @param {Platform} suffix
 */
export const goldenSet = (name, suffix) => `${name}-${suffix}`;

/** Every set name the golden set holds. */
export const goldenSets = platforms.flatMap((suffix) =>
  seeded.map(({ name }) => goldenSet(name, suffix)),
);

// Every set's exclude patterns, for the seed, where s3cab snapshots the trees. The backup
// clean room gets none (ADR-0107: excluding is the tool's own), so there `spread`'s near
// misses and `edge`'s `ignored.*` are ordinary files. `spread`'s give
// each rule of guide/exclude.md's grammar a path it drops and a near miss it keeps.
// `edge`'s is the file a Windows editor leaves: CRLF endings and no newline after the last
// line, which the bucket holds byte for byte and a reader trims. Its middle line keeps the
// surrogate out of s3cab's `edge`, so that set backs up and the restore fixtures carry the
// `#excluded` row the spec describes, U+FFFD and all.
export const excludes = new Map([
  ["edge", "*.tmp\r\nsurrogate-*\r\n*.swp"],
  ["spread", "*.log\n**/cache.bin\nlogs/**\nv?.bak\nbuild/\n"],
]);

/**
 * @typedef {object} Fixture
 * @property {string} set the tree it lives in: a set's name, or `outside`, a directory
 *   beside the sets that links lead out to
 * @property {(string | Buffer)[]} path segments below that tree; only the last may be
 *   bytes, for a name with no UTF-8 form
 * @property {"file" | "dir" | "symlink" | "junction" | "hardlink" | "fifo"} kind
 * @property {string | Buffer | (() => Buffer)} [content] a file's bytes; a function for
 *   content worth making only when the file is written, so importing the table costs nothing
 * @property {number} [mtime] seconds since the epoch, pinned where the value is the test
 * @property {string[]} [target] a link's target, as segments below the fixtures directory
 * @property {boolean} [dangling] a link whose target must not exist
 * @property {("hidden" | "system")[]} [attrs] Windows attributes, set with `attrib`
 * @property {boolean} [caseSensitive] a directory NTFS keeps case-sensitive (`fsutil`)
 * @property {boolean} [unreadable] mode 000, and checked to be unreadable
 * @property {Platform[]} [on] the platforms that hold it; every one when absent
 * @property {"patterns"} [only] built only where s3cab snapshots the trees with the exclude
 *   patterns above
 * @property {string} why the finding it covers. Entries sharing a `why` stand or fall
 *   together, so a pair is never half built
 */

/** @param {string} line */
const text = (line) => `${line} (${platform})\n`;

/**
 * Deterministic bytes: the same on every build on one platform, different per platform.
 * @param {string} label
 * @param {number} size
 */
const bytes = (label, size) =>
  createCipheriv(
    "aes-256-ctr",
    createHash("sha256").update(`${platform} ${label}`).digest(),
    Buffer.alloc(16),
  ).update(Buffer.alloc(size));

/**
 * A name with no UTF-8 form, as the bytes the filesystem will list it by: a lone
 * surrogate as its WTF-8 (what Windows gives back for U+D800), a stray 0xFF elsewhere.
 * A string path can't make either: Node encodes a lone surrogate as U+FFFD and reports
 * success, so the bytes go through a `Buffer` path.
 * @param {string} stem
 */
const noUtf8 = (stem) =>
  Buffer.concat([
    Buffer.from(stem, "utf8"),
    windows ? Buffer.from([0xed, 0xa0, 0x80]) : Buffer.from([0xff]),
    Buffer.from(".txt", "utf8"),
  ]);

/** @type {Fixture[]} */
export const fixtures = [
  // Where links out of the backup lead: beside the sets, inside no member directory.
  {
    set: "outside",
    path: ["beyond.txt"],
    kind: "file",
    content: text("outside every member directory"),
    why: "a target outside the backup",
  },

  // ── edge: the crafted adversarial set ──────────────────────────────────────
  {
    set: "edge",
    path: ["plain.txt"],
    kind: "file",
    content: text("an ordinary file"),
    mtime: 1_500_000_000,
    why: "an ordinary file",
  },
  // Escapes on purpose: these two names look identical in every editor and differ only
  // in normal form. A reader that normalises paths merges them silently, and so does APFS.
  {
    set: "edge",
    path: ["caf\u00e9.txt"],
    kind: "file",
    content: text("NFC: e-acute as one code point"),
    on: ["linux", "windows"],
    why: "NFC/NFD pair of names (F1)",
  },
  {
    set: "edge",
    path: ["cafe\u0301.txt"],
    kind: "file",
    content: text("NFD: e + combining acute"),
    on: ["linux", "windows"],
    why: "NFC/NFD pair of names (F1)",
  },
  {
    set: "edge",
    path: ["日本語.txt"],
    kind: "file",
    content: text("CJK"),
    why: "CJK name (F1)",
  },
  {
    set: "edge",
    path: ["🎉 emoji 🎉.txt"],
    kind: "file",
    content: text("astral plane"),
    why: "astral-plane name (F1)",
  },
  {
    set: "edge",
    path: ["empty.txt"],
    kind: "file",
    content: "",
    why: "a zero-byte file",
  },
  // Same bytes under two names, in different directories: one object, two rows. The
  // restore seed deletes this content for F5, so there is one object to delete.
  {
    set: "edge",
    path: ["dedup-a.txt"],
    kind: "file",
    content: text("shared content"),
    why: "two paths, one object (F5)",
  },
  {
    set: "edge",
    path: ["sub", "dedup-b.txt"],
    kind: "file",
    content: text("shared content"),
    why: "two paths, one object (F5)",
  },
  // F6: mtimes chosen to be awkward rather than merely old — a value that rounds up across
  // a second boundary, the 32-bit signed overflow, a pre-1980 date, and beyond either end
  // of what a 64-bit nanosecond count or a positive time_t holds. Rounding toward zero
  // instead of flooring puts a negative time a second off.
  {
    set: "edge",
    path: ["mtime-rounds-up.txt"],
    kind: "file",
    content: text("x"),
    mtime: 1_500_000_000.9996,
    why: "an mtime that rounds up across a second (F6)",
  },
  {
    set: "edge",
    path: ["mtime-2038.txt"],
    kind: "file",
    content: text("x"),
    mtime: 2_147_483_648,
    why: "an mtime past the 32-bit signed boundary (F6)",
  },
  {
    set: "edge",
    path: ["mtime-1970s.txt"],
    kind: "file",
    content: text("x"),
    mtime: 86_400,
    why: "a pre-1980 mtime (F6)",
  },
  {
    set: "edge",
    path: ["mtime-1969.txt"],
    kind: "file",
    content: text("x"),
    mtime: -86_400.25,
    on: ["linux", "macos"],
    why: "an mtime before 1970 (F6)",
  },
  {
    set: "edge",
    path: ["mtime-2300.txt"],
    kind: "file",
    content: text("x"),
    mtime: Date.UTC(2300, 0, 1) / 1000,
    on: ["linux"],
    why: "an mtime past 2262, where 64-bit nanoseconds overflow (F6)",
  },
  // F10: sizes spanning the size column's 12-character minimum width.
  ...[
    ["size-1b.bin", 1],
    ["size-1k.bin", 1024],
    ["size-1m.bin", 1024 * 1024],
  ].map(
    ([name, size]) =>
      /** @type {Fixture} */ ({
        set: "edge",
        path: ["sizes", String(name)],
        kind: "file",
        content: () => bytes(String(name), Number(size)),
        why: "sizes across the column width (F10)",
      }),
  ),
  // F2: never trim the path. NTFS holds these too, through `\\?\`, which Node uses.
  {
    set: "edge",
    path: [" leading.txt"],
    kind: "file",
    content: text("leading space"),
    why: "leading/trailing-space names (F2)",
  },
  {
    set: "edge",
    path: ["trailing.txt "],
    kind: "file",
    content: text("trailing space"),
    why: "leading/trailing-space names (F2)",
  },
  {
    set: "edge",
    path: [" both ends.txt "],
    kind: "file",
    content: text("both ends"),
    why: "leading/trailing-space names (F2)",
  },
  // F3: legal path characters that splitlines()-style parsers break on. NTFS forbids the
  // two control characters, not U+0085.
  {
    set: "edge",
    path: ["vertical\vtab.txt"],
    kind: "file",
    content: text("vertical tab"),
    on: ["linux", "macos"],
    why: "\\v and \\f in names (F3)",
  },
  {
    set: "edge",
    path: ["form\ffeed.txt"],
    kind: "file",
    content: text("form feed"),
    on: ["linux", "macos"],
    why: "\\v and \\f in names (F3)",
  },
  {
    set: "edge",
    path: ["next\u0085line.txt"],
    kind: "file",
    content: text("U+0085 NEXT LINE"),
    why: "U+0085 in a name (F3)",
  },
  // F14: two paths differing only in case, in a directory NTFS can keep case-sensitive.
  {
    set: "edge",
    path: ["case"],
    kind: "dir",
    caseSensitive: true,
    on: ["linux", "windows"],
    why: "case-differing sibling paths (F14)",
  },
  {
    set: "edge",
    path: ["case", "Case.txt"],
    kind: "file",
    content: text("upper"),
    on: ["linux", "windows"],
    why: "case-differing sibling paths (F14)",
  },
  {
    set: "edge",
    path: ["case", "case.txt"],
    kind: "file",
    content: text("lower"),
    on: ["linux", "windows"],
    why: "case-differing sibling paths (F14)",
  },
  // F13: past Windows MAX_PATH. Node goes through `\\?\`, so NTFS holds it.
  {
    set: "edge",
    path: [...Array.from({ length: 12 }, () => "a".repeat(24)), "deep.txt"],
    kind: "file",
    content: text("past 260 characters"),
    why: "path past Windows MAX_PATH (F13)",
  },
  // Links (F9, and the Links table). Symlinks are attempted everywhere and skipped on the
  // error: Windows has them, it just wants Developer Mode. Into the backup and dangling
  // get no row; out of the backup gets an `#error` naming the target, with a separator
  // when that is a directory, and s3cab exits 1.
  {
    set: "edge",
    path: ["link-to-plain"],
    kind: "symlink",
    target: ["edge", "plain.txt"],
    why: "a symlink to a file in the backup, which gets no row (F9)",
  },
  {
    set: "edge",
    path: ["link-to-sub"],
    kind: "symlink",
    target: ["edge", "sub"],
    why: "a symlink to a directory in the backup, which must not be followed",
  },
  {
    set: "edge",
    path: ["link-dangling"],
    kind: "symlink",
    target: ["edge", "missing.txt"],
    dangling: true,
    why: "a dangling symlink, which gets no row",
  },
  {
    set: "edge",
    path: ["link-out-file"],
    kind: "symlink",
    target: ["outside", "beyond.txt"],
    why: "a symlink to a file out of the backup, an #error",
  },
  {
    set: "edge",
    path: ["link-out-dir"],
    kind: "symlink",
    target: ["outside"],
    why: "a symlink to a directory out of the backup, an #error ending in a separator",
  },
  // A hard link is two names for one inode, and both are files: a backup that
  // deduplicates by inode drops a path.
  {
    set: "edge",
    path: ["hard-a.txt"],
    kind: "file",
    content: text("one inode, two names"),
    why: "a hard-link pair, two rows",
  },
  {
    set: "edge",
    path: ["hard-b.txt"],
    kind: "hardlink",
    target: ["edge", "hard-a.txt"],
    why: "a hard-link pair, two rows",
  },
  // A pipe gets no row; a backup that opens it hangs.
  {
    set: "edge",
    path: ["pipe"],
    kind: "fifo",
    on: ["linux", "macos"],
    why: "a FIFO, no row",
  },
  // An unreadable file gives an `#error` row among the file rows. Twenty readable siblings,
  // because ext4 lists a directory in hash order, so some rows come after it: a backup
  // that drops the row shifts every later hash by one, and every object still matches its
  // key. Root reads anything, so the read-back checks the file really is unreadable.
  {
    set: "edge",
    path: ["unreadable", "locked.txt"],
    kind: "file",
    content: text("can't be read"),
    unreadable: true,
    on: ["linux", "macos"],
    why: "an unreadable file, an #error among the file rows",
  },
  ...Array.from(
    { length: 20 },
    (_, index) =>
      /** @type {Fixture} */ ({
        set: "edge",
        path: ["unreadable", `sibling-${String(index).padStart(2, "0")}.txt`],
        kind: "file",
        content: text(`sibling ${index}`),
        on: ["linux", "macos"],
        why: "an unreadable file, an #error among the file rows",
      }),
  ),
  // F9/F11: an #excluded row needs a file that matches a pattern the seed then installs.
  // Two, one per line of `edge`'s exclude file (see `excludes`); plain files elsewhere.
  {
    set: "edge",
    path: ["ignored.tmp"],
    kind: "file",
    content: text("excluded by pattern, in the seed"),
    why: "a file an exclude pattern drops (F9)",
  },
  {
    set: "edge",
    path: ["ignored.swp"],
    kind: "file",
    content: text("excluded by the unterminated last line, in the seed"),
    why: "a file an unterminated last pattern drops (F9)",
  },
  // s3cab's half of the lone surrogate: under a pattern, so s3cab backs `edge` up and
  // writes the `#excluded` row with U+FFFD standing in for what doesn't decode.
  {
    set: "edge",
    path: [noUtf8("surrogate-")],
    kind: "file",
    content: text("no UTF-8 form, excluded"),
    on: ["linux", "windows"],
    only: "patterns",
    why: "a name with no UTF-8 form under an exclude pattern",
  },
  // Names Windows reserves. Ordinary files on Linux, where the restore fixtures carry them
  // for every Windows restorer; creatable on NTFS through `\\?\`, and then hostile to
  // Python's and .NET's plain-path open, which gets the console.
  ...["CON", "aux.txt", "nul.txt"].map(
    (name) =>
      /** @type {Fixture} */ ({
        set: "edge",
        path: [name],
        kind: "file",
        content: text(`a name Windows reserves: ${name}`),
        why: "names Windows reserves",
      }),
  ),
  // Names Windows forbids outright, and a backslash where it is an ordinary character.
  ...[
    "a:b.txt",
    "a?b.txt",
    "a*b.txt",
    'a"b.txt',
    "a<b.txt",
    "a>b.txt",
    "a|b.txt",
  ].map(
    (name) =>
      /** @type {Fixture} */ ({
        set: "edge",
        path: [name],
        kind: "file",
        content: text(`a character Windows forbids: ${name[1]}`),
        on: ["linux", "macos"],
        why: 'names holding : * ? " < > |',
      }),
  ),
  {
    set: "edge",
    path: ["back\\slash.txt"],
    kind: "file",
    content: text("a backslash in a name"),
    on: ["linux", "macos"],
    why: "a backslash in a POSIX name, which splits nothing",
  },
  {
    set: "edge",
    path: ["a\\b", "c.txt"],
    kind: "file",
    content: text("a backslash in a directory name"),
    on: ["linux", "macos"],
    why: "a backslash in a POSIX name, which splits nothing",
  },

  // ── docs: ordinary data, so the run can find things the crafted set can't ──
  ...Array.from(
    { length: 120 },
    (_, index) =>
      /** @type {Fixture} */ ({
        set: "docs",
        path: [
          ...Array.from({ length: index % 4 }, (_, d) => `d${d}`),
          `note-${index}.md`,
        ],
        kind: "file",
        content: `# note ${index} (${platform})\n${"body\n".repeat(index)}`,
        why: "ordinary data",
      }),
  ),

  // ── bulk: past ListObjectsV2's 1000-key page, with distinct content per file ──
  ...Array.from(
    { length: 1100 },
    (_, index) =>
      /** @type {Fixture} */ ({
        set: "bulk",
        path: [`item-${index}.txt`],
        kind: "file",
        content: text(`unique ${index}`),
        why: "more objects than one listing page",
      }),
  ),

  // ── media: one object over the 16 MiB part size, so it is multipart-uploaded ──
  {
    set: "media",
    path: ["clip.bin"],
    kind: "file",
    content: () => bytes("clip", 40 * 1024 * 1024),
    why: "an object past the multipart threshold",
  },
  {
    set: "media",
    path: ["poster.bin"],
    kind: "file",
    content: () => bytes("poster", 512 * 1024),
    why: "a mid-sized object",
  },

  // ── hollow: no files at all — a legal snapshot with no file rows (F16) ──
  { set: "hollow", path: [], kind: "dir", why: "a set with no files (F16)" },

  // ── spread: two member directories, so `<out>/<basename of DIR>/…` and `<out>/<set>/…`
  // restore different trees. The rest are matched against `excludes`' patterns in the
  // seed, each rule with a path it drops and a near miss it keeps.
  .../** @type {[string, string][]} */ ([
    ["alpha/from-alpha.txt", "member directory alpha"],
    ["beta/from-beta.txt", "member directory beta"],
    ["alpha/run.log", "dropped by *.log"],
    ["alpha/.log", "kept: * is one or more characters"],
    ["alpha/cache.bin", "dropped: **/ is zero segments too"],
    ["beta/x/y/cache.bin", "dropped: **/ at depth"],
    ["beta/logs/top.txt", "dropped by logs/**"],
    ["beta/logs/a/b.txt", "dropped: ** crosses /"],
    ["alpha/v1.bak", "dropped by v?.bak"],
    ["alpha/v10.bak", "kept: ? is exactly one character"],
    ["beta/build/out.o", "dropped by build/"],
    ["alpha/build", "kept: build/ matches a directory"],
    ["beta/src/build/in.o", "kept: build/ is top-level"],
  ]).map(
    ([path, line]) =>
      /** @type {Fixture} */ ({
        set: "spread",
        path: path.split("/"),
        kind: "file",
        content: text(line),
        why: "two member directories, and the exclude grammar for the seed",
      }),
  ),

  // ── faults: content unique to this set, so tearing its object breaks nothing else ──
  {
    set: "faults",
    path: ["recoverable.txt"],
    kind: "file",
    content: text("this one survives"),
    why: "the golden set's torn object (F7)",
  },
  {
    set: "faults",
    path: ["torn.txt"],
    kind: "file",
    content: text("torn out of the store, no record"),
    why: "the golden set's torn object (F7)",
  },
  // The explained absence: deleted and left deleted, so the spec's "skips them gracefully
  // with their date" has something to skip. F5's fixture re-backs its file up.
  {
    set: "faults",
    path: ["deleted.txt"],
    kind: "file",
    content: text("gone, with a record"),
    why: "the golden set's recorded deletion",
  },

  // ── corrupt: right key, wrong bytes, in the golden set. Three files in known order, so
  // the tree shows whether a restorer carries on past the fault.
  {
    set: "corrupt",
    path: ["a-intact.txt"],
    kind: "file",
    content: text("restored before the bad one"),
    why: "the golden set's corrupt object",
  },
  {
    set: "corrupt",
    path: ["b-corrupt.txt"],
    kind: "file",
    content: text("will be replaced"),
    why: "the golden set's corrupt object",
  },
  {
    set: "corrupt",
    path: ["c-intact.txt"],
    kind: "file",
    content: text("only reached by a restorer that carries on"),
    why: "the golden set's corrupt object",
  },

  // ── the refused sets: a backup stops and says why ──
  {
    set: "scans",
    path: [noUtf8("scan-")],
    kind: "file",
    content: text("no UTF-8 form"),
    on: ["linux", "windows"],
    why: "a name with no UTF-8 form, refused",
  },
  {
    set: "ledger",
    path: ["q1\t2026.txt"],
    kind: "file",
    content: text("a tab in the name"),
    on: ["linux", "macos"],
    why: "a name holding a tab, refused",
  },

  // ── Windows ───────────────────────────────────────────────────────────────
  // A trailing dot: looked up by its plain path, `notes.` is `notes`.
  {
    set: "edge",
    path: ["notes."],
    kind: "file",
    content: text("a trailing dot"),
    on: ["windows"],
    why: "a trailing dot in a name",
  },
  // Hidden and system files are ordinary files.
  {
    set: "edge",
    path: ["hidden.txt"],
    kind: "file",
    content: text("hidden"),
    attrs: ["hidden"],
    on: ["windows"],
    why: "a hidden file",
  },
  {
    set: "edge",
    path: ["system.txt"],
    kind: "file",
    content: text("hidden and system"),
    attrs: ["hidden", "system"],
    on: ["windows"],
    why: "a hidden system file",
  },
  // The one link every Windows machine can make. Python's `os.walk(followlinks=False)`
  // still descends into it, and `os.path.islink()` is false for it.
  {
    set: "edge",
    path: ["junction"],
    kind: "junction",
    target: ["outside"],
    on: ["windows"],
    why: "a junction out of the backup, an #error ending in a separator",
  },
];

/**
 * Every set's member directories under `dir`, absolute, with its expectation.
 * @param {string} dir
 */
const setDirs = (dir) =>
  sets.map((set) => ({
    ...set,
    dirs: set.dirs.map((member) => join(dir, set.name, member)),
  }));

/**
 * The sets whose trees are under `dir`: every set but the ones a build removed, since a
 * set this platform couldn't build has no directory. The build hands this list to the
 * brief and the checker derives the same one for itself, with no file on disk between.
 * @param {string} dir
 */
export const builtSets = (dir) =>
  setDirs(dir).filter((set) => existsSync(join(dir, set.name)));

/**
 * The declared directory an entry lives under: its set's member directory, or the set's
 * tree, or `outside`. Removing a failed entry never removes this, since it's declared.
 * @param {string} dir
 * @param {Fixture} entry
 */
function declaredDir(dir, entry) {
  const tree = join(dir, entry.set);
  const members = sets
    .find((set) => set.name === entry.set)
    ?.dirs.map((member) => join(tree, member));
  const [first = ""] = entry.path;
  return (
    members?.find((member) => join(tree, String(first)) === member) ?? tree
  );
}

/**
 * Where an entry lives: its absolute path (bytes when its name is), the directory that
 * lists it, the name as the bytes `readdir` reports, and a printable spelling.
 * @param {string} dir
 * @param {Fixture} entry
 */
function located(dir, entry) {
  const last = entry.path.at(-1);
  const head = entry.path.slice(0, -1).map(String);
  const parent = join(dir, entry.set, ...head);
  if (Buffer.isBuffer(last)) {
    return {
      abs: Buffer.concat([Buffer.from(parent + sep, "utf8"), last]),
      parent,
      name: last,
      shown: JSON.stringify(join(parent, last.toString("utf8"))),
    };
  }
  const abs = last === undefined ? parent : join(parent, last);
  return {
    abs,
    parent: dirname(abs),
    name: Buffer.from(basename(abs), "utf8"),
    shown: JSON.stringify(abs),
  };
}

/**
 * Create one entry. Throws if the platform refuses it.
 * @param {string} dir
 * @param {Fixture} entry
 * @param {ReturnType<typeof located>} where
 */
function create(dir, entry, { abs, parent }) {
  const target = entry.target ? join(dir, ...entry.target) : "";
  mkdirSync(parent, { recursive: true });
  switch (entry.kind) {
    case "file": {
      const content =
        typeof entry.content === "function"
          ? entry.content()
          : (entry.content ?? "");
      writeFileSync(abs, content);
      if (entry.mtime !== undefined) {
        // A negative number is "now" to `utimes`, so a time before 1970 goes as a Date;
        // a positive one stays a number, since a Date drops the sub-millisecond part.
        const stamp =
          entry.mtime < 0 ? new Date(entry.mtime * 1000) : entry.mtime;
        utimesSync(abs, stamp, stamp);
      }
      if (entry.unreadable) {
        chmodSync(abs, 0);
      }
      if (entry.attrs) {
        execFileSync("attrib", [
          ...entry.attrs.map((attr) => `+${attr[0]?.toUpperCase()}`),
          String(abs),
        ]);
      }
      return;
    }
    case "dir":
      mkdirSync(abs, { recursive: true });
      if (entry.caseSensitive && windows) {
        execFileSync("fsutil", [
          "file",
          "setCaseSensitiveInfo",
          String(abs),
          "enable",
        ]);
      }
      return;
    case "symlink": {
      // Windows needs a directory link told so; a dangling one is a file link.
      const isDir = existsSync(target) && lstatSync(target).isDirectory();
      symlinkSync(target, abs, isDir ? "dir" : "file");
      return;
    }
    case "junction":
      symlinkSync(target, abs, "junction");
      return;
    case "hardlink":
      linkSync(target, abs);
      return;
    case "fifo":
      execFileSync("mkfifo", [String(abs)]);
      return;
  }
}

/**
 * The attribute letters `attrib` prints for a path, such as `A`, `H`, `S`.
 * @param {string} path
 */
function attribLetters(path) {
  const line =
    execFileSync("attrib", [path], { encoding: "utf8" }).split(/\r?\n/)[0] ??
    "";
  return line.slice(0, line.search(/[A-Za-z]:\\|\\\\/)).replaceAll(" ", "");
}

/**
 * What is on disk where the entry should be, against what it declares: the name byte for
 * byte, the kind, a pinned mtime, unreadability, the attributes, a link's target. Returns
 * why it doesn't match, or undefined if it does.
 * @param {string} dir
 * @param {Fixture} entry
 * @param {ReturnType<typeof located>} where
 * @param {Buffer[]} listed the parent's `readdir`, as bytes
 */
function mismatch(dir, entry, where, listed) {
  if (!listed.some((name) => name.equals(where.name))) {
    return "not listed under that name";
  }
  /** @type {Stats} */
  let stats;
  try {
    stats = lstatSync(where.abs);
  } catch (error) {
    return `can't lstat: ${error instanceof Error ? error.message : String(error)}`;
  }
  const kinds = {
    file: stats.isFile(),
    dir: stats.isDirectory(),
    symlink: stats.isSymbolicLink(),
    junction: stats.isSymbolicLink(),
    hardlink: stats.isFile(),
    fifo: stats.isFIFO(),
  };
  if (!kinds[entry.kind]) {
    return `not a ${entry.kind}`;
  }
  const target = join(dir, ...(entry.target ?? []));
  if (entry.kind === "hardlink") {
    // The same inode under two names, not merely a file with some other link.
    const other = lstatSync(target);
    if (other.ino !== stats.ino || other.dev !== stats.dev) {
      return `not the same file as ${JSON.stringify(target)}`;
    }
  }
  if (
    entry.mtime !== undefined &&
    Math.abs(stats.mtimeMs - entry.mtime * 1000) > 1
  ) {
    return `mtime read back as ${stats.mtime.toISOString()}`;
  }
  if (entry.unreadable) {
    try {
      closeSync(openSync(where.abs, "r"));
      return "still readable (running as root?)";
    } catch {
      // Unreadable, as declared.
    }
  }
  if (entry.attrs) {
    const letters = attribLetters(String(where.abs));
    const missing = entry.attrs.filter(
      (attr) => !letters.includes(attr[0]?.toUpperCase() ?? ""),
    );
    if (missing.length > 0) {
      return `attrib shows no ${missing.join(", ")}`;
    }
  }
  if (entry.kind === "symlink" || entry.kind === "junction") {
    const actual = readlinkSync(where.abs)
      .replace(/^\\\\\?\\/, "")
      .replace(/[\\/]$/, "");
    if (actual !== target) {
      return `points at ${JSON.stringify(actual)}, not ${JSON.stringify(target)}`;
    }
    // A link meant to lead somewhere must, or the row it exists to provoke never comes;
    // one meant to dangle must not.
    if (existsSync(target) === Boolean(entry.dangling)) {
      return entry.dangling
        ? "its target exists, where it should dangle"
        : "its target doesn't exist, so it dangles";
    }
  }
  return undefined;
}

/**
 * Remove the empty directories a removed entry leaves above it, up to but not including
 * `stop`: `mkdir -p` made them for the entry alone, and nothing declares them.
 * @param {string} parent
 * @param {string} stop
 */
function pruneEmpty(parent, stop) {
  while (
    parent !== stop &&
    existsSync(parent) &&
    readdirSync(parent).length === 0
  ) {
    rmdirSync(parent);
    parent = dirname(parent);
  }
}

/**
 * Build every set's tree under `dir`, read each entry back, and remove whatever didn't
 * come back as declared, together with everything sharing its `why`. Returns the sets
 * that exist, with their member directories, and the groups this platform refused.
 * @param {string} dir
 * @param {{ patterns?: boolean }} [options] `patterns` builds the trees s3cab snapshots
 *   with the exclude patterns above (the seed): the entries only they use, and none of
 *   the sets a backup must refuse, which s3cab can't snapshot
 */
export function buildFixtures(dir, { patterns = false } = {}) {
  const refused = new Set(
    sets.filter((set) => !seeded.includes(set)).map(({ name }) => name),
  );
  const wanted = fixtures.filter(
    (entry) =>
      (entry.on === undefined || entry.on.includes(platform)) &&
      (entry.only !== "patterns" || patterns) &&
      !(patterns && refused.has(entry.set)),
  );

  /** @type {Map<string, string>} why → the first reason it failed */
  const failed = new Map();
  const built = wanted.map((entry) => {
    const where = located(dir, entry);
    if (!failed.has(entry.why)) {
      try {
        create(dir, entry, where);
      } catch (error) {
        failed.set(
          entry.why,
          `${where.shown}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { entry, where };
  });

  // Read back only once everything is built: on a folding filesystem the second of a pair
  // overwrites the first, which its own read-back would have passed.
  /** @type {Map<string, Buffer[]>} */
  const listings = new Map();
  /** @param {string} parent */
  const listing = (parent) => {
    let names = listings.get(parent);
    if (!names) {
      try {
        names = readdirSync(parent, { encoding: "buffer" });
      } catch {
        names = [];
      }
      listings.set(parent, names);
    }
    return names;
  };
  for (const { entry, where } of built) {
    if (failed.has(entry.why)) {
      continue;
    }
    const reason = mismatch(dir, entry, where, listing(where.parent));
    if (reason) {
      failed.set(entry.why, `${where.shown}: ${reason}`);
    }
  }

  for (const { entry, where } of built) {
    if (failed.has(entry.why)) {
      rmSync(where.abs, { recursive: true, force: true });
      pruneEmpty(where.parent, declaredDir(dir, entry));
    }
  }
  const skipped = [...failed].map(([why, reason]) => `${why} — ${reason}`);

  // A set with nothing left is no set: removed, so a refused set can't become an empty one
  // that publishes, and reported beside the groups. One with no entry declared for this
  // platform, or that s3cab can't snapshot, is absent by design, which is not a failure.
  /** @type {string[]} */
  const absent = [];
  for (const set of sets) {
    const alive = built.some(
      ({ entry }) => entry.set === set.name && !failed.has(entry.why),
    );
    if (!alive) {
      rmSync(join(dir, set.name), { recursive: true, force: true });
      if (built.some(({ entry }) => entry.set === set.name)) {
        skipped.push(`the whole set ${set.name}`);
      } else {
        absent.push(
          `${set.name.padEnd(8)} ${patterns && set.refused ? "not snapshotted by s3cab: a backup must refuse it" : `not declared for ${platform}`}`,
        );
      }
    }
  }
  return { sets: builtSets(dir), skipped, absent };
}

/**
 * The files under `dir`, counted the way a backup counts them: into directories, never
 * through a link. Not `readdir`'s own `recursive`, which follows a directory link and
 * would count what lies beyond it as if it were inside.
 * @param {string} dir
 * @returns {number}
 */
export const count = (dir) => {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) {
      total += 1;
    } else if (entry.isDirectory()) {
      total += count(join(dir, entry.name));
    }
  }
  return total;
};

/**
 * `3 files`, `1 file`. Inlined rather than imported from `src/lib/format.mjs`, because
 * the clean-room scripts claim no privileged access to s3cab's internals.
 * @param {number} n
 */
export const files = (n) => `${n} file${n === 1 ? "" : "s"}`;

/**
 * Print what was built, and name every fixture group this platform refused, rather than
 * letting a partial build read as a complete one — the same silent-shortening failure the
 * clean room's own firewall exists to prevent, arriving through the data instead of the
 * reading.
 * @param {string} dir
 * @param {ReturnType<typeof buildFixtures>} built
 */
export function reportFixtures(dir, { sets, skipped, absent }) {
  console.log(`\nbuilt the fixtures in ${dir}:`);
  for (const { name, dirs, refused } of sets) {
    const total = dirs.reduce((sum, member) => sum + count(member), 0);
    const spread = dirs.length > 1 ? `  (${dirs.length} member dirs)` : "";
    console.log(
      `  ${name.padEnd(8)} ${files(total)}${spread}${refused ? "  (a backup must refuse it)" : ""}`,
    );
  }
  for (const line of absent) {
    console.log(`  ${line}`);
  }
  if (skipped.length > 0) {
    console.log(
      `\n! this platform could not create ${skipped.length} fixture group${skipped.length === 1 ? "" : "s"}:\n` +
        skipped.map((label) => `    ${label}`).join("\n") +
        "\n  So a build here is a partial one, measured on what this filesystem can hold.",
    );
  }
}

/**
 * A snapshot cut off after its last file row, trailer and closing `.` gone: the damage a
 * backup killed mid-write leaves, since the trailer is written last. Truncating the
 * *compressed* bytes would test gunzip's own check instead, so this decompresses, cuts,
 * and recompresses — a well-formed gzip stream that simply stops, which is precisely
 * what a reader has to notice. The seed publishes one for every restorer to refuse.
 * @param {Uint8Array} snapshot a whole `.tsv.gz`
 */
export function withoutTrailer(snapshot) {
  const text = gunzipSync(snapshot).toString("utf8");
  const trailer = text.lastIndexOf("\n@SNAPSHOT\tFILES") + 1;
  return gzipSync(Buffer.from(text.slice(0, trailer), "utf8"));
}

/**
 * The snapshot name one minute before this one, for naming a damaged copy beside the
 * intact snapshot it was made from. Backdated, never later, so the intact one stays the
 * set's latest: a tool that reaches for the newest snapshot finds a sound one, and the
 * damaged one is met only by a reader that looks at every snapshot it is given.
 *
 * Snapshot names are *local* time, so this parses and prints as UTC throughout: both
 * ends of the arithmetic use the same zone, so the answer is the local name one minute
 * back, and no offset is ever applied.
 * @param {string} name e.g. `2026-08-20T1432`
 */
export function oneMinuteBefore(name) {
  const stamp = new Date(`${name.slice(0, 13)}:${name.slice(13)}:00Z`);
  stamp.setUTCMinutes(stamp.getUTCMinutes() - 1);
  return stamp.toISOString().slice(0, 16).replace(":", "");
}
