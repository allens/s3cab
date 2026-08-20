/**
 * Build the clean-room fixture corpus: the backup sets a clean-room restorer is
 * measured against, and the `reference/` trees it compares its output to.
 *
 * WHY THIS IS A SCRIPT AND NOT A CHAT. The first clean-room run
 * (docs/format-spec-audit.md) was staged by hand against real local trees on one
 * machine, and its harness "was a session artifact and is not preserved". So run 2
 * cannot be compared with run 1 on equal data — the corpus is simply gone. Since the
 * whole point of a re-run is diffing its ambiguity list against the last one (a
 * reappearing item is a fix that didn't land), the corpus has to be reproducible or
 * every future run restarts that loss. Re-running this script rebuilds the same
 * structure *into an empty repository* — snapshots are immutable and set names are
 * claimed by whoever stages them first, so a re-stage needs the bucket cleared. It
 * clears it itself when the bucket holds nothing but this script's own sets, and stops
 * when it holds anything else; see the preflight below.
 *
 * WHAT "A GOOD SET" MEANS. Not taste. Every Tier 1/2 finding in the audit is a place
 * the spec was silent and a restorer could go wrong; each now has a fix in
 * guide/format.md, and a fixture here that would catch a regression or a mis-reading.
 * Findings a corpus *cannot* provoke are listed too, honestly, rather than being
 * quietly dropped so the table looks complete.
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
 *   F14 cross-OS hazards     two paths differing only in case                  [POSIX]
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
 * [POSIX] fixtures cannot exist on Windows: NTFS forbids control characters in names,
 * strips trailing spaces, and is case-insensitive. They are skipped with a loud notice
 * rather than silently, and a Windows-built corpus is a partial one. Keep them in the
 * corpus permanently even so — for a future Windows clean-room run they become the
 * point. A Windows restorer that refuses them, or skips them loudly, is behaving
 * correctly; one that silently strips the trailing space and reports success is the
 * exact failure this whole exercise hunts.
 *
 * Paths holding a tab, LF or CR are deliberately absent: guide/format.md refuses them
 * at backup time and the run stops, so a fixture with one would break the corpus
 * rather than test it.
 *
 * Usage:
 *   node scripts/cleanroom/stage.mjs --bucket <name> --out <cleanroom-dir>
 *   node --env-file=.env.test scripts/cleanroom/stage.mjs --out ~/s3cab-cleanroom-cpp
 *   … --trees-only            build the trees, report what this platform managed, stop
 *
 * Runs the real CLI as a subprocess, so `reference/` is what the tool itself produces
 * and the script has no privileged access to s3cab's internals. S3CAB_HOME is pointed
 * at a working directory, so the fixture sets never touch your real ~/.s3cab while
 * ~/.aws credentials keep working.
 */
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const valueOf = (/** @type {string} */ flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

/**
 * Expand a leading `~`. Every usage line here writes `~/s3cab-cleanroom-cpp` because
 * that is what you type in the shell this exercise is run from — but PowerShell does not
 * expand it, so node is handed the literal `~` and `resolve` makes it a directory named
 * `~` under the cwd. That cwd is the repo, so a documented command quietly wrote a
 * 1255-file corpus into the working tree. Expanding it here is the fix; the repo check
 * below is the backstop for the typo this one didn't come from.
 * @param {string} path
 */
const expandHome = (path) =>
  path === "~" || path.startsWith("~/") || path.startsWith("~\\")
    ? join(homedir(), path.slice(1))
    : path;

const bucket = valueOf("--bucket") ?? process.env.S3CAB_TEST_BUCKET;
const out = valueOf("--out");
const work = expandHome(
  valueOf("--work") ?? join(tmpdir(), "s3cab-cleanroom-stage"),
);
// Same arguments as the real thing, plus one flag — so what you rehearse is the command
// you then run, rather than a second spelling of it that could drift.
const treesOnly = args.includes("--trees-only");
if (!bucket || !out) {
  console.error(
    "usage: node scripts/cleanroom/stage.mjs --bucket <name> --out <cleanroom-dir>\n" +
      "                                        [--work <dir>] [--trees-only]\n" +
      "\ne.g. node --env-file=.env.test scripts/cleanroom/stage.mjs --out ~/s3cab-cleanroom-cpp",
  );
  process.exit(2);
}

// The same directory `create.mjs` already refuses to put inside the repo, so the two
// commands have to agree about it — a clean room outside the tree whose reference trees
// land inside it is the worst of both. The reason differs, though: there it is
// contamination, here it is a four-figure file count dumped in the working copy.
// Compared case-blind for the same reason create.mjs gives: `realpathSync.native`
// canonicalizes the drive letter (`D:\src\s3cab`) while `resolve` keeps whatever the
// operator typed (`d:\src\s3cab`), so a literal comparison misses the exact case this
// guard exists for. On a case-sensitive filesystem it can only over-refuse.
const reference = join(resolve(expandHome(out)), "reference");
const repoRoot = realpathSync.native(join(import.meta.dirname, "..", ".."));
if (reference.toLowerCase().startsWith(repoRoot.toLowerCase() + sep)) {
  console.error(
    `--out ${out} puts the reference trees inside the repository, at\n` +
      `${reference}. That is thousands of files in your working copy, and the\n` +
      "clean room they belong to is required to live outside it. Stage it beside\n" +
      "the room instead:\n" +
      "\n" +
      "    node scripts/cleanroom/stage.mjs --out ~/s3cab-cleanroom-cpp\n",
  );
  process.exit(2);
}

// The sets, in staging order. Each one's tree is `trees/<name>`, and each claims that
// name in the bucket — which is why the preflight below can ask about them before a
// single tree exists.
const setNames = [
  "edge",
  "docs",
  "bulk",
  "media",
  "hollow",
  "spread",
  "faults",
  "corrupt",
];
const posix = process.platform !== "win32";
/** @type {string[]} */
const skipped = [];
const s3cab = join(import.meta.dirname, "..", "..", "src", "s3cab.mjs");
const home = join(work, ".s3cab");
const trees = join(work, "trees");

/**
 * Run the real CLI, with s3cab's home pointed at the working directory. Returns the
 * exit code rather than throwing on failure: `faults` restores from a deliberately
 * torn repository, where a nonzero exit is the behaviour under test.
 * @param {string[]} argv
 */
const run = (argv) => {
  const result = spawnSync(process.execPath, [s3cab, ...argv], {
    env: { ...process.env, S3CAB_HOME: home },
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  return { code: result.status ?? 1, out: result.stdout, err: result.stderr };
};

/** @param {string[]} argv */
const mustRun = (argv) => {
  const result = run(argv);
  if (result.code !== 0) {
    throw new Error(
      `s3cab ${argv.join(" ")} exited ${result.code}\n${result.out}\n${result.err}`,
    );
  }
  return result;
};

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
 * Create a fixture whose name only a POSIX filesystem accepts, recording it as
 * skipped on Windows. Silence here would leave a partial corpus looking complete.
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

/** @param {string} dir */
const count = (dir) => {
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
 * this script claims no privileged access to s3cab's internals (see the header).
 * @param {number} n
 */
const files = (n) => `${n} file${n === 1 ? "" : "s"}`;

/**
 * Name every fixture group this platform refused, rather than letting a partial corpus
 * read as a complete one — the same silent-shortening failure the clean room's own
 * firewall exists to prevent, arriving through the data instead of the reading.
 */
const reportSkipped = () => {
  if (skipped.length === 0) {
    return;
  }
  console.log(
    `\n! this platform could not create ${skipped.length} fixture group${skipped.length === 1 ? "" : "s"}:\n` +
      skipped.map((label) => `    ${label}`).join("\n") +
      "\n  NTFS forbids control characters, strips trailing spaces and folds case, and a\n" +
      "  symlink needs Developer Mode — so a Windows-built corpus is a partial one.\n" +
      "  Rebuild it from WSL for the full set; those fixtures target Tier 1 findings.",
  );
};

// Wall-clock minute precision names a snapshot, and a second snapshot of a set in the
// same minute is an error rather than an overwrite (guide/format.md, "Snapshots are
// immutable"). Sets are backed up round-robin so the clock moves on its own where it
// can; this is the fallback when a set genuinely needs two generations back to back.
const waitForNextMinute = async () => {
  const start = new Date().getMinutes();
  process.stdout.write("  waiting for the clock to tick over");
  while (new Date().getMinutes() === start) {
    await new Promise((r) => setTimeout(r, 2000));
    process.stdout.write(".");
  }
  process.stdout.write("\n");
};

/**
 * The snapshot name one minute before this one. Used once, to name the damaged copy
 * staged below: a snapshot name is a timestamp, so a *later* one would make the damaged
 * snapshot `faults`'s newest and a bare `restore --set faults` would stop there — hiding
 * F7, which is the same set's point. Backdating leaves the intact snapshot as the latest
 * and the damaged one reachable only by asking for it by name.
 *
 * Snapshot names are *local* time, so this parses and prints as UTC throughout: both
 * ends of the arithmetic use the same zone, so the answer is the local name one minute
 * back, and no offset is ever applied.
 * @param {string} name e.g. `2026-08-20T1432`
 */
const oneMinuteBefore = (name) => {
  const stamp = new Date(`${name.slice(0, 13)}:${name.slice(13)}:00Z`);
  stamp.setUTCMinutes(stamp.getUTCMinutes() - 1);
  return stamp.toISOString().slice(0, 16).replace(":", "");
};

// ── Is the bucket ours to empty? ────────────────────────────────────────────

const client = new S3Client({});

/**
 * Every key in the bucket, paged. `ListObjectsV2` truncates at 1000 without saying so —
 * the very hazard `bulk` exists to expose in a restorer — so the one place this script
 * reads a whole listing has to follow the continuation token itself.
 * @param {string} [prefix]
 */
const listAll = async (prefix) => {
  /** @type {string[]} */
  const keys = [];
  /** @type {string | undefined} */
  let token;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    keys.push(...(page.Contents ?? []).map(({ Key }) => Key ?? ""));
    token = page.NextContinuationToken;
  } while (token);
  return keys;
};

// Re-staging needs an empty repository: snapshots are immutable and a set name belongs
// to whoever claimed it first, so `setup` would refuse — three minutes in, after the
// trees are built, with advice (`reattach`) written for a user rather than for a corpus.
//
// There is never a reason to keep the previous corpus, so the question worth asking is
// not "may I clear this?" but "is this bucket mine to clear?" — the wrong `--bucket`, an
// `.env.test` pointing somewhere forgotten, a live integration run. The set names answer
// it: the suite names its sets for the clock (`rt1755…`), never one of ours. So a bucket
// holding only our own names is this script's own leftovers and goes; anything else and
// we stop and say what we found. A flag would have put that judgement on the operator at
// the moment they are least likely to check.
//
// It is a check, not a lock: a suite that *starts* after this reads loses its in-flight
// objects, which is why the notice below stays. --trees-only never reaches any of this —
// it is the one mode that touches no network at all.
if (!treesOnly) {
  const listing = await client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: "sets/",
      Delimiter: "/",
    }),
  );
  const present = (listing.CommonPrefixes ?? []).map((entry) =>
    (entry.Prefix ?? "").slice("sets/".length).replace(/\/$/, ""),
  );
  const foreign = present.filter((name) => !setNames.includes(name));
  if (foreign.length > 0) {
    console.error(
      `The bucket '${bucket}' holds ${foreign.length} backup ` +
        `set${foreign.length === 1 ? "" : "s"} this script did not stage: ` +
        `${foreign.join(", ")}.\n` +
        "That is either an integration suite mid-run, another corpus, or not the bucket\n" +
        "you meant — and emptying it would take all three with it, so nothing has been\n" +
        "touched. Point --bucket somewhere expendable, or clear it yourself once you are\n" +
        "sure what is in there:\n" +
        "\n" +
        `    aws s3 rm s3://${bucket}/ --recursive\n`,
    );
    process.exit(2);
  }
  if (present.length > 0) {
    const keys = await listAll();
    console.log(
      `emptying s3://${bucket}/ — ${keys.length} object${keys.length === 1 ? "" : "s"}, ` +
        `all of it this script's own (${present.join(", ")})`,
    );
    console.log(
      "  an integration suite running against this bucket right now loses its\n" +
        "  in-flight objects; nothing else in here outlives a clean-room run",
    );
    // 1000 per request is the API's limit, not a batch size worth tuning.
    for (let index = 0; index < keys.length; index += 1000) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: keys.slice(index, index + 1000).map((Key) => ({ Key })),
          },
        }),
      );
    }
  }
}

// ── The trees ───────────────────────────────────────────────────────────────

rmSync(work, { recursive: true, force: true });

/** `edge`: the crafted adversarial set — one fixture per audit finding. */
const edge = join(trees, "edge");
file(join(edge, "plain.txt"), "an ordinary file\n", 1_500_000_000);
// Escapes on purpose: these two names look identical in every editor and differ only
// in normal form, which is why they belong here. A reader that normalises paths merges
// them silently; the filesystem treats them as two files.
file(join(edge, "caf\u00e9.txt"), "NFC: e-acute as one code point\n");
file(join(edge, "cafe\u0301.txt"), "NFD: e + combining acute\n");
file(join(edge, "日本語.txt"), "CJK\n");
file(join(edge, "🎉 emoji 🎉.txt"), "astral plane\n");
file(join(edge, "empty.txt"), "");
// Same bytes under two names, in different directories: one object, two rows. Proves
// the store is content-addressed and that a restorer keyed on path still gets both.
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
posixOnly("case-differing sibling paths (F14)", () => {
  file(join(edge, "Case.txt"), "upper\n");
  file(join(edge, "case.txt"), "lower\n");
});
posixOnly("path past Windows MAX_PATH (F13)", () => {
  const deep = join(edge, ...Array.from({ length: 12 }, () => "a".repeat(24)));
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
// F9/F11: an #EXCLUDED row needs a file that matches a pattern we then install.
file(join(edge, "ignored.tmp"), "excluded by pattern\n");

/** `docs`: ordinary data, so the run can find things the crafted set can't. */
const docs = join(trees, "docs");
for (let index = 0; index < 120; index += 1) {
  const depth = index % 4;
  const dir = join(docs, ...Array.from({ length: depth }, (_, d) => `d${d}`));
  file(
    join(dir, `note-${index}.md`),
    `# note ${index}\n${"body\n".repeat(index)}`,
  );
}

/** `bulk`: past ListObjectsV2's 1000-key page, with distinct content per file. */
const bulk = join(trees, "bulk");
for (let index = 0; index < 1100; index += 1) {
  file(join(bulk, `item-${index}.txt`), `unique ${index}\n`);
}

/** `media`: one object over the 16 MiB part size, so it is multipart-uploaded. */
const media = join(trees, "media");
file(join(media, "clip.bin"), randomBytes(40 * 1024 * 1024));
file(join(media, "poster.bin"), randomBytes(512 * 1024));

/** `hollow`: no files at all — a legal header-and-trailer-only snapshot (F16). */
const hollow = join(trees, "hollow");
mkdirSync(hollow, { recursive: true });

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
const spread = join(trees, "spread");
const spreadDirs = ["alpha", "beta"].map((leaf) => join(spread, leaf));
file(join(spread, "alpha", "from-alpha.txt"), "member directory alpha\n");
file(join(spread, "beta", "from-beta.txt"), "member directory beta\n");

/** `faults`: content unique to this set, so tearing its object breaks nothing else. */
const faults = join(trees, "faults");
const tornContent = `torn ${randomBytes(16).toString("hex")}\n`;
const tornHash = createHash("sha256").update(tornContent).digest("hex");
file(join(faults, "recoverable.txt"), "this one survives\n");
file(join(faults, "torn.txt"), tornContent);
// The *explained* absence, which run 2 never got to exercise: its report notes the
// recorded-deletion skip "never fired in a real run", because F5's fixture deletes a
// file's content and then re-backs it up — the presence-wins trap — leaving nothing in
// the corpus that is absent *and* recorded. This one is deleted and stays deleted, so
// the spec's "skips them gracefully with their date" has something to skip.
file(join(faults, "deleted.txt"), `gone ${randomBytes(16).toString("hex")}\n`);

/**
 * `corrupt`: an object with the right key and the wrong bytes — run 2's finding 4, where
 * the spec never says to re-hash a download nor what to do when it doesn't match, and
 * its own policy "ran zero times against real data". Three files in known order, because
 * the two tools diverge here and the tree is what shows it: s3cab's restore aborts on
 * the mismatch (writeFileAtomic throws before the rename, and restore.mjs re-throws
 * anything that isn't a missing object), so its reference tree holds `a-intact.txt`
 * alone and never reaches `c-`, while a restorer that reports the fault and carries on
 * ends with both. That difference is the fixture working, not the corpus being wrong.
 * (The abort also leaves a `.s3cab-tmp` sibling, which the reference pass strips — see
 * the note there for why residue must not reach a comparison target.)
 */
const corrupt = join(trees, "corrupt");
const corruptContent = `will be replaced ${randomBytes(16).toString("hex")}\n`;
const corruptHash = createHash("sha256").update(corruptContent).digest("hex");
file(join(corrupt, "a-intact.txt"), "restored before the bad one\n");
file(join(corrupt, "b-corrupt.txt"), corruptContent);
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
      name === "spread" ? spreadDirs : [join(trees, name)],
    ]),
);

// --trees-only stops here, before anything reaches S3. Staging the corpus writes well
// over a thousand objects and claims every set name in the repository, and on Windows it
// would claim them for a corpus missing every [POSIX] fixture — so seeing what this
// platform actually built, before any of that, is worth a flag.
if (treesOnly) {
  console.log(`\nbuilt the trees under ${trees}, and stopped before S3:`);
  for (const [name, dirs] of sets) {
    const total = dirs.reduce((sum, dir) => sum + count(dir), 0);
    const spread = dirs.length > 1 ? `  (${dirs.length} member dirs)` : "";
    console.log(`  ${name.padEnd(8)} ${files(total)}${spread}`);
  }
  reportSkipped();
  process.exit(0);
}

// ── Back them up ────────────────────────────────────────────────────────────

for (const [name, dirs] of sets) {
  console.log(`setup ${name}`);
  mustRun(["setup", "--set", name, "--bucket", bucket, ...dirs]);
}

// The exclude pattern has to be in place before the first backup, or the #EXCLUDED
// row never appears. setup seeds a starter exclude.txt; append to it rather than
// replacing it, so the set stays representative of what a real one looks like.
const excludePath = join(home, "sets", "edge", "exclude.txt");
writeFileSync(excludePath, "*.tmp\n", { flag: "a" });

for (const [name] of sets) {
  console.log(`backup ${name}`);
  mustRun(["backup", name]);
}

// F5, presence wins: delete a file's content from the repository (which writes a
// deletion record and removes the object), then back the set up again with the file
// still on disk. The object returns; the record stays forever. A restorer that treats
// records as authoritative skips a file it could have restored — silently, reporting
// success. The first snapshot is the one that exercises it, so it has to already exist.
console.log("delete + re-backup (F5: presence wins)");
mustRun([
  "delete",
  "--bucket",
  bucket,
  "--force",
  join(edge, "dedup-a.txt"),
  join(edge, "sub", "dedup-b.txt"),
]);
await waitForNextMinute();
mustRun(["backup", "edge"]);

// F7, unexplained damage: remove an object from the store *without* a deletion record.
// Done through the SDK rather than `s3cab delete`, because delete's whole job is to
// leave the record that makes an absence expected — and it is the unexplained case the
// spec legislates for ("report it, carry on, exit nonzero") that has never been staged.
console.log(`tearing objects/${tornHash.slice(0, 12)}… out of the store (F7)`);
await client.send(
  new DeleteObjectCommand({ Bucket: bucket, Key: `objects/${tornHash}` }),
);

// The explained absence, and the counterpart to F5 above: the same `delete`, with no
// re-backup after it. The snapshot still names the file, the object is gone, and a
// record says so — which is the case the spec answers with "skips them gracefully with
// their date" and the one run 2 reported it had never been able to run.
console.log("delete without re-backup (the recorded-deletion skip)");
mustRun(["delete", "--bucket", bucket, "--force", join(faults, "deleted.txt")]);

// Right key, wrong bytes. Not `s3cab delete` and not a tear: the object is *present* and
// hashes to something else, so a restorer that trusts the key restores corrupt content
// under a clean exit. s3cab catches it in writeFileAtomic (ADR-0001) and aborts; whether
// a reader should carry on is exactly what run 2 found the spec silent about.
console.log(`replacing objects/${corruptHash.slice(0, 12)}… with wrong bytes`);
await client.send(
  new PutObjectCommand({
    Bucket: bucket,
    Key: `objects/${corruptHash}`,
    Body: "not the bytes this key promises\n",
  }),
);

// A snapshot with its `#END` trailer cut off. The trailer is the format's answer to a
// backup killed mid-write (ADR-0082), and it has only ever been staged *present* — so
// nothing has tested the one thing it exists for, and run 2 could only note that its
// own completeness check went unexercised. Truncating the *compressed* bytes would test
// zstd's leniency instead, so this decompresses, drops the trailer line, and
// recompresses: a well-formed frame missing its last line, which is precisely what a
// reader has to notice. It is published under `faults` as a second snapshot, backdated
// so the intact one stays the set's latest.
const wholeName = readdirSync(join(home, "sets", "faults", "snapshots"))
  .filter((entry) => entry.endsWith(".tsv.zst"))
  .sort()
  .at(-1);
const damagedName = oneMinuteBefore(
  /** @type {string} */ (wholeName).replace(/\.tsv\.zst$/, ""),
);
console.log(`publishing snapshots/faults/${damagedName} with no #END trailer`);
const whole = await client.send(
  new GetObjectCommand({
    Bucket: bucket,
    Key: `snapshots/faults/${wholeName}`,
  }),
);
const wholeBytes = await /** @type {NonNullable<typeof whole.Body>} */ (
  whole.Body
).transformToByteArray();
const text = zstdDecompressSync(wholeBytes).toString("utf8");
await client.send(
  new PutObjectCommand({
    Bucket: bucket,
    Key: `snapshots/faults/${damagedName}.tsv.zst`,
    Body: zstdCompressSync(
      Buffer.from(text.slice(0, text.lastIndexOf("#END")), "utf8"),
    ),
  }),
);

// ── The reference restores ──────────────────────────────────────────────────

rmSync(reference, { recursive: true, force: true });
mkdirSync(reference, { recursive: true });

// Every snapshot in the bucket gets a reference tree beside it, so a clean-room run can
// tell "I found nothing" from "I never looked". The damaged snapshot is named explicitly
// because it exists only in S3 — it was never written locally, so the directory listing
// that finds every other snapshot cannot find it.
const restores = sets.flatMap(([name]) =>
  readdirSync(join(home, "sets", name, "snapshots"))
    .filter((entry) => entry.endsWith(".tsv.zst") && !entry.startsWith("."))
    .map(
      (entry) =>
        /** @type {[string, string]} */ ([
          name,
          entry.replace(/\.tsv\.zst$/, ""),
        ]),
    ),
);
restores.push(["faults", damagedName]);

/** @type {string[]} */
const faultExits = [];
for (const [name, snapshot] of restores) {
  const target = join(reference, `${name}-${snapshot}`);
  console.log(`restore ${name} ${snapshot}`);
  const result = run([
    "restore",
    "--set",
    name,
    "--snapshot",
    snapshot,
    "--output",
    target,
  ]);
  if (result.code !== 0) {
    faultExits.push(`${name}/${snapshot} → ${result.code}`);
  }
  // `hollow` restores nothing, so s3cab prints "Nothing to restore" and creates no
  // output directory at all — correct, and it would leave the F16 snapshot as the one
  // in the bucket with no reference tree beside it. The empty directory here is the
  // harness's, not the tool's: it makes "nothing" a comparable answer rather than a
  // missing file, so a restorer that finds the set can tell it was meant to find it.
  // The damaged and corrupt snapshots land here too, with whatever s3cab wrote before
  // it gave up — a partial tree is the honest reference for a partial restore.
  mkdirSync(target, { recursive: true });
  // …minus s3cab's own failure-path residue. `writeFileAtomic` writes to a sibling temp
  // and only renames once the digest matches, so aborting on `corrupt` deliberately
  // leaves `.b-corrupt.txt.s3cab-tmp` behind (harmless to s3cab, which overwrites it on
  // retry). In a *reference* tree it is a trap: a restorer that correctly writes no such
  // file would be reported as missing one, which is the false finding this whole exercise
  // exists to avoid. The reference is the comparison target, not a transcript of the
  // tool's internals, so tool residue comes out — the same reasoning as the empty
  // directory above.
  for (const entry of readdirSync(target, {
    withFileTypes: true,
    recursive: true,
  })) {
    if (entry.isFile() && entry.name.endsWith(".s3cab-tmp")) {
      unlinkSync(join(entry.parentPath, entry.name));
    }
  }
}

// ── What the corpus actually came out as ────────────────────────────────────

console.log(`\nreference trees in ${reference}`);
for (const entry of readdirSync(reference)) {
  console.log(`  ${entry}  (${files(count(join(reference, entry)))})`);
}
if (faultExits.length > 0) {
  console.log(
    `\nnonzero restore exits (expected for faults — that is the behaviour under test):\n  ${faultExits.join("\n  ")}`,
  );
}
reportSkipped();
console.log(
  `\nWorking tree kept at ${work} — it holds the sources the reference trees were\n` +
    `restored from, which is what a source-vs-restore check compares. Delete it when done.`,
);
