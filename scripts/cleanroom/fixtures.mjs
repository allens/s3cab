/**
 * The clean-room fixtures (ADR-0096): eight backup sets' trees, built the same way into a
 * backup sandbox and for the restore bucket's golden set. Shared for upkeep, not for
 * either proof: each is checked against its own build, and two builds differ anyway
 * (random bytes, the filesystem's own mtimes). A fixture for a new spec finding usually belongs on both
 * sides, so it is added here once.
 *
 * WHY THIS IS CODE AND NOT A CHAT. The first clean-room run (docs/format-spec-audit.md)
 * was staged by hand against real local trees on one machine, and its harness "was a
 * session artifact and is not preserved". So run 2 cannot be compared with run 1 on
 * equal data — the corpus is simply gone. Since the whole point of a re-run is diffing
 * its ambiguity list against the last one (a reappearing item is a fix that didn't
 * land), the fixtures have to be reproducible or every future run restarts that loss.
 *
 * WHAT "A GOOD SET" MEANS. Not taste. Every Tier 1/2 finding in the audit is a place
 * the spec was silent and a restorer could go wrong; each now has a fix in
 * guide/format.md, and a fixture here that would catch a regression or a mis-reading.
 * Findings fixtures *cannot* provoke are listed too, honestly, rather than being
 * quietly dropped so the table looks complete. The ones that need damage in the bucket
 * (F5, F7, `deleted`, `corrupt`, the damaged snapshot) get it from
 * seed-restore-cleanroom-bucket.mjs; the trees here are their raw material. The upload
 * room damages two of the same sets on its own side (build-upload-cleanroom.mjs), with
 * the two helpers at the foot of this file that it shares with the seed.
 *
 *   F1  encoding             emoji / CJK / accented names, and NFC-vs-NFD pair
 *   F2  never trim the path  leading-space, trailing-space, both-ends names   [POSIX]
 *   F3  LF splitting         \v, \f and U+0085 in names — legal path bytes that
 *                            splitlines()-style parsers break on               [POSIX]
 *   F4  duplicate path rows  NOT TESTABLE — s3cab never writes one; the reader has to
 *                            take the commitment on trust
 *   F5  presence wins        `edge` deletes a file's content (record written), then
 *                            re-backs it up: object returns, record stays forever
 *   F6  mtime grammar        pinned mtimes at odd boundaries + files left with natural
 *                            sub-millisecond mtimes, so the rounding is observable
 *   F7  restore damage       `faults` — an object torn out of the store with NO record,
 *                            so the restore must skip it, report it, and exit nonzero
 *   F8  record grammar       free with F5's delete
 *   F9  metadata field count `#EXCLUDED` (exclude pattern) and `#SKIPPED` (a symlink)
 *   F10 column padding       a size range wide enough to move the size column's width
 *   F11 metadata payloads    same rows as F9
 *   F12 `info` syntax        free — every set writes one
 *   F13 Windows MAX_PATH     a nested path past 260 characters                 [POSIX]
 *   F14 cross-OS hazards     two paths differing only in case          [if kept apart]
 *   F15 storage class        NOT TESTABLE — needs a Glacier lifecycle on the bucket
 *   F16 small legalities     `hollow` — a set with no files, so a legal snapshot with
 *                            a header, a trailer and zero file rows
 *
 * And two things run 1 never met, because it ran against a local moto server rather
 * than real S3: the `#END` trailer (new since the audit) and `bulk`, which pushes
 * `objects/` past 1000 keys. That last is not required by the spec's recovery recipe,
 * which only ever lists `snapshots/<set>/` — but materialising the store listing is a
 * natural implementation choice (s3cab itself does it, ADR-0069) and `ListObjectsV2`
 * truncates at 1000 without saying so.
 *
 * WHAT RUN 2 ADDED. Four fixtures, each for a rule the corpus stated but never made a
 * run *obey* — run 2 reported its handling of all four as written and never executed:
 *
 *   `spread`   the only set with more than one member directory. With one member dir
 *              per set, and its basename equal to the set name, `<out>/<basename>/…`
 *              and `<out>/<set>/…` produce identical trees — so the corpus made its
 *              own Tier 1 question unanswerable.
 *   `deleted`  a `delete` with no re-backup, so a file is absent *and* recorded. F5's
 *              fixture re-backs its file up (that is the presence-wins trap), which
 *              left nothing for the recorded-deletion skip path to skip.
 *   `corrupt`  an object present under the right key with the wrong bytes — the case
 *              where the spec neither requires re-hashing a download nor says what to
 *              do when it fails. Its files are ordered so the divergence is visible.
 *   damaged    a snapshot with its `#END` trailer removed and the frame recompressed,
 *              published under `faults`. The trailer's whole purpose is detecting a
 *              backup killed mid-write, and no corpus had ever staged one missing.
 *
 * [POSIX] fixtures cannot exist on Windows: NTFS forbids control characters in names
 * and strips trailing spaces. [if kept apart] pairs, and F1's NFC/NFD pair, exist only
 * where the filesystem keeps both names: not NTFS for case, not APFS for either, which
 * is why they are probed rather than gated on the OS. All are skipped with a loud notice
 * rather than silently, and a Windows build is a partial one. Keep them in the fixtures
 * permanently even so — for a Windows clean-room run they become the point. A Windows
 * restorer that refuses them, or skips them loudly, is behaving correctly; one that
 * silently strips the trailing space and reports success is the exact failure this
 * whole exercise hunts. So the restore bucket is seeded on Linux, where every fixture
 * exists, and a Windows restorer meets them all; a Windows backup build is partial by
 * nature, measured on what Windows can hold.
 *
 * Paths holding a tab, LF or CR are deliberately absent: guide/format.md refuses them
 * at backup time and the run stops, so a fixture with one would break the build rather
 * than test it.
 */
import {
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

// The sets, in backup order. Each one's tree is `<fixtures>/<name>`, and each claims
// that name in the bucket — which is why the restore build can reattach them with no
// tree in sight.
export const setNames = [
  "edge",
  "docs",
  "bulk",
  "media",
  "hollow",
  "spread",
  "faults",
  "corrupt",
];

// Every set's exclude patterns: s3cab's wherever it snapshots the trees (in the seed,
// replacing the starter file setup writes), the clean-room snapshot's in its sandbox
// (through cleanroom/sets/). ADR-0096 compares the clean-room snapshot's rows with `s3cab
// snapshot` of the same trees, and that comparison needs both to skip the same files. `spread`'s give each rule of
// guide/exclude.md's grammar a path it drops and a near miss it keeps, so a backup that
// implements less than the whole grammar backs up a different tree. `edge`'s is the file a
// Windows editor leaves: CRLF endings and no newline after the last line. guide/format.md
// says both travel into the bucket byte for byte, and that the lines are trimmed when read,
// so a snapshot that keeps the CR in a pattern backs up `ignored.tmp`, one that drops an
// unterminated last line backs up `ignored.swp`, and an upload that rewrites the file has
// changed it.
export const excludes = new Map([
  ["edge", "*.tmp\r\n*.swp"],
  ["spread", "*.log\n**/cache.bin\nlogs/**\nv?.bak\nbuild/\n"],
]);

/**
 * Write one fixture file. `mtime` pins the timestamp where the value is itself the
 * test (F6's boundaries); omitting it leaves the filesystem's own sub-millisecond
 * time, which is what makes the spec's rounding-to-the-millisecond observable.
 * @param {string} path
 * @param {string | Buffer} content
 * @param {number} [mtime] seconds since the epoch, fractional
 */
const file = (path, content, mtime) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mtime !== undefined) {
    utimesSync(path, mtime, mtime);
  }
};

/**
 * Build every set's tree under `dir`, and return each set's member directories along
 * with the fixture groups this platform refused.
 * @param {string} dir
 */
export function buildFixtures(dir) {
  const posix = process.platform !== "win32";
  /** @type {string[]} */
  const skipped = [];

  /**
   * Create a fixture whose name only a POSIX filesystem accepts, recording it as
   * skipped on Windows. Silence here would leave a partial build looking complete.
   * @param {string} label
   * @param {() => void} build
   */
  const posixOnly = (label, build) => {
    if (posix) {
      build();
    } else {
      skipped.push(label);
    }
  };

  /** `edge`: the crafted adversarial set — one fixture per audit finding. */
  const edge = join(dir, "edge");

  /**
   * Create two files in `edge` whose names some filesystems fold into one, and record the
   * pair as skipped where they did. Asked of the filesystem, not the platform: APFS folds
   * both case and normal form on a "POSIX" OS, NTFS folds case but not normal form, and
   * the folded file is removed so nothing half-built is backed up.
   * @param {string} label
   * @param {[string, string]} first name and content
   * @param {[string, string]} second
   */
  const distinctPair = (label, [a, contentA], [b, contentB]) => {
    file(join(edge, a), contentA);
    file(join(edge, b), contentB);
    const names = readdirSync(edge);
    if (!names.includes(a) || !names.includes(b)) {
      rmSync(join(edge, a), { force: true });
      skipped.push(label);
    }
  };
  file(join(edge, "plain.txt"), "an ordinary file\n", 1_500_000_000);
  // Escapes on purpose: these two names look identical in every editor and differ only
  // in normal form, which is why they belong here. A reader that normalises paths merges
  // them silently, and so does APFS.
  distinctPair(
    "NFC/NFD pair of names (F1) — this filesystem folds Unicode normal form",
    ["caf\u00e9.txt", "NFC: e-acute as one code point\n"],
    ["cafe\u0301.txt", "NFD: e + combining acute\n"],
  );
  file(join(edge, "日本語.txt"), "CJK\n");
  file(join(edge, "🎉 emoji 🎉.txt"), "astral plane\n");
  file(join(edge, "empty.txt"), "");
  // Same bytes under two names, in different directories: one object, two rows. Proves
  // the store is content-addressed and that a restorer keyed on path still gets both.
  // The restore build deletes this content for F5, so there is one object to delete.
  file(join(edge, "dedup-a.txt"), "shared content\n");
  file(join(edge, "sub", "dedup-b.txt"), "shared content\n");
  // F6: mtimes chosen to be awkward rather than merely old — a value that rounds up
  // across a second boundary, the 32-bit signed overflow, and a pre-1980 date.
  file(join(edge, "mtime-rounds-up.txt"), "x\n", 1_500_000_000.9996);
  file(join(edge, "mtime-2038.txt"), "x\n", 2_147_483_648);
  file(join(edge, "mtime-1970s.txt"), "x\n", 86_400);
  // F10: sizes spanning the second column's 10-character minimum width.
  for (const [name, size] of [
    ["size-1b.bin", 1],
    ["size-1k.bin", 1024],
    ["size-1m.bin", 1024 * 1024],
  ]) {
    file(join(edge, "sizes", String(name)), randomBytes(Number(size)));
  }
  posixOnly("leading/trailing-space filenames (F2)", () => {
    file(join(edge, " leading.txt"), "leading space\n");
    file(join(edge, "trailing.txt "), "trailing space\n");
    file(join(edge, " both ends.txt "), "both ends\n");
  });
  posixOnly("\\v, \\f and U+0085 in filenames (F3)", () => {
    file(join(edge, "vertical\vtab.txt"), "vertical tab\n");
    file(join(edge, "form\ffeed.txt"), "form feed\n");
    file(join(edge, "next\u0085line.txt"), "U+0085 NEXT LINE\n");
  });
  distinctPair(
    "case-differing sibling paths (F14) — this filesystem folds case",
    ["Case.txt", "upper\n"],
    ["case.txt", "lower\n"],
  );
  posixOnly("path past Windows MAX_PATH (F13)", () => {
    const deep = join(
      edge,
      ...Array.from({ length: 12 }, () => "a".repeat(24)),
    );
    file(join(deep, "deep.txt"), "past 260 characters\n");
  });
  // The one fixture that fails by permission rather than by the filesystem's rules:
  // Windows has symlinks, but creating one needs Developer Mode or elevation. So it is
  // attempted everywhere and skipped on the error, not gated on the platform — a
  // Developer Mode box builds the #SKIPPED row like any POSIX one.
  try {
    symlinkSync(join(edge, "plain.txt"), join(edge, "link-to-plain"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    skipped.push(`a symlink, for the #SKIPPED row (F9/F11) — ${reason}`);
  }
  // F9/F11: an #EXCLUDED row needs a file that matches a pattern we then install. Two,
  // one per line of `edge`'s exclude file (see `excludes`).
  file(join(edge, "ignored.tmp"), "excluded by pattern\n");
  file(join(edge, "ignored.swp"), "excluded by the unterminated last line\n");

  /** `docs`: ordinary data, so the run can find things the crafted set can't. */
  const docs = join(dir, "docs");
  for (let index = 0; index < 120; index += 1) {
    const depth = index % 4;
    const sub = join(docs, ...Array.from({ length: depth }, (_, d) => `d${d}`));
    file(
      join(sub, `note-${index}.md`),
      `# note ${index}\n${"body\n".repeat(index)}`,
    );
  }

  /** `bulk`: past ListObjectsV2's 1000-key page, with distinct content per file. */
  const bulk = join(dir, "bulk");
  for (let index = 0; index < 1100; index += 1) {
    file(join(bulk, `item-${index}.txt`), `unique ${index}\n`);
  }

  /** `media`: one object over the 16 MiB part size, so it is multipart-uploaded. */
  const media = join(dir, "media");
  file(join(media, "clip.bin"), randomBytes(40 * 1024 * 1024));
  file(join(media, "poster.bin"), randomBytes(512 * 1024));

  /** `hollow`: no files at all — a legal header-and-trailer-only snapshot (F16). */
  mkdirSync(join(dir, "hollow"), { recursive: true });

  /**
   * `spread`: the only set with more than one member directory, which is what makes the
   * restore layout decidable. Run 2 could not tell `<out>/<basename of #DIR>/<relative>`
   * from `<out>/<set>/<relative>` apart, because every set here had a single member
   * directory whose basename *was* the set name — the corpus made its own Tier 1 finding
   * unanswerable. Two differently-named directories separate them: the first rule
   * restores two directories side by side, the second merges them into one.
   *
   * Two member dirs sharing a *basename* — the follow-up question — are deliberately not
   * here. s3cab refuses that combination outright under `--output` (`reroot` in
   * src/lib/restore.mjs), so staging it would leave the set with no reference tree at
   * all, and the spec already says where a file lands is the tool's decision, not the
   * format's. The refusal is the answer; a fixture would only produce an unrestorable set.
   */
  const spread = join(dir, "spread");
  file(join(spread, "alpha", "from-alpha.txt"), "member directory alpha\n");
  file(join(spread, "beta", "from-beta.txt"), "member directory beta\n");
  // Matched against `excludes`' patterns, relative to each member directory.
  file(join(spread, "alpha", "run.log"), "dropped by *.log\n");
  file(join(spread, "alpha", ".log"), "kept: * is one or more characters\n");
  file(
    join(spread, "alpha", "cache.bin"),
    "dropped: **/ is zero segments too\n",
  );
  file(join(spread, "beta", "x", "y", "cache.bin"), "dropped: **/ at depth\n");
  file(join(spread, "beta", "logs", "top.txt"), "dropped by logs/**\n");
  file(join(spread, "beta", "logs", "a", "b.txt"), "dropped: ** crosses /\n");
  file(join(spread, "alpha", "v1.bak"), "dropped by v?.bak\n");
  file(join(spread, "alpha", "v10.bak"), "kept: ? is exactly one character\n");
  file(join(spread, "beta", "build", "out.o"), "dropped by build/\n");
  file(join(spread, "alpha", "build"), "kept: build/ matches a directory\n");
  file(
    join(spread, "beta", "src", "build", "in.o"),
    "kept: build/ is top-level\n",
  );

  /** `faults`: content unique to this set, so tearing its object breaks nothing else. */
  const faults = join(dir, "faults");
  file(join(faults, "recoverable.txt"), "this one survives\n");
  file(join(faults, "torn.txt"), `torn ${randomBytes(16).toString("hex")}\n`);
  // The *explained* absence, which run 2 never got to exercise: its report notes the
  // recorded-deletion skip "never fired in a real run", because F5's fixture deletes a
  // file's content and then re-backs it up — the presence-wins trap — leaving nothing in
  // the corpus that is absent *and* recorded. This one is deleted and stays deleted, so
  // the spec's "skips them gracefully with their date" has something to skip.
  file(
    join(faults, "deleted.txt"),
    `gone ${randomBytes(16).toString("hex")}\n`,
  );

  /**
   * `corrupt`: an object with the right key and the wrong bytes — run 2's finding 4, where
   * the spec never says to re-hash a download nor what to do when it doesn't match, and
   * its own policy "ran zero times against real data". Three files in known order, so the
   * tree shows whether a restorer carries on past the fault: s3cab's reference holds
   * `a-intact.txt` and `c-intact.txt` and no `b-` at all (the digest check refuses it,
   * reports it, and exits 1), and a restorer that stops at `b-` ends one file short. Run 3
   * caught s3cab itself doing exactly that, before the fix.
   */
  const corrupt = join(dir, "corrupt");
  file(join(corrupt, "a-intact.txt"), "restored before the bad one\n");
  file(
    join(corrupt, "b-corrupt.txt"),
    `will be replaced ${randomBytes(16).toString("hex")}\n`,
  );
  file(
    join(corrupt, "c-intact.txt"),
    "only reached by a restorer that carries on\n",
  );

  // Every set's member directories. `spread` is the only one with more than one, and the
  // reason the pair is a pair: a single-directory set cannot distinguish the two layout
  // rules run 2 was left guessing between.
  const sets = setNames.map(
    (name) =>
      /** @type {[string, string[]]} */ ([
        name,
        name === "spread"
          ? [join(spread, "alpha"), join(spread, "beta")]
          : [join(dir, name)],
      ]),
  );
  return { sets, skipped };
}

/**
 * Write a set's own files into `dir`: `dirs.txt`, and `exclude.txt` where the set has
 * patterns. The spec lays a set out the same way on the local side as under `sets/` in a
 * bucket, so a clean room's `sets/` and s3cab's home are written alike.
 * @param {string} dir
 * @param {string} name
 * @param {string[]} dirs the set's member directories
 */
export function writeSetFiles(dir, name, dirs) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "dirs.txt"), dirs.join("\n") + "\n");
  const exclude = excludes.get(name);
  if (exclude) {
    writeFileSync(join(dir, "exclude.txt"), exclude);
  }
}

/** @param {string} dir */
export const count = (dir) => {
  let total = 0;
  for (const entry of readdirSync(dir, {
    withFileTypes: true,
    recursive: true,
  })) {
    if (entry.isFile()) {
      total += 1;
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
 * @param {[string, string[]][]} sets
 * @param {string[]} skipped
 */
export function reportFixtures(dir, sets, skipped) {
  console.log(`\nbuilt the fixtures in ${dir}:`);
  for (const [name, dirs] of sets) {
    const total = dirs.reduce((sum, member) => sum + count(member), 0);
    const spread = dirs.length > 1 ? `  (${dirs.length} member dirs)` : "";
    console.log(`  ${name.padEnd(8)} ${files(total)}${spread}`);
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
 * A snapshot with its `#END` trailer cut off: the damage a backup killed mid-write leaves
 * (ADR-0082). Truncating the *compressed* bytes would test gunzip's own check instead, so
 * this decompresses, drops the trailer line, and recompresses — a well-formed gzip stream
 * missing its last line, which is precisely what a reader has to notice. The seed
 * publishes one for every restorer to refuse; the upload build hands one to the upload
 * room, whose program should refuse to publish it.
 * @param {Uint8Array} snapshot a whole `.tsv.gz`
 */
export function withoutTrailer(snapshot) {
  const text = gunzipSync(snapshot).toString("utf8");
  return gzipSync(Buffer.from(text.slice(0, text.lastIndexOf("#END")), "utf8"));
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
