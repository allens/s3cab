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
 * claimed by whoever stages them first, so a re-stage needs the bucket cleared. The
 * preflight below says so up front rather than letting `setup` say it three minutes in.
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
 * than real S3: the `#END` trailer (new since the audit — free, every snapshot has
 * one) and `bulk`, which pushes `objects/` past 1000 keys. That last is not required
 * by the spec's recovery recipe, which only ever lists `snapshots/<set>/` — but
 * materialising the store listing is a natural implementation choice (s3cab itself
 * does it, ADR-0069) and `ListObjectsV2` truncates at 1000 without saying so.
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
 *   node scripts/cleanroom-fixtures.mjs --bucket <name> --out <cleanroom-dir>
 *   node --env-file=.env.test scripts/cleanroom-fixtures.mjs --out ~/s3cab-cleanroom-cpp
 *   … --trees-only            build the trees, report what this platform managed, stop
 *
 * Runs the real CLI as a subprocess, so `reference/` is what the tool itself produces
 * and the script has no privileged access to s3cab's internals. S3CAB_HOME is pointed
 * at a working directory, so the fixture sets never touch your real ~/.s3cab while
 * ~/.aws credentials keep working.
 */
import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const args = process.argv.slice(2);
const valueOf = (/** @type {string} */ flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const bucket = valueOf("--bucket") ?? process.env.S3CAB_TEST_BUCKET;
const out = valueOf("--out");
const work = valueOf("--work") ?? join(tmpdir(), "s3cab-cleanroom-fixtures");
// Same arguments as the real thing, plus one flag — so what you rehearse is the command
// you then run, rather than a second spelling of it that could drift.
const treesOnly = args.includes("--trees-only");
if (!bucket || !out) {
  console.error(
    "usage: node scripts/cleanroom-fixtures.mjs --bucket <name> --out <cleanroom-dir>\n" +
      "                                          [--work <dir>] [--trees-only]\n" +
      "\ne.g. node --env-file=.env.test scripts/cleanroom-fixtures.mjs --out ~/s3cab-cleanroom-cpp",
  );
  process.exit(2);
}

// The six sets, in staging order. Each one's tree is `trees/<name>`, and each claims
// that name in the bucket — which is why the preflight below can ask about them before
// a single tree exists.
const setNames = ["edge", "docs", "bulk", "media", "hollow", "faults"];
const posix = process.platform !== "win32";
/** @type {string[]} */
const skipped = [];
const s3cab = join(import.meta.dirname, "..", "src", "s3cab.mjs");
const home = join(work, ".s3cab");
const trees = join(work, "trees");
const reference = join(resolve(out), "reference");

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

// ── Is the bucket clear? ────────────────────────────────────────────────────

const client = new S3Client({});

// s3cab claims a set name in the bucket for whoever sets it up first, so re-staging
// into a bucket that still holds the last corpus is already caught — by `setup`,
// three minutes in, after the trees are built, with a collision error whose advice
// (`reattach`) is right for the user it was written for and wrong here. Ask the bucket
// first instead, and give the fix that applies. --trees-only never reaches this: it is
// the one mode that touches no network at all.
if (!treesOnly) {
  const listing = await client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: "sets/",
      Delimiter: "/",
    }),
  );
  const claimed = (listing.CommonPrefixes ?? [])
    .map((entry) =>
      (entry.Prefix ?? "").slice("sets/".length).replace(/\/$/, ""),
    )
    .filter((name) => setNames.includes(name));
  if (claimed.length > 0) {
    console.error(
      `The bucket '${bucket}' already holds a staged corpus: ${claimed.join(", ")}.\n` +
        "Snapshots are immutable and set names are claimed by the first machine to set\n" +
        "them up, so this run would stop at the first 'setup' with the trees already\n" +
        "built. Empty the repository and stage again — it is a test bucket, and nothing\n" +
        "in it is meant to outlive a run except the corpus you are replacing:\n" +
        "\n" +
        `    aws s3 rm s3://${bucket}/ --recursive\n` +
        "\n" +
        "Not while an integration suite is running against the same bucket, though —\n" +
        "that takes its in-flight objects too. Staging into another bucket also works.",
    );
    process.exit(2);
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

/** `faults`: content unique to this set, so tearing its object breaks nothing else. */
const faults = join(trees, "faults");
const tornContent = `torn ${randomBytes(16).toString("hex")}\n`;
const tornHash = createHash("sha256").update(tornContent).digest("hex");
file(join(faults, "recoverable.txt"), "this one survives\n");
file(join(faults, "torn.txt"), tornContent);

const sets = setNames.map(
  (name) => /** @type {[string, string]} */ ([name, join(trees, name)]),
);

// --trees-only stops here, before anything reaches S3. Staging the corpus writes well
// over a thousand objects and claims six set names in the repository, and on Windows it
// would claim them for a corpus missing every [POSIX] fixture — so seeing what this
// platform actually built, before any of that, is worth a flag.
if (treesOnly) {
  console.log(`\nbuilt the trees under ${trees}, and stopped before S3:`);
  for (const [name, dir] of sets) {
    console.log(`  ${name.padEnd(8)} ${count(dir)} files`);
  }
  reportSkipped();
  process.exit(0);
}

// ── Back them up ────────────────────────────────────────────────────────────

for (const [name, dir] of sets) {
  console.log(`setup ${name}`);
  mustRun(["setup", "--set", name, "--bucket", bucket, dir]);
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

// ── The reference restores ──────────────────────────────────────────────────

rmSync(reference, { recursive: true, force: true });
mkdirSync(reference, { recursive: true });

/** @type {string[]} */
const faultExits = [];
for (const [name] of sets) {
  const snapshotDir = join(home, "sets", name, "snapshots");
  const snapshots = readdirSync(snapshotDir)
    .filter((entry) => entry.endsWith(".tsv.zst") && !entry.startsWith("."))
    .map((entry) => entry.replace(/\.tsv\.zst$/, ""));
  for (const snapshot of snapshots) {
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
    mkdirSync(target, { recursive: true });
  }
}

// ── What the corpus actually came out as ────────────────────────────────────

console.log(`\nreference trees in ${reference}`);
for (const entry of readdirSync(reference)) {
  console.log(`  ${entry}  (${count(join(reference, entry))} files)`);
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
