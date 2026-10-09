/**
 * What the clean-room scripts share (ADR-0096): reading the one root each takes,
 * writing the clean room inside it — a copy of the spec, a brief naming the language,
 * the bucket and its credentials where the role has one, and nothing else — and driving
 * the real CLI for the builds that need s3cab's own output.
 *
 * A sandbox root holds `cleanroom/`, where the session is opened, beside what the build
 * needs and the session must not see (`fixtures/`, the trees a snapshot or upload build
 * backs up, and `.s3cab/`, s3cab's home while a build runs it). It is built once, from
 * empty, and deleted when the run is harvested.
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
 * There are three roles, one per pillar of the format: snapshot, upload, restore. The
 * role fixes the language: the two halves of the backup are Python on every platform, a
 * restorer is its platform's canonical one (C# on Windows, Swift on macOS, C on Linux; see
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
 * ENVIRONMENT.md names ONE bucket, or none for the snapshot room. Copying .env.test across would be handier and is
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
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

const repoRoot = realpathSync.native(join(import.meta.dirname, "..", ".."));
const windows = process.platform === "win32";
const credentialsFile = windows ? "credentials.ps1" : "credentials.env";

/**
 * A sandbox root as typed, made absolute. A leading `~` is expanded here: every usage
 * line writes one and PowerShell does not expand it, so node would take it literally and
 * `resolve` would make a directory named `~` under the cwd — which is the repo, the one
 * place a sandbox must never be, reported as a path the operator never typed.
 * @param {string} arg
 */
export function sandboxPath(arg) {
  return resolve(
    arg === "~" || arg.startsWith("~/") || arg.startsWith("~\\")
      ? join(homedir(), arg.slice(1))
      : arg,
  );
}

/**
 * Read `<root>`, or exit 2 saying what was wrong. The root has to be outside the repo,
 * and empty. On its own, for the one build that never leaves the machine (the snapshot
 * room has no bucket); every other script reads its bucket too, with
 * {@link readCommandLine}.
 * @param {string} script this script's file name, for the usage line
 * @param {boolean} [env] whether the script runs with `--env-file=.env.test`, for the
 *   usage line
 */
export function readRoot(script, env = false) {
  const command = `node${env ? " --env-file=.env.test" : ""} scripts/cleanroom/${script}`;
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

  return root;
}

/**
 * Read `<root>` and the bucket, or exit 2 saying what was wrong.
 * @param {string} script this script's file name, for the usage line
 * @param {string} variable the environment variable naming its bucket
 */
export function readCommandLine(script, variable) {
  const root = readRoot(script, true);
  const bucket = process.env[variable];
  if (!bucket) {
    console.error(
      `No clean-room bucket is set (${variable}). Run with the test\n` +
        "environment, which names it:\n" +
        "\n" +
        `    node --env-file=.env.test scripts/cleanroom/${script} ${root}\n`,
    );
    return process.exit(2);
  }
  return { root, bucket };
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
 * Write the clean room: the spec, the brief, ENVIRONMENT.md and, for a role that has a
 * bucket, its credentials. The snapshot room has none: it never leaves the machine.
 * @param {string} dir
 * @param {"snapshot" | "upload" | "restore"} role
 * @param {string} [bucket]
 * @param {{ accessKeyId: string, secretAccessKey: string, sessionToken?: string, expiration?: Date }} [credentials]
 */
export function writeCleanroom(dir, role, bucket, credentials) {
  const python = role !== "restore";
  const language = python
    ? "Python"
    : windows
      ? "C#"
      : process.platform === "darwin"
        ? "Swift"
        : "C";
  // The exclude grammar decides what a walk records, so only the snapshot room reads it;
  // the upload room copies a set's exclude.txt verbatim and needs nothing of its syntax.
  const spec =
    role === "snapshot" ? ["format.md", "exclude.md"] : ["format.md"];
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

  // The two halves of the clean-room backup are written in separate rooms, by sessions
  // that never see each other's program: the snapshot file is the interface, and only
  // two readers of the spec, one on each side of it, test that the spec alone defines
  // it. One session writing both could misread a row the same way in each half, and
  // the backup would work while the report stayed silent.
  const snapshotBrief = `# Independent snapshot for the s3cab storage format

\`format.md\` and \`exclude.md\` in this directory are the complete specification you are working
from, and the only source of format knowledge you may use. There is no source tree here and that
is deliberate: this is a clean-room exercise, and the worth of your report depends entirely on
your conclusions coming from the spec and nothing else.

## The task

s3cab's core promise is that its stored format is open enough that you could recover everything
without the tool, or write a replacement in an afternoon. This tests the second half at its first
step: whether a snapshot can be written from the spec alone.

Working only from the spec, write \`s3cab-snapshot.py\`: a Python program that walks a backup set's
member directories and writes the set's snapshot file. Another program, written separately from
the same spec and without sight of yours, uploads what yours writes. The snapshot file is the whole
of your program's output, and the spec is the whole of the contract between the two.

Use Python 3 and its standard library, as installed on this machine, and nothing else. The same
program has to run unchanged on Linux, macOS and Windows. If something the spec asks for can't be
done portably with the standard library, don't reach for another library: record what the spec
asked for and what stood in the way. That is one of the things being tested.

**Correct, not fast.** No caching between runs, no parallelism. The program has a second
audience: someone who can code a little should be able to work out from it, and the upload
program beside it, how the format works in about half an hour. Aim for roughly 250 lines,
comments included, and prefer the plain way of doing anything.

Correct covers everything the spec says a snapshot holds: its exact bytes, padding included;
exclude patterns in their full syntax; and a row for everything the spec says is recorded, what
was left out included.

Nothing here touches the network: there is no bucket, and uploading is the other program's job.
Write each set's snapshot into that set's directory in \`sets/\`, laid out as the spec's local side
describes, and check it by reading it back the way a stranger working from the spec would.

Snapshot every set \`ENVIRONMENT.md\` lists.

## Deliverable

The program, and a report on the spec.

List every point where the spec was ambiguous, silent, or wrong — anywhere you had to guess, and
what you guessed. Rank those by whether a wrong guess would write a snapshot that can't be
restored correctly, or merely inconvenience the implementer. **That list matters as much as the
code.**

Record each guess as you make it, while you can still remember not knowing. A guess that turns out
right is still a gap in the spec, and it is the one you will be tempted to leave out.
`;

  const uploadBrief = `# Independent upload for the s3cab storage format

\`format.md\` in this directory is the complete specification you are working from, and the only
source of format knowledge you may use. There is no source tree here and that is deliberate: this
is a clean-room exercise, and the worth of your report depends entirely on your conclusions coming
from the spec and nothing else.

## The task

s3cab's core promise is that its stored format is open enough that you could recover everything
without the tool, or write a replacement in an afternoon. This tests the second half at its last
step: whether a backup can be put in a bucket from the spec alone, so that any reader of the spec
can restore it.

Working only from the spec, write \`s3cab-upload.py\`: a Python program that takes a set's
snapshot, puts the files it names in the bucket, then the snapshot itself. The snapshots were
written by another program, separately, from the same spec. The spec is the whole of the contract
between the two, so read what you are handed as the spec describes it, not as the files you were
given happen to look.

Use Python 3 with its standard library and boto3, as installed on this machine, and nothing else.
The same program has to run unchanged on Linux, macOS and Windows. If something the spec asks for
can't be done portably with those two, don't reach for another library: record what the spec
asked for and what stood in the way. That is one of the things being tested.

**Correct, not fast.** No caching between runs, no parallelism. The program has a second
audience: someone who can code a little should be able to work out from it, and the snapshot
program beside it, how the format works in about half an hour. Aim for roughly 250 lines,
comments included, and prefer the plain way of doing anything.

Correct covers everything the spec says a backup writes to the bucket: objects before the
snapshot that names them, the snapshot itself, and every file the bucket layout documents, each
set's own entry included. Every object stored has to be the bytes its key names; how you make
sure of that is up to you, and part of what is being read.

**Verify against the real bucket, over the network.** Don't stand up a local S3 server, a fake
endpoint, or a recorded-and-replayed transcript. Every result you report about the bucket has to
come from a real request.

Upload every snapshot in \`sets/\`.

## Deliverable

The program, and a report on the spec.

List every point where the spec was ambiguous, silent, or wrong — anywhere you had to guess, and
what you guessed. Rank those by whether a wrong guess would leave a backup that can't be restored
correctly, or merely inconvenience the implementer. **That list matters as much as the code.**

Record each guess as you make it, while you can still remember not knowing. A guess that turns out
right is still a gap in the spec, and it is the one you will be tempted to leave out.
`;

  const brief = `${{ snapshot: snapshotBrief, upload: uploadBrief, restore: restoreBrief }[role]}
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
- **Read ${spec.map((name) => `\`${name}\``).join(" and ")} and nothing else about the format.**
  \`ENVIRONMENT.md\` is operational — it says where the ${bucket ? "bucket is" : "sets are"} and says nothing about the
  format. If you find yourself wanting more than those, that is itself a finding: record what you
  needed and why, then carry on with your best guess.
- **Don't go looking for the tool this format belongs to** — not its repository, its source, its
  issue tracker, its documentation site, or its package on any registry. The spec names the tool,
  so this is a rule rather than a secret. Ambiguity in the text is the measurement; resolving it
  from another source destroys the reading.${
    bucket
      ? `
- **Touch only the bucket \`ENVIRONMENT.md\` names**, ${
          role === "upload"
            ? "which is yours to write to and to empty."
            : "and only to read."
        }
  Its neighbours are in use by other work.`
      : ""
  }
- Report findings as you go rather than saving everything for the end.
- Before reporting any finding, audit it against something you actually ran. If a comparison
  failed, say so with the output; if you skipped a case, say that.
`;

  const sets =
    role === "snapshot"
      ? `## The sets

\`sets/\` holds one directory per backup set, named for the set: \`dirs.txt\` lists its member
directories, and \`exclude.txt\`, where there is one, its exclude patterns. Snapshot each set's
directories where they are; don't copy them anywhere first.
`
      : `## The sets

\`sets/\` holds one directory per backup set, named for the set: \`dirs.txt\` lists its member
directories, \`exclude.txt\`, where there is one, its exclude patterns, and \`snapshots/\` the
snapshots to upload. The files a snapshot names are where it says they are; read them there.
`;
  const expiry = credentials?.expiration
    ?.toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  const environment = bucket
    ? `# Environment

## The bucket

\`s3://${bucket}\`${region ? `, in \`${region}\`` : ""}

${
  role === "upload"
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

${sets}`
          : ` The restorer itself must not use it —
see CLAUDE.md.

## The reference restores

\`reference/\` holds one directory per snapshot, restored by the tool itself, named for the set and
snapshot it came from. Those are what you compare against, byte-for-byte, including paths and
modification times.

Work out for yourself which sets and snapshots the bucket holds — the spec describes the layout,
and finding your way around from it is part of what is being tested.
`
      }`
    : `# Environment

There is no bucket and no network in this exercise.

${sets}`;

  mkdirSync(dir, { recursive: true });
  for (const name of spec) {
    cpSync(join(repoRoot, "guide", name), join(dir, name));
  }
  writeFileSync(join(dir, "CLAUDE.md"), brief, "utf8");
  writeFileSync(join(dir, "ENVIRONMENT.md"), environment, "utf8");
  if (bucket && credentials) {
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
  }

  const profile = process.env.AWS_PROFILE;
  console.log(`wrote a ${language} ${role} clean room in ${dir}`);
  console.log("  format.md       the spec, byte-for-byte");
  if (spec.includes("exclude.md")) {
    console.log("  exclude.md      the exclude-pattern spec, byte-for-byte");
  }
  console.log(
    "  CLAUDE.md       the task, auto-loaded so a bare 'go' starts it",
  );
  console.log(
    `  ENVIRONMENT.md  ${bucket ? `s3://${bucket}` : "the sets, and no bucket"}`,
  );
  if (bucket) {
    console.log(
      `  ${credentialsFile} static keys${profile ? ` from ${profile}` : ""}${expiry ? `, good until ${expiry}` : ""}`,
    );
  }
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
      `\nOpen the session in ${join(root, "cleanroom")} — not in the root beside it, and never\n` +
      `in the repo — and keep the previous run's report out of it. Diffing the two\n` +
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
  return { run, mustRun };
}
