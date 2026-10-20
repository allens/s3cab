/**
 * What the clean-room scripts share (ADR-0096): reading the one root each takes,
 * writing the clean room inside it — a copy of the spec, a brief naming the language,
 * the bucket and its credentials where the role has one, and nothing else — and driving
 * the real CLI for the builds that need s3cab's own output.
 *
 * A sandbox root holds `cleanroom/`, where the session is opened, beside what the build
 * needs and the session must not see (`fixtures/`, the trees a backup build hands over,
 * and `.s3cab/`, s3cab's home while a restore build runs it). It is built once, from
 * empty, and emptied when the run is harvested.
 *
 * The clean-room premise is that every conclusion the implementer reaches came from
 * guide/format.md. Telling a session not to read the rest of the repo does not secure
 * that, because a session opened inside the repo is handed CLAUDE.md before it reads
 * anything — and CLAUDE.md discusses the snapshot's UTC start instant, the @SET DIR
 * rows, the drive-letter normalisation and (via ADR-0004's filename) the TSV
 * encoding. Those are restore-correctness facts the reading is supposed to have to
 * derive, and a contaminated run fails silently: the ambiguity list comes back
 * shorter, which reads as "the spec is fixed". So the firewall is physical — a
 * directory outside the repo, holding the spec alone.
 *
 * The brief is written to the clean room's CLAUDE.md, which the headless run takes in
 * through `--append-system-prompt-file` (README.md says why).
 *
 * There are two roles, backup and restore. The role fixes the language: the backup is
 * Python on every platform, a restorer is its platform's canonical one (C# on Windows,
 * Swift on macOS, C on Linux; see README.md), so runs differ by reader and by spec version.
 * The restorer brief is language-neutral apart from one sentence. That sentence names no
 * version: "the most modern version that comes as standard on the platform you are
 * running on" is discovered on the machine, where a version pinned in prose would rot
 * the way a line number does. Windows is the exception below.
 *
 * A clean room built on Windows gets a Windows brief, because the platform is then the
 * thing under test. There is no package archive, so the sentence becomes "the .NET
 * Framework that ships with Windows, standard library only", and ENVIRONMENT.md names
 * its compiler (ADR-0096: nothing installed). The brief also pins the session to native
 * Windows: a user-level CLAUDE.md is loaded into every session, and one that routes
 * Windows work through WSL would quietly turn a Windows run into a Linux one. The
 * credentials are written as PowerShell for the same reason — a `.env` of `export` lines
 * invites a shell that isn't Windows.
 *
 * ENVIRONMENT.md names ONE bucket. Copying .env.test across would be handier and is
 * the wrong shape: it also names the crash and conformance buckets, whose suites
 * assert whole-bucket state (so a visitor breaks them) and which hold deliberately
 * torn repositories — snapshots published over swept objects, written on purpose by
 * test/crash. That is the exact signature of the finding this exercise hunts, so a
 * session that wandered into one would report a real observation as a spec defect.
 *
 * Credentials go in as static keys in credentials.env (credentials.ps1 on Windows), not
 * as AWS_PROFILE: the restorer brief forbids an AWS SDK, and a profile name is only
 * meaningful to one. Resolving through the chain mints a fresh window at every build.
 */
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

export const repoRoot = realpathSync.native(
  join(import.meta.dirname, "..", ".."),
);

/**
 * One client for every script's own requests, through the standard credential chain. It
 * follows a bucket into its own region: at home the restore bucket is CI's, in another
 * region from the personal buckets AWS_REGION names.
 *
 * No keep-alive: `cli`'s spawnSync blocks the event loop, so a pooled socket never hears
 * S3 close it (after ~5 s idle) and the next request writes to it dead — on Windows an
 * ECONNABORTED the SDK doesn't retry. Not an idle-socket timeout like s3cab's own
 * (ADR-0091): its timer can't fire while the loop is blocked either.
 */
export const client = new S3Client({
  followRegionRedirects: true,
  requestHandler: { httpsAgent: { keepAlive: false } },
});
const windows = process.platform === "win32";
const darwin = process.platform === "darwin";
/**
 * Where a sandbox goes, for the usage lines: outside the home folder and temp, which the
 * transcript audit watches (README.md). Linux has no such folder a user can make, so the
 * operator makes `/srv/s3cab.sandbox` once.
 */
export const exampleRoot = windows
  ? "C:\\s3cab.sandbox"
  : darwin
    ? "/Users/Shared/s3cab.sandbox"
    : "/srv/s3cab.sandbox";
export const credentialsFile = windows ? "credentials.ps1" : "credentials.env";
/** What the restorer brief has the session build, in the clean room, for check-restore.mjs. */
export const restoreProgram = windows ? "s3cab-restore.exe" : "s3cab-restore";

/**
 * A sandbox root as typed, made absolute, and canonical once it exists: s3cab spells
 * every path it writes canonically, so a root typed with a lowercase drive letter or
 * through a symlink (macOS's `/tmp`) would otherwise put one spelling in the brief and
 * another in every row of s3cab's reference. A leading `~` is expanded here: every usage
 * line writes one and PowerShell does not expand it, so node would take it literally and
 * `resolve` would make a directory named `~` under the cwd — which is the repo, the one
 * place a sandbox must never be, reported as a path the operator never typed.
 * @param {string} arg
 */
export function sandboxPath(arg) {
  const root = resolve(
    arg === "~" || arg.startsWith("~/") || arg.startsWith("~\\")
      ? join(homedir(), arg.slice(1))
      : arg,
  );
  return existsSync(root) ? realpathSync.native(root) : root;
}

/**
 * Read `<root>`, or exit 2 saying what was wrong. The root has to be outside the repo,
 * and empty. Every build reads its bucket too, with {@link readCommandLine}.
 * @param {string} script this script's file name, for the usage line
 * @param {boolean} audited whether a session will run here, whose transcript is audited
 */
function readRoot(script, audited) {
  const command = `node --env-file=.env.test scripts/cleanroom/${script}`;
  const usage = `usage: ${command} <root>\n\ne.g. ${command} ${exampleRoot}`;
  /** @type {ReturnType<typeof parseArgs>} */
  let parsed;
  try {
    parsed = parseArgs({ allowPositionals: true });
  } catch {
    console.error(usage);
    return process.exit(2);
  }
  const [arg] = parsed.positionals;
  if (parsed.positionals.length !== 1 || !arg) {
    console.error(usage);
    return process.exit(2);
  }

  const root = sandboxPath(arg);
  // Compared case-blind because Windows spells the same directory several ways
  // (`realpathSync` gives `D:\src\s3cab`, `resolve` keeps a typed `d:\src\s3cab`); on a
  // case-sensitive filesystem that can only over-refuse, the safe direction here.
  const lowerRoot = root.toLowerCase();
  /** @param {string} place */
  const inside = (place) => {
    const lowerPlace = place.toLowerCase();
    return lowerRoot === lowerPlace || lowerRoot.startsWith(lowerPlace + sep);
  };

  // The one guard that matters: a clean room inside the repo is not a clean room, since
  // the session would inherit the repo's CLAUDE.md from a parent directory. Run from a
  // worktree, that is the main checkout too, which holds the worktree's own `.git`.
  const common = spawnSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: repoRoot, encoding: "utf8" },
  ).stdout?.trim();
  const checkouts = [
    repoRoot,
    ...(common ? [dirname(realpathSync.native(common))] : []),
  ];
  if (checkouts.some(inside)) {
    console.error(
      `${root} is inside the repository, so a session opened there would be handed\n` +
        "CLAUDE.md and the rest of the source — which is the one thing a clean room\n" +
        "has to prevent. Build it somewhere outside the repo instead:\n" +
        "\n" +
        `    ${command} ${exampleRoot}\n`,
    );
    return process.exit(2);
  }

  // The audit reads every command naming home or temp as a move out of the sandbox, so a
  // sandbox in either makes the session's own paths strays. Both spellings, as a root that
  // doesn't exist yet isn't canonical: macOS's `$TMPDIR` is `/var/folders/…`, its realpath
  // `/private/var/folders/…`.
  const watched = audited
    ? [homedir(), tmpdir()]
        .flatMap((place) => [place, realpathSync.native(place)])
        .find(inside)
    : undefined;
  if (watched) {
    console.error(
      `${root} is inside ${watched}, which the transcript audit watches, so every\n` +
        "command the session ran in its own sandbox would read as a stray. Build it\n" +
        "outside the home folder and temp instead:\n" +
        "\n" +
        `    ${command} ${exampleRoot}\n` +
        (windows || darwin
          ? ""
          : '\nMake that folder once first: sudo install -d -o "$USER" /srv/s3cab.sandbox\n'),
    );
    return process.exit(2);
  }

  // Built once, from empty: a leftover from the last turn is either an older brief the
  // session would read beside the new one, or s3cab's output in reach.
  if (existsSync(root) && readdirSync(root).length > 0) {
    console.error(
      `${root} already has files in it. A sandbox is built from empty, once per run —\n` +
        "harvest what the last run wrote, empty it, and build again:\n" +
        "\n" +
        (windows
          ? `    Remove-Item -Recurse "${root}"\n`
          : `    find "${root}" -mindepth 1 -delete\n`),
    );
    return process.exit(2);
  }

  // Made here so the build works from its canonical spelling (sandboxPath), as the
  // checker will from the one it is given later.
  mkdirSync(root, { recursive: true });
  return realpathSync.native(root);
}

/**
 * Read `<root>` and the bucket, or exit 2 saying what was wrong.
 * @param {string} script this script's file name, for the usage line
 * @param {string} variable the environment variable naming its bucket
 * @param {{ audited?: boolean }} [options] `audited` for a build, whose session's transcript
 *   is audited; not the seed's, whose root sits in CI's `runner.temp`, under its home
 */
export function readCommandLine(script, variable, { audited = false } = {}) {
  const root = readRoot(script, audited);
  return { root, bucket: readBucket(script, variable, root) };
}

/**
 * Read the bucket `variable` names, or exit 2 saying what was wrong.
 * @param {string} script this script's file name, for the example command
 * @param {string} variable the environment variable naming its bucket
 * @param {string} args the example command's arguments
 */
export function readBucket(script, variable, args) {
  const bucket = process.env[variable];
  if (!bucket) {
    console.error(
      `No clean-room bucket is set (${variable}). Run with the test\n` +
        "environment, which names it:\n" +
        "\n" +
        `    node --env-file=.env.test scripts/cleanroom/${script} ${args}\n`,
    );
    return process.exit(2);
  }
  return bucket;
}

/**
 * The session's static keys. Resolved before anything is written, so a lapsed SSO
 * session fails with one clear message instead of leaving a half-built sandbox behind.
 * These are SSO session credentials, so resolving them mints the permission set's full
 * session duration rather than whatever was left of the last one.
 * @param {string} bucket
 */
export async function sessionCredentials(bucket) {
  const profile = process.env.AWS_PROFILE;
  return await client.config.credentials().catch((error) => {
    console.error(
      `couldn't resolve AWS credentials for ${bucket}, and the clean room needs them\n` +
        "as static keys. If the SSO session has lapsed:\n" +
        "\n" +
        `    aws sso login${profile ? ` --profile ${profile}` : ""}\n` +
        "\n" +
        `(${error instanceof Error ? error.message : error})`,
    );
    return process.exit(2);
  });
}

/**
 * The in-box .NET Framework's compiler and Windows PowerShell, as a Windows restorer's
 * ENVIRONMENT.md names them (ADR-0096: nothing installed). Named by the build, since a
 * session left to find a compiler searches, and a look in the home folder for a
 * per-user .NET voids the run. The folder has been `v4.0.30319` since 2010 and the
 * product line has ended, so the path is fixed.
 * @returns {string}
 */
function csharpToolchain() {
  const windir = process.env.windir ?? "C:\\Windows";
  const csc = join(
    windir,
    "Microsoft.NET",
    "Framework64",
    "v4.0.30319",
    "csc.exe",
  );
  if (!existsSync(csc)) {
    console.error(
      `${csc} doesn't exist, so this Windows has no .NET Framework 4, which the\n` +
        "restorer brief names (ADR-0096). Install .NET Framework 4.8 and build again.",
    );
    return process.exit(2);
  }
  const powershell = join(
    windir,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return `## Toolchain

The .NET Framework that ships with Windows. Use it and nothing else, even where something newer
is installed, and don't look for another: that a stock Windows machine is enough is part of what
is being tested.

- Compiler: \`${csc}\` (C# 5)
- Or \`Add-Type\`, in Windows PowerShell: \`${powershell}\`
`;
}

/**
 * The settings the run's `--settings` passes (README.md says what they wall off). Not in the
 * clean room: where the shell sandbox runs, a file outside it is one the session can't
 * loosen mid-run; on Windows its shell can still reach it. Not a project settings file
 * either, which `strictAllowlist` is ignored from. No `sandbox` block on Windows, where
 * `failIfUnavailable` would refuse to start the run. The bucket line has to stay:
 * `--restricted` drops the user's `autoMode.environment`, and without one naming the
 * bucket the classifier refuses the backup's closing empty.
 * @param {"backup" | "restore"} role
 * @param {string} bucket
 */
function sessionSettings(role, bucket) {
  return {
    permissions: { blockReadsOutsideWorkingDirectories: true },
    ...(windows
      ? {}
      : {
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            network: {
              allowedDomains: ["*.amazonaws.com"],
              strictAllowlist: true,
            },
          },
        }),
    autoMode: {
      environment: [
        "$defaults",
        role === "backup"
          ? `Trusted cloud bucket: s3://${bucket} is this run's disposable test fixture. Writing to it and emptying it is routine.`
          : `Trusted cloud bucket: s3://${bucket} is this run's read-only test fixture. Listing and reading it is routine.`,
      ],
    },
  };
}

/**
 * The headless run's command, from `<root>/cleanroom` (README.md says what each flag is
 * for). No `Bash` on Windows, where it is Git Bash, which the brief rules out. A restore's
 * reconcile phase resumes the spec-only phase's session, with the brief appended again:
 * whether the first process's appended prompt survives `--resume` is unverified, and the
 * transcript can't show it.
 * @param {"backup" | "restore"} role
 * @param {boolean} [reconcile] a restore's reconcile phase
 */
export function runCommand(role, reconcile = false) {
  const tools = `${windows ? "PowerShell" : "Bash"},Read,Write,Edit,Glob,Grep,TaskStop`;
  return (
    `claude -p --restricted --tools ${tools} --settings ../session-settings.json` +
    (role === "backup" ? " --add-dir ../fixtures" : "") +
    ` --safe-mode --append-system-prompt-file CLAUDE.md` +
    (reconcile ? " --resume <uuid>" : " --session-id <uuid>") +
    ` --model <model> --effort <effort> --permission-mode auto --max-budget-usd 30` +
    (reconcile ? ' "read RECONCILE.md"' : " go")
  );
}

/** @typedef {{ accessKeyId: string, secretAccessKey: string, sessionToken?: string, expiration?: Date }} Credentials */

/**
 * When the keys expire, to the second, as the clean room is told.
 * @param {Credentials} credentials
 */
function expiryOf(credentials) {
  return credentials.expiration?.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * The bucket's keys, in a file of their own in the clean room, so the secret sits in one
 * obviously-disposable file rather than inside prose the session may quote back into a
 * report. Single-quoted because a session token is base64 and a shell would otherwise be
 * free to read it. The region and bucket go in it too, not as lines for the session to run:
 * under `blockReadsOutsideWorkingDirectories`, Claude Code's PowerShell parser refuses a
 * command that sets `$env:` itself, where dot-sourcing a file passes.
 * @param {string} dir
 * @param {Credentials} credentials
 * @param {string} bucket
 * @param {string | undefined} region
 */
export function writeCredentials(dir, credentials, bucket, region) {
  const assign = windows
    ? (/** @type {string} */ name, /** @type {string} */ value) =>
        `$env:${name} = '${value}'`
    : (/** @type {string} */ name, /** @type {string} */ value) =>
        `export ${name}='${value}'`;
  writeFileSync(
    join(dir, credentialsFile),
    [
      assign("AWS_ACCESS_KEY_ID", credentials.accessKeyId),
      assign("AWS_SECRET_ACCESS_KEY", credentials.secretAccessKey),
      ...(credentials.sessionToken
        ? [assign("AWS_SESSION_TOKEN", credentials.sessionToken)]
        : []),
      ...(region ? [assign("AWS_REGION", region)] : []),
      assign("BUCKET", bucket),
      "",
    ].join("\n"),
    "utf8",
  );
}

/**
 * What a restore's reconcile phase is to do, as `RECONCILE.md` in the clean room, which the
 * resumed session is told to read. Written only once `reference/` is in, so the spec-only
 * phase can't learn of it.
 * @param {string} dir
 * @param {Credentials} credentials the keys renewed for the reconcile phase
 */
export function writeReconcile(dir, credentials) {
  const expiry = expiryOf(credentials);
  writeFileSync(
    join(dir, "RECONCILE.md"),
    `# The reference restores

\`reference/\` now holds one directory per snapshot in the bucket, restored by the tool itself and
named for the set and snapshot it came from. An empty reference directory means the tool restored no
file from that snapshot: the directory is there so every snapshot has one, and the tool itself
creates nothing in that case, so no directory, or an empty one, matches it. Your report as it stood
has been copied out, so what you found without the references stays on record whatever you change
from here.

For each snapshot, compare your restorer's output with its reference byte-for-byte, including paths
and modification times. Investigate every difference: a mismatch is either a bug in your restorer
or a gap in the spec, and which one it is matters more than fixing it. Fix what is yours, and leave
the restorer built from your final source. Where you blame the spec you may still change your
restorer to match, if you say so: the program the first phase left is checked too.

Add a section to your report headed *Differences from the reference*: every difference you found,
what caused it, and whether it was your bug or a gap in the spec.
${
  expiry
    ? `
The keys in \`${credentialsFile}\` expire at ${expiry}, which replaces the time \`ENVIRONMENT.md\`
gives.
`
    : ""
}`,
    "utf8",
  );
}

/**
 * Write the clean room: the spec, the brief, ENVIRONMENT.md and the bucket's credentials.
 * @param {string} dir
 * @param {"backup" | "restore"} role
 * @param {string} bucket
 * @param {Credentials} credentials
 * @param {{ name: string, dirs: string[] }[]} [sets] for a backup, each set and its member
 *   directories, which ENVIRONMENT.md lists: the room has no set files (ADR-0107)
 */
export function writeCleanroom(dir, role, bucket, credentials, sets = []) {
  const python = role === "backup";
  const language = python ? "Python" : windows ? "C#" : darwin ? "Swift" : "C";
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;

  const kinds = `The spec sorts what it says into rules, recommendations and hints. A rule that is missing or
unclear is a gap, and goes in those ranked lists. A hint that would have saved you time, a trap in
your language or operating system the spec could have warned you about, goes in a separate list
headed *Hints that would have helped*. A guess about a recommendation can't break anything, so it
needn't be reported.

What it took to reach the bucket and build your program — signing and the HTTP transport, the
toolchain, the sandbox and its proxy, the bucket itself — goes in a list of its own headed
*Environment notes, not the format*. None of it is a gap in the spec.
`;

  const restoreBrief = `# Independent restorer for the s3cab storage format

\`format.md\` in this directory is the complete specification you are working from, and the only
source of format knowledge you may use. There is no source tree here and that is deliberate: this
is a clean-room exercise, and the worth of your report depends entirely on your conclusions coming
from the spec and nothing else.

## The task

s3cab's core promise is that its stored format is open enough that you could recover everything
without the tool, or write a replacement in an afternoon. The spec has been revised since that
claim was last tested, and I want it tested again by a fresh reader.

Working only from the spec, implement a minimal independent restorer in ${language}. ${
    windows
      ? `Use the .NET
Framework that ships with Windows — \`ENVIRONMENT.md\` says where its compiler is — and nothing
beyond its standard library, even where something newer is installed. Don't install a toolchain,
and don't spend the run fighting this one — if something you want isn't in the standard library,
pick something else.`
      : darwin
        ? `Use the most
modern version of the language that comes as standard on the platform you are running on, and take
your libraries from those that ship with macOS and the Xcode command-line tools, nothing from
Homebrew. Don't build a compiler or a runtime from source, and don't spend the run fighting a
toolchain — if something you want isn't there, pick something else.`
        : `Use the most
modern version of the language that comes as standard on the platform you are running on, and take
your libraries from what that platform packages. Don't build a compiler or a runtime from source,
and don't spend the run fighting a toolchain — if something you want isn't packaged, pick something
else.`
  }

**No AWS SDK, and no S3 client library, packaged or not.** Talk to S3 over plain HTTPS with a
general-purpose HTTP client and sign the requests yourself; hashing and decompression come from ${
    windows
      ? "the\nstandard library"
      : darwin
        ? "the\nsystem's own libraries"
        : "the\nplatform's own packages"
  }. That is the second thing being tested, so it is worth saying why: the tool
that writes this format depends on the vendor's SDK completely, and nobody has established what
*reading* it actually needs. A restorer that needs nothing from the vendor is a far stronger claim
than a documented format is.

The restorer has to be a program: it must not invoke the \`aws\` CLI, or any other command-line
tool, to do its work, because a wrapper around someone else's binary would show nothing. Consulting
that CLI while you get request signing right is fine and it is installed — a development aid is not
a dependency — but say in your report whether you needed it, or could sign from what you already
knew, because that is part of the question.

**Verify against the real bucket, over the network.** Don't stand up a local S3 server, a fake
endpoint, or a recorded-and-replayed transcript. Mocks generally don't check signatures at all, so
one would let a restorer that never signed a correct request in its life report a clean run — and
with no SDK in play, the signing is half of what is being measured. Testing your *parser* against
files on disk is a different thing and is fine. Every result you report has to come from a real
request.

If authenticated requests defeat you altogether, stop and report that rather than spending the run
on it. That answer is a result too.

Given a bucket, a set and a directory, reconstruct the set's files byte-for-byte under that
directory. Build it as \`${restoreProgram}\` in this directory, taking

    ${windows ? ".\\" : "./"}${restoreProgram} <bucket> <set> <dir> [<snapshot>]

with the credentials and region from the environment, as \`ENVIRONMENT.md\` sets them, and the
set's latest snapshot when none is named. Lay the files out as the spec describes s3cab's own
restore to a chosen directory. When you finish, leave it built from your final source, so that
command line runs it.

Then test it against the bucket: restore every snapshot, and check what it wrote against what the
spec says a restore leaves.

## Deliverable

The restorer, and a report on the spec, as \`REPORT.md\` in this directory.

List every point where \`format.md\` was ambiguous, silent, or wrong — anywhere you had to guess,
and what you guessed. Rank those into two lists, headed *Would corrupt a restore* and *Would
inconvenience the implementer*. **Those lists are the real output; the code is the means of
finding them.**

${kinds}
Record each guess as you make it, while you can still remember not knowing. A guess that turns out
right is still a gap in the spec, and it is the one you will be tempted to leave out.
`;

  // One program for the whole backup, walk to bucket (ADR-0096). The command line is
  // fixed so the harness can run it; what the program does with a set it can't back up
  // is the spec's to say and the report's to discuss, so the brief doesn't.
  const backupBrief = `# Independent backup for the s3cab storage format

\`format.md\` in this directory is the complete specification you are working from, and the only
source of format knowledge you may use. There is no source tree here and that is deliberate: this
is a clean-room exercise, and the worth of your report depends entirely on your conclusions coming
from the spec and nothing else.

## The task

s3cab's core promise is that its stored format is open enough that you could recover everything
without the tool, or write a replacement in an afternoon. This tests the second half: whether a
backup can be written from the spec alone, so that any reader of the spec can restore it.

Working only from the spec, write \`s3cab-backup.py\`: a Python program that takes a bucket, a set
name and the set's member directories,

    python s3cab-backup.py <bucket> <set> <dir>...

walks the directories, puts what it finds in the bucket, then the snapshot that names it, so that
the bucket holds the set as the spec describes a repository.

Use Python 3 with its standard library and boto3, as installed on this machine, and nothing else.
The same program has to run unchanged on Linux, macOS and Windows. If something the spec asks for
can't be done portably with those two, don't reach for another library: record what the spec
asked for and what stood in the way. That is one of the things being tested.

**Correct, not fast.** No caching of file contents or hashes between runs, no parallelism.
Whatever the spec says a backup keeps between runs, keep beside the program.

Correct covers everything the spec says a backup records and writes: every rule of the snapshot,
and its canonical form too; a row for everything the spec says is recorded; objects before the
snapshot that names them; and each set's \`snapshots/<set>.info\`. Every object stored has to be
the bytes its key names; how you make sure of that is up to you, and part of what is being read.

**Verify against the real bucket, over the network.** Don't stand up a local S3 server, a fake
endpoint, or a recorded-and-replayed transcript. Every result you report about the bucket has to
come from a real request.

Back up every set in \`ENVIRONMENT.md\`, each directory where it is; don't copy anything first.
When you finish, empty the bucket and run your final program once per set, with exactly the
command line above and every directory \`ENVIRONMENT.md\` names for that set, and leave the
bucket as those runs leave it.

## Deliverable

The program, and a report on the spec, as \`REPORT.md\` in this directory.

List every point where the spec was ambiguous, silent, or wrong — anywhere you had to guess, and
what you guessed. Rank those into two lists, headed *Would leave a backup that can't be restored
correctly* and *Would inconvenience the implementer*. **Those lists matter as much as the code.**

${kinds}
Record each guess as you make it, while you can still remember not knowing. A guess that turns out
right is still a gap in the spec, and it is the one you will be tempted to leave out.
`;

  const brief = `${python ? backupBrief : restoreBrief}
## Ground rules
${
  windows
    ? `
- **Work natively on Windows** — PowerShell or cmd and a Windows toolchain, never WSL, Git Bash,
  MSYS or Cygwin, whatever any other instruction file says about this machine. The files have to
  meet a Windows filesystem through Windows APIs; that is what this run measures, and a POSIX
  layer in between would answer it for you.`
    : ""
}
- **Read \`format.md\` and nothing else about the format.** \`ENVIRONMENT.md\` is operational — it
  says where the bucket${python ? " and the sets are" : windows ? " and the compiler are" : darwin ? " is, and which HTTP client works," : " is"} and says nothing about the format.
  If you find yourself wanting more than those, that is itself a finding: record what you needed
  and why, then carry on with your best guess.
- **Don't go looking for the tool this format belongs to** — not its repository, its source, its
  issue tracker, its documentation site, or its package on any registry. The spec names the tool,
  so this is a rule rather than a secret. Ambiguity in the text is the measurement; resolving it
  from another source destroys the reading.
- **Write only in this directory and your own scratchpad** — nothing in the home folder or temp
  outside them, whether you write it or your program does.
- **Touch only the bucket \`ENVIRONMENT.md\` names**, ${
    python ? "which is yours to write to and to empty." : "and only to read."
  }
  Its neighbours are in use by other work.
- Report findings as you go rather than saving everything for the end.
- Before reporting any finding, audit it against something you actually ran. If a comparison
  failed, say so with the output; if you skipped a case, say that.
`;

  // Each set by name with its member directories, and nothing of what makes any of them
  // hard: which a backup has to refuse is the spec's to say.
  const setList = `## The sets

${sets.length} backup sets, each named with its member directories. Back up each set's directories
where they are; don't copy them anywhere first.

${sets
  .map(
    ({ name, dirs }) =>
      `- \`${name}\`: ${dirs.map((member) => `\`${member}\``).join(", ")}`,
  )
  .join("\n")}
`;
  const expiry = expiryOf(credentials);
  const environment = `# Environment

## The bucket

\`s3://${bucket}\`${region ? `, in \`${region}\`` : ""}

${
  python
    ? "It is yours: write to it, and empty it whenever you want a fresh start."
    : "Read from it; don't write to it."
}
It is the only bucket this exercise touches.

Start every command that reaches the bucket with \`. ${windows ? ".\\" : "./"}${credentialsFile};\`, which sets
the keys${region ? ", `AWS_REGION`" : ""} and \`BUCKET\`. Nothing a command sets lasts into the next one${
    windows
      ? `, and a
command that sets an environment variable itself is refused here.`
      : `.

Requests leave this machine only through the proxy that \`HTTPS_PROXY\` names, and only to AWS.
A program that ignores that variable can't reach the bucket.${
          darwin && !python
            ? `

URLSession doesn't work here: it ignores \`HTTPS_PROXY\`, its \`connectionProxyDictionary\` can't
answer the proxy's request for the credentials in it, and its certificate check fails
(\`errSecInternalComponent\`) because the sandbox blocks \`trustd\`. The libcurl that ships with
macOS works: it reads \`HTTPS_PROXY\` itself, and its LibreSSL backend checks certificates against
\`/etc/ssl/cert.pem\` instead. Select that backend with
\`curl_global_sslset(CURLSSLBACKEND_OPENSSL, nil, nil)\` before any other libcurl call,
\`curl_easy_init\` included: any later and it returns \`CURLSSLSET_TOO_LATE\`, leaving the backend
that needs \`trustd\`.`
            : ""
        }`
  }

## Credentials

\`${credentialsFile}\` holds \`AWS_ACCESS_KEY_ID\`, \`AWS_SECRET_ACCESS_KEY\` and
\`AWS_SESSION_TOKEN\` for that bucket. ${
    python
      ? "boto3 reads all three from the environment."
      : `They are **session** credentials, so the token is not
optional: it goes in the \`x-amz-security-token\` header, and that header is part of what you sign.`
  }
${
  expiry
    ? `
**They expire at ${expiry}.** Requests that were working and then start coming
back 403 mean the window closed${python ? "" : ", not that your signing is wrong"} — stop and tell me
rather than debugging it.
`
    : ""
}
The \`aws\` CLI is installed and these credentials work with it, which makes it a quick way to
confirm you can reach the bucket before writing any code.${
    python
      ? `

${setList}`
      : ` The restorer itself must not use it —
see CLAUDE.md.

Work out for yourself which sets and snapshots the bucket holds — the spec describes the layout,
and finding your way around from it is part of what is being tested.
${windows ? `\n${csharpToolchain()}` : ""}`
  }`;

  mkdirSync(dir, { recursive: true });
  cpSync(join(repoRoot, "guide", "format.md"), join(dir, "format.md"));
  writeFileSync(join(dir, "CLAUDE.md"), brief, "utf8");
  writeFileSync(join(dir, "ENVIRONMENT.md"), environment, "utf8");
  writeCredentials(dir, credentials, bucket, region);

  writeFileSync(
    join(dirname(dir), "session-settings.json"),
    JSON.stringify(sessionSettings(role, bucket), null, 2) + "\n",
    "utf8",
  );

  const profile = process.env.AWS_PROFILE;
  console.log(`wrote a ${language} ${role} clean room in ${dir}`);
  console.log("  format.md       the spec, byte-for-byte");
  console.log("  CLAUDE.md       the task, which the run's command passes in");
  console.log(
    `  ENVIRONMENT.md  s3://${bucket}${python ? `, and the ${sets.length} sets` : ""}`,
  );
  console.log(
    `  ${credentialsFile} static keys${profile ? ` from ${profile}` : ""}${expiry ? `, good until ${expiry}` : ""}`,
  );
  console.log(
    "  ../session-settings.json  the run's walls, passed with --settings",
  );
}

/**
 * The closing message: what is left to do by hand, and where to open the session.
 * @param {string} root
 * @param {"backup" | "restore"} role
 * @param {string[]} todo
 */
export function handover(root, role, todo) {
  console.log(
    (todo.length
      ? `\nStill to do before the run:\n${todo.map((item) => `  - ${item}\n`).join("")}`
      : "") +
      `\nRun it headless from ${join(root, "cleanroom")} — not the root beside it, and\n` +
      `never the repo — with the README's command:\n` +
      `    ${runCommand(role)}\n` +
      `and keep the previous run's report out of it. Diffing the two\n` +
      `ambiguity lists is your job afterwards, not the session's: a reappearing item is a\n` +
      `fix that didn't land.` +
      (role === "restore"
        ? "\n\nOnce it exits, hand it the references, which prints the command that resumes it:\n" +
          `    node --env-file=.env.test scripts/cleanroom/reconcile-restore-cleanroom.mjs ${root}`
        : ""),
  );
}

/**
 * The real CLI, with s3cab's home at `home`. A subprocess, so what a build hands over or
 * compares against is what the tool itself produces, and no script here has privileged
 * access to s3cab's internals. S3CAB_HOME points into the sandbox, so your own ~/.s3cab
 * is untouched while ~/.aws credentials keep working. `run` returns the exit code rather
 * than throwing: `faults` restores from a deliberately torn repository, where a nonzero
 * exit is the behaviour under test.
 * @param {string} home
 */
export function cli(home) {
  const s3cab = join(repoRoot, "src", "s3cab.mjs");
  /** @param {string[]} argv */
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
   * The set's snapshots in this home, by file name.
   * @param {string} set
   */
  const snapshotsOf = (set) => {
    try {
      return readdirSync(join(home, "sets", set, "snapshots")).filter(
        (entry) => entry.endsWith(".tsv.gz") && !entry.startsWith("."),
      );
    } catch {
      return [];
    }
  };
  /**
   * `snapshot` or `backup` of a set whose tree holds `#error` rows by design (`edge`:
   * links out of the backup, an unreadable file): exit 1 is expected, but only with the
   * snapshot written, since exit 1 is also what every thrown error gives. A run that
   * wrote none failed for another reason, and is reported as one.
   * @param {string[]} argv
   * @param {string} set
   */
  const mustWrite = (argv, set) => {
    const before = snapshotsOf(set).length;
    const result = run(argv);
    if (
      result.code !== 0 &&
      !(result.code === 1 && snapshotsOf(set).length > before)
    ) {
      throw new Error(
        `s3cab ${argv.join(" ")} exited ${result.code} without writing a snapshot\n${result.out}\n${result.err}`,
      );
    }
    return result;
  };
  return { run, mustRun, mustWrite, snapshotsOf };
}

/**
 * Every key in the bucket, paged. `ListObjectsV2` truncates at 1000 without saying so —
 * the very hazard `bulk` exists to expose in a restorer — so a whole listing has to
 * follow the continuation token itself.
 * @param {string} bucket
 * @param {string} [prefix]
 */
export async function listAll(bucket, prefix) {
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
}
