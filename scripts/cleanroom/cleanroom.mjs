/**
 * What the clean-room scripts share (ADR-0096): reading the one root each takes,
 * writing the clean room inside it — a copy of the spec, a brief naming the language,
 * the bucket and its credentials where the role has one, and nothing else — and driving
 * the real CLI for the builds that need s3cab's own output.
 *
 * A sandbox root holds `cleanroom/`, where the session is opened, beside what the build
 * needs and the session must not see (`fixtures/`, the trees a backup build hands over,
 * and `.s3cab/`, s3cab's home while a restore build runs it). It is built once, from
 * empty, and deleted when the run is harvested.
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
import { join, resolve, sep } from "node:path";
import { homedir } from "node:os";
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
const credentialsFile = windows ? "credentials.ps1" : "credentials.env";

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
 */
function readRoot(script) {
  const command = `node --env-file=.env.test scripts/cleanroom/${script}`;
  const usage = `usage: ${command} <root>\n\ne.g. ${command} ~/s3cab.sandbox`;
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

  // The one guard that matters: a clean room inside the repo is not a clean room, since
  // the session would inherit the repo's CLAUDE.md from a parent directory. Compared
  // case-blind because Windows spells the same directory several ways (`realpathSync`
  // gives `D:\src\s3cab`, `resolve` keeps a typed `d:\src\s3cab`); on a case-sensitive
  // filesystem that can only over-refuse, the safe direction here.
  const [lowerRepo, lowerRoot] = [repoRoot.toLowerCase(), root.toLowerCase()];
  if (lowerRoot === lowerRepo || lowerRoot.startsWith(lowerRepo + sep)) {
    console.error(
      `${root} is inside the repository, so a session opened there would be handed\n` +
        "CLAUDE.md and the rest of the source — which is the one thing a clean room\n" +
        "has to prevent. Build it somewhere outside the repo instead:\n" +
        "\n" +
        `    ${command} ~/s3cab.sandbox\n`,
    );
    return process.exit(2);
  }

  // Built once, from empty: a leftover from the last turn is either an older brief the
  // session would read beside the new one, or s3cab's output in reach.
  if (existsSync(root) && readdirSync(root).length > 0) {
    console.error(
      `${root} already has files in it. A sandbox is built from empty, once per run —\n` +
        "harvest what the last run wrote, delete the directory, and build again.",
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
 */
export function readCommandLine(script, variable) {
  const root = readRoot(script);
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
 * Write the clean room: the spec, the brief, ENVIRONMENT.md and the bucket's credentials.
 * @param {string} dir
 * @param {"backup" | "restore"} role
 * @param {string} bucket
 * @param {{ accessKeyId: string, secretAccessKey: string, sessionToken?: string, expiration?: Date }} credentials
 * @param {{ name: string, dirs: string[] }[]} [sets] for a backup, each set and its member
 *   directories, which ENVIRONMENT.md lists: the room has no set files (ADR-0107)
 */
export function writeCleanroom(dir, role, bucket, credentials, sets = []) {
  const python = role === "backup";
  const language = python
    ? "Python"
    : windows
      ? "C#"
      : process.platform === "darwin"
        ? "Swift"
        : "C";
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;

  const kinds = `The spec sorts what it says into rules, recommendations and hints. A rule that is missing or
unclear is a gap, and goes in that ranked list. A hint that would have saved you time, a trap in
your language or operating system the spec could have warned you about, goes in a separate list
headed *Hints that would have helped*. A guess about a recommendation can't break anything, so it
needn't be reported.
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
      : `Use the most
modern version of the language that comes as standard on the platform you are running on, and take
your libraries from what that platform packages. Don't build a compiler or a runtime from source,
and don't spend the run fighting a toolchain — if something you want isn't packaged, pick something
else.`
  }

**No AWS SDK, and no S3 client library, packaged or not.** Talk to S3 over plain HTTPS with a
general-purpose HTTP client and sign the requests yourself; hashing and decompression come from ${
    windows ? "the\nstandard library" : "the\nplatform's own packages"
  }. That is the second thing being tested, so it is worth saying why: the tool
that writes this format depends on the vendor's SDK completely, and nobody has established what
*reading* it actually needs. A restorer that needs nothing from the vendor is a far stronger claim
than a documented format is.

The restorer has to be a program: it must not invoke the \`aws\` CLI, or any other command-line
tool, to do its work, because a wrapper around someone else's binary would show nothing. Consulting
that CLI while you get request signing right is fine and it is installed — a development aid is not
a dependency — but say in your report whether you needed it, because whether the signing is
derivable from public documentation alone is part of the question.

**Verify against the real bucket, over the network.** Don't stand up a local S3 server, a fake
endpoint, or a recorded-and-replayed transcript. Mocks generally don't check signatures at all, so
one would let a restorer that never signed a correct request in its life report a clean run — and
with no SDK in play, the signing is half of what is being measured. Testing your *parser* against
files on disk is a different thing and is fine. Every result you report has to come from a real
request.

If authenticated requests defeat you altogether, stop and report that rather than spending the run
on it. That answer is a result too.

Given a bucket and a snapshot, reconstruct the files byte-for-byte.

Then verify it differentially, against the bucket and the reference restores described in
\`ENVIRONMENT.md\`. For each snapshot, compare your output against the reference tree
byte-for-byte, including paths and modification times. Investigate every difference: a mismatch is
either a bug in your restorer or a gap in the spec, and which one it is matters more than fixing
it.

## Deliverable

The restorer, and a report on the spec.

List every point where \`format.md\` was ambiguous, silent, or wrong — anywhere you had to guess,
and what you guessed. Rank those by whether a wrong guess would corrupt a restore or merely
inconvenience the implementer. **That list is the real output; the code is the means of finding
it.**

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

The program, and a report on the spec.

List every point where the spec was ambiguous, silent, or wrong — anywhere you had to guess, and
what you guessed. Rank those by whether a wrong guess would leave a backup that can't be restored
correctly, or merely inconvenience the implementer. **That list matters as much as the code.**

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
  says where the bucket${python ? " and the sets are" : windows ? " and the compiler are" : " is"} and says nothing about the format.
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
  const expiry = credentials.expiration
    ?.toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  const environment = `# Environment

## The bucket

\`s3://${bucket}\`${region ? `, in \`${region}\`` : ""}

${
  python
    ? "It is yours: write to it, and empty it whenever you want a fresh start."
    : "Read from it; don't write to it."
}
It is the only bucket this exercise touches.

${
  windows
    ? `\`\`\`powershell
. .\\${credentialsFile}
${region ? `$env:AWS_REGION = '${region}'\n` : ""}$env:BUCKET = '${bucket}'
\`\`\``
    : `\`\`\`sh
. ./${credentialsFile}
${region ? `export AWS_REGION=${region}\n` : ""}export BUCKET=${bucket}
\`\`\``
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

## The reference restores

\`reference/\` holds one directory per snapshot, restored by the tool itself, named for the set and
snapshot it came from. Those are what you compare against, byte-for-byte, including paths and
modification times.

Work out for yourself which sets and snapshots the bucket holds — the spec describes the layout,
and finding your way around from it is part of what is being tested.
${windows ? `\n${csharpToolchain()}` : ""}`
  }`;

  mkdirSync(dir, { recursive: true });
  cpSync(join(repoRoot, "guide", "format.md"), join(dir, "format.md"));
  writeFileSync(join(dir, "CLAUDE.md"), brief, "utf8");
  writeFileSync(join(dir, "ENVIRONMENT.md"), environment, "utf8");
  // Separate from ENVIRONMENT.md so the secret sits in one obviously-disposable file
  // rather than inside prose the session may quote back into a report. Single-quoted
  // because a session token is base64 and a shell would otherwise be free to read it.
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
      "",
    ].join("\n"),
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
}

/**
 * The closing message: what is left to do by hand, and where to open the session.
 * @param {string} root
 * @param {string[]} todo
 */
export function handover(root, todo) {
  console.log(
    (todo.length
      ? `\nStill to do before the run:\n${todo.map((item) => `  - ${item}\n`).join("")}`
      : "") +
      `\nRun it headless from ${join(root, "cleanroom")} — not the root beside it, and\n` +
      `never the repo — with the README's command:\n` +
      `    claude -p --safe-mode --append-system-prompt-file CLAUDE.md --session-id <uuid> \\\n` +
      `      --model <model> --effort <effort> --permission-mode auto --max-budget-usd 15 go\n` +
      `and keep the previous run's report out of it. Diffing the two\n` +
      `ambiguity lists is your job afterwards, not the session's: a reappearing item is a\n` +
      `fix that didn't land.`,
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
