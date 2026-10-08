/**
 * What both sandbox builds share (ADR-0096): reading the one root they take, and writing
 * the clean room inside it — a copy of the spec, a brief naming the language, the bucket
 * and its credentials, and nothing else.
 *
 * A sandbox root holds `cleanroom/`, where the session is opened, beside what the build
 * needs and the session must not see (`fixtures/`, and a restore build's `.s3cab/`). It
 * is built once, from empty, and deleted when the run is harvested; the bucket is shared,
 * so sandboxes take turns rather than coexist.
 *
 * The clean-room premise is that every conclusion the implementer reaches came from
 * guide/format.md. Telling a session not to read the rest of the repo does not secure
 * that, because a session opened inside the repo is handed CLAUDE.md before it reads
 * anything — and CLAUDE.md discusses the #SNAPSHOT header's UTC instant, the #DIR
 * headers, the drive-letter normalisation and (via ADR-0004's filename) the TSV
 * encoding. Those are restore-correctness facts the reading is supposed to have to
 * derive, and a contaminated run fails silently: the ambiguity list comes back
 * shorter, which reads as "the spec is fixed". So the firewall is physical — a
 * directory outside the repo, holding the spec alone.
 *
 * The brief is written as the clean room's own CLAUDE.md for two reasons. It is
 * auto-loaded, so the run starts from a bare "go" rather than a pasted wall of text;
 * and it is re-injected as the context compacts, so the one rule that matters — read
 * nothing else about the format — survives a run long enough to write a program,
 * where a rule given once in the opening turn would scroll away.
 *
 * The role fixes the language: the backup is Python on every platform, a restorer is
 * its platform's canonical one (C# on Windows, Swift on macOS, C on Linux; see
 * README.md), so runs differ by reader and by spec version. The restorer brief is
 * language-neutral apart from one sentence. That sentence names no version and no
 * toolchain: "the most modern version that comes as standard on the platform you are
 * running on" is discovered on the machine, where a version pinned in prose would
 * rot the way a line number does.
 *
 * A clean room built on Windows gets a Windows brief, because the platform is then the
 * thing under test. Nothing comes as standard there and there is no package archive, so
 * the sentence becomes "installed on this machine, standard library only" — install the
 * toolchain before the run. The brief also pins the session to native Windows: a
 * user-level CLAUDE.md is loaded into every session, and one that routes Windows work
 * through WSL would quietly turn a Windows run into a Linux one. The credentials are
 * written as PowerShell for the same reason — a `.env` of `export` lines invites a shell
 * that isn't Windows.
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
import { S3Client } from "@aws-sdk/client-s3";
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
import { parseArgs } from "node:util";

/** @import { ParseArgsConfig } from "node:util" */

const repoRoot = realpathSync.native(join(import.meta.dirname, "..", ".."));
const windows = process.platform === "win32";
const credentialsFile = windows ? "credentials.ps1" : "credentials.env";

/**
 * Read `[--flag…] <root>` and the bucket, or exit 2 saying what was wrong. The root
 * has to be outside the repo, and empty.
 * @param {string} script this script's file name, for the usage line
 * @param {string[]} [flags] the boolean flags it takes, without their dashes
 */
export function readCommandLine(script, flags = []) {
  const command = `node --env-file=.env.test scripts/cleanroom/${script}`;
  const usage =
    `usage: ${command} ${flags.map((flag) => `[--${flag}] `).join("")}<root>\n` +
    `\ne.g. ${command} ~/s3cab.sandbox`;
  /** @type {ParseArgsConfig["options"]} */
  const options = Object.fromEntries(
    flags.map((flag) => [flag, { type: "boolean" }]),
  );
  /** @type {ReturnType<typeof parseArgs>} */
  let parsed;
  try {
    parsed = parseArgs({ options, allowPositionals: true });
  } catch {
    console.error(usage);
    return process.exit(2);
  }
  const [arg] = parsed.positionals;
  if (parsed.positionals.length !== 1 || !arg) {
    console.error(usage);
    return process.exit(2);
  }

  const bucket = process.env.S3CAB_TEST_BUCKET_CLEANROOM;
  if (!bucket) {
    console.error(
      "No clean-room bucket is set (S3CAB_TEST_BUCKET_CLEANROOM). Run with the test\n" +
        "environment, which names it:\n" +
        "\n" +
        `    ${command} ${arg}\n`,
    );
    return process.exit(2);
  }

  // Expand a leading `~` before resolving. The usage line writes one and PowerShell
  // does not expand it, so node would take it literally and `resolve` would make a
  // directory named `~` under the cwd — which is the repo, and so exactly the placement
  // the guard below exists to refuse, reported as a path the operator never typed.
  const root = resolve(
    arg === "~" || arg.startsWith("~/") || arg.startsWith("~\\")
      ? join(homedir(), arg.slice(1))
      : arg,
  );

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

  return { root, bucket, values: parsed.values };
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
  return await new S3Client({}).config.credentials().catch((error) => {
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
 * Write the clean room: the spec, the brief, ENVIRONMENT.md and the credentials.
 * @param {string} dir
 * @param {"backup" | "restore"} role
 * @param {string} bucket
 * @param {{ accessKeyId: string, secretAccessKey: string, sessionToken?: string, expiration?: Date }} credentials
 */
export function writeCleanroom(dir, role, bucket, credentials) {
  const backup = role === "backup";
  const language = backup
    ? "Python"
    : windows
      ? "C#"
      : process.platform === "darwin"
        ? "Swift"
        : "C";
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;

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
      ? `Use the most
modern version of the language installed on this machine, and nothing beyond its standard library
— Windows has no package archive to take libraries from. Don't install another toolchain, and don't
spend the run fighting this one — if something you want isn't in the standard library, pick
something else.`
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

Record each guess as you make it, while you can still remember not knowing. A guess that turns out
right is still a gap in the spec, and it is the one you will be tempted to leave out.
`;

  const backupBrief = `# Independent backup for the s3cab storage format

\`format.md\` and \`exclude.md\` in this directory are the complete specification you are working
from, and the only source of format knowledge you may use. There is no source tree here and that
is deliberate: this is a clean-room exercise, and the worth of your report depends entirely on
your conclusions coming from the spec and nothing else.

## The task

s3cab's core promise is that its stored format is open enough that you could recover everything
without the tool, or write a replacement in an afternoon. This tests the second half: whether a
backup can be written from the spec alone.

Working only from the spec, write a minimal independent backup in Python, as two programs:

- \`s3cab-snapshot.py\` walks a backup set's directories and writes its snapshot file;
- \`s3cab-upload.py\` puts that snapshot's objects in the bucket, then the snapshot itself.

The snapshot file is all that passes from one to the other.

Use Python 3 with its standard library and boto3, as installed on this machine, and nothing else.
The same programs have to run unchanged on Linux, macOS and Windows. If something the spec asks
for can't be done portably with those two, don't reach for another library: record what the spec
asked for and what stood in the way. That is one of the things being tested.

**Correct, not fast.** No caching between runs, no parallelism. The programs have a second
audience: someone who can code a little should be able to work out from them how the format works
in about half an hour. Aim for roughly 500 lines between the two, comments included, and prefer
the plain way of doing anything.

Correct covers everything the spec says a backup writes: the snapshot in its exact format, exclude
patterns in their full syntax, objects before the snapshot that names them, and every file the
bucket layout documents, each set's own entry included. Every object stored has to be the bytes
its key names; how you make sure of that is up to you, and part of what is being read.

**Verify against the real bucket, over the network.** Don't stand up a local S3 server, a fake
endpoint, or a recorded-and-replayed transcript. Every result you report about the bucket has to
come from a real request.

Back up every set \`ENVIRONMENT.md\` lists.

## Deliverable

The two programs, and a report on the spec.

List every point where the spec was ambiguous, silent, or wrong — anywhere you had to guess, and
what you guessed. Rank those by whether a wrong guess would write a backup that can't be restored
correctly, or merely inconvenience the implementer. **That list matters as much as the code.**

Record each guess as you make it, while you can still remember not knowing. A guess that turns out
right is still a gap in the spec, and it is the one you will be tempted to leave out.
`;

  const brief = `${backup ? backupBrief : restoreBrief}
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
- **Read ${backup ? "`format.md` and `exclude.md`" : "`format.md`"} and nothing else about the format.**
  \`ENVIRONMENT.md\` is operational — it says where the bucket is and says nothing about the
  format. If you find yourself wanting more than those, that is itself a finding: record what you
  needed and why, then carry on with your best guess.
- **Don't go looking for the tool this format belongs to** — not its repository, its source, its
  issue tracker, its documentation site, or its package on any registry. The spec names the tool,
  so this is a rule rather than a secret. Ambiguity in the text is the measurement; resolving it
  from another source destroys the reading.
- **Touch only the bucket \`ENVIRONMENT.md\` names**, ${
    backup ? "which is yours to write to and to empty." : "and only to read."
  }
  Its neighbours are in use by other work.
- Report findings as you go rather than saving everything for the end.
- Before reporting any finding, audit it against something you actually ran. If a comparison
  failed, say so with the output; if you skipped a case, say that.
`;

  const expiry = credentials.expiration
    ?.toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  const environment = `# Environment

## The bucket

\`s3://${bucket}\`${region ? `, in \`${region}\`` : ""}

${
  backup
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
    backup
      ? "boto3 reads all three from the environment."
      : `They are **session** credentials, so the token is not
optional: it goes in the \`x-amz-security-token\` header, and that header is part of what you sign.`
  }
${
  expiry
    ? `
**They expire at ${expiry}.** Requests that were working and then start coming
back 403 mean the window closed${backup ? "" : ", not that your signing is wrong"} — stop and tell me
rather than debugging it.
`
    : ""
}
The \`aws\` CLI is installed and these credentials work with it, which makes it a quick way to
confirm you can reach the bucket before writing any code.${
    backup
      ? `

## The sets

\`sets/\` holds one directory per backup set, named for the set: \`dirs.txt\` lists its member
directories, and \`exclude.txt\`, where there is one, its exclude patterns. Back up each set's
directories where they are; don't copy them anywhere first.
`
      : ` The restorer itself must not use it —
see CLAUDE.md.

## The reference restores

\`reference/\` holds one directory per snapshot, restored by the tool itself, named for the set and
snapshot it came from. Those are what you compare against, byte-for-byte, including paths and
modification times.

Work out for yourself which sets and snapshots the bucket holds — the spec describes the layout,
and finding your way around from it is part of what is being tested.
`
  }`;

  mkdirSync(dir, { recursive: true });
  cpSync(join(repoRoot, "guide", "format.md"), join(dir, "format.md"));
  if (backup) {
    cpSync(join(repoRoot, "guide", "exclude.md"), join(dir, "exclude.md"));
  }
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
  if (backup) {
    console.log("  exclude.md      the exclude-pattern spec, byte-for-byte");
  }
  console.log(
    "  CLAUDE.md       the task, auto-loaded so a bare 'go' starts it",
  );
  console.log(`  ENVIRONMENT.md  s3://${bucket}`);
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
    `\nStill to do before the run:\n` +
      todo.map((item) => `  - ${item}\n`).join("") +
      `  - raise the bucket's expiry past the run: scripts/setup-test-bucket.mjs --days\n` +
      `\nOpen the session in ${join(root, "cleanroom")} — not in the root beside it, and never\n` +
      `in the repo — and keep the previous run's report out of it. Diffing the two\n` +
      `ambiguity lists is your job afterwards, not the session's: a reappearing item is a\n` +
      `fix that didn't land.`,
  );
}
