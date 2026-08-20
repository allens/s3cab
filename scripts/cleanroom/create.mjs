/**
 * Stage a clean-room directory for an independent restorer: a copy of the format
 * spec, a brief naming the language, and nothing else.
 *
 * The clean-room premise is that every conclusion the implementer reaches came from
 * guide/format.md. Telling a session not to read the rest of the repo does not secure
 * that, because a session opened inside the repo is handed CLAUDE.md before it reads
 * anything — and CLAUDE.md discusses the #SNAPSHOT header's UTC instant, the #DIR
 * headers, the drive-letter normalisation and (via ADR-0004's filename) the TSV
 * encoding. Those are restore-correctness facts the reading is supposed to have to
 * derive, and a contaminated run fails silently: the ambiguity list comes back
 * shorter, which reads as "the spec is fixed". So the firewall is physical — an empty
 * directory outside the repo, holding the spec alone.
 *
 * The brief is written as the clean room's own CLAUDE.md for two reasons. It is
 * auto-loaded, so the run starts from a bare "go" rather than a pasted wall of text;
 * and it is re-injected as the context compacts, so the one rule that matters — read
 * nothing else about the format — survives a run long enough to write a program,
 * where a rule given once in the opening turn would scroll away.
 *
 * The language is a parameter because what makes a run worth repeating is a fresh
 * reader, not a new language, and the brief is language-neutral apart from one
 * sentence. That sentence names no version and no toolchain: "the most modern version
 * that comes as standard on the platform you are running on" is discovered on the
 * machine, where a version pinned in prose would rot the way a line number does.
 *
 * ENVIRONMENT.md names ONE bucket. Copying .env.test across would be handier and is
 * the wrong shape: it also names the crash and conformance buckets, whose suites
 * assert whole-bucket state (so a visitor breaks them) and which hold deliberately
 * torn repositories — snapshots published over swept objects, written on purpose by
 * test/crash. That is the exact signature of the finding this exercise hunts, so a
 * session that wandered into one would report a real observation as a spec defect.
 *
 * Usage:
 *   node scripts/cleanroom/create.mjs --lang <language> [--bucket <name>] [--force] <dir>
 *   node --env-file=.env.test scripts/cleanroom/create.mjs --lang "C++" ~/src/cleanroom
 *
 * Reads AWS_REGION / AWS_PROFILE / S3CAB_TEST_BUCKET from the environment, so
 * --env-file=.env.test supplies them without the file itself travelling.
 *
 * Credentials go in as static keys in credentials.env, not as AWS_PROFILE: the brief
 * forbids an AWS SDK, and a profile name is only meaningful to one. Re-run the script
 * (--force) to refresh them — resolving through the chain mints a fresh window, so a
 * run that outlives the permission set's session duration is a re-run away from
 * carrying on rather than a lost afternoon.
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

const args = process.argv.slice(2);
const valueOf = (/** @type {string} */ flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const valueIndices = new Set(
  ["--lang", "--bucket"]
    .map((flag) => args.indexOf(flag))
    .filter((index) => index !== -1)
    .map((index) => index + 1),
);
const language = valueOf("--lang");
const bucket = valueOf("--bucket") ?? process.env.S3CAB_TEST_BUCKET;
const force = args.includes("--force");
const unknown = args.find(
  (arg, index) =>
    arg.startsWith("-") &&
    !["--lang", "--bucket", "--force"].includes(arg) &&
    !valueIndices.has(index),
);
const positionals = args.filter(
  (arg, index) => !arg.startsWith("-") && !valueIndices.has(index),
);
const [dir] = positionals;
if (unknown !== undefined || positionals.length !== 1 || !language || !dir) {
  console.error(
    "usage: node scripts/cleanroom/create.mjs --lang <language> [--bucket <name>] [--force] <dir>\n" +
      '\ne.g. node --env-file=.env.test scripts/cleanroom/create.mjs --lang "C++" ~/src/cleanroom',
  );
  process.exit(2);
}

const repoRoot = realpathSync.native(join(import.meta.dirname, "..", ".."));
const target = resolve(dir);

// The one guard that matters: a clean room inside the repo is not a clean room, since
// the session would inherit the repo's CLAUDE.md from a parent directory. Compared
// case-blind because Windows spells the same directory several ways; on a
// case-sensitive filesystem that can only over-refuse, the safe direction here.
const contains = (/** @type {string} */ root, /** @type {string} */ path) => {
  const [lowerRoot, lowerPath] = [root.toLowerCase(), path.toLowerCase()];
  return lowerPath === lowerRoot || lowerPath.startsWith(lowerRoot + sep);
};
if (contains(repoRoot, target)) {
  console.error(
    `${target} is inside the repository, so a session opened there would be handed\n` +
      "CLAUDE.md and the rest of the source — which is the one thing a clean room\n" +
      "has to prevent. Stage it somewhere outside the repo instead:\n" +
      "\n" +
      `    node scripts/cleanroom/create.mjs --lang "${language}" ~/src/cleanroom\n`,
  );
  process.exit(2);
}

if (existsSync(target) && readdirSync(target).length > 0 && !force) {
  console.error(
    `${target} already has files in it, and a clean room is only meaningful when the\n` +
      "spec is the only thing in reach. Pick an empty directory, or overwrite this one:\n" +
      "\n" +
      `    node scripts/cleanroom/create.mjs --lang "${language}" --force ${dir}\n`,
  );
  process.exit(2);
}

const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
const profile = process.env.AWS_PROFILE;

// Resolved before anything is written, so a lapsed SSO session fails with one clear
// message instead of leaving a half-staged room behind. Static credentials rather than
// a profile name because the brief forbids an AWS SDK, and a profile is only meaningful
// to one: without an SDK to read ~/.aws/config there is nothing on the far side of
// AWS_PROFILE. Resolving through the chain also mints a fresh window — these are SSO
// session credentials, so the run gets the permission set's full session duration
// rather than whatever was left of the last one.
const credentials = bucket
  ? await new S3Client({}).config.credentials().catch((error) => {
      console.error(
        `couldn't resolve AWS credentials for ${bucket}, and the clean room needs them\n` +
          "as static keys — the restorer has no SDK to resolve a profile with. If the\n" +
          "SSO session has lapsed:\n" +
          "\n" +
          `    aws sso login${profile ? ` --profile ${profile}` : ""}\n` +
          "\n" +
          `(${error instanceof Error ? error.message : error})`,
      );
      return process.exit(2);
    })
  : undefined;

const brief = `# Independent restorer for the s3cab storage format

\`format.md\` in this directory is the complete specification you are working from, and the only
source of format knowledge you may use. There is no source tree here and that is deliberate: this
is a clean-room exercise, and the worth of your report depends entirely on your conclusions coming
from the spec and nothing else.

## The task

s3cab's core promise is that its stored format is open enough that you could recover everything
without the tool, or write a replacement in an afternoon. The spec has been revised since that
claim was last tested, and I want it tested again by a fresh reader.

Working only from the spec, implement a minimal independent restorer in ${language}. Use the most
modern version of the language that comes as standard on the platform you are running on, and take
your libraries from what that platform packages. Don't build a compiler or a runtime from source,
and don't spend the run fighting a toolchain — if something you want isn't packaged, pick something
else.

**No AWS SDK, and no S3 client library, packaged or not.** Talk to S3 over plain HTTPS with a
general-purpose HTTP client and sign the requests yourself; hashing and decompression come from the
platform's own packages. That is the second thing being tested, so it is worth saying why: the tool
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

## Ground rules

- **Read \`format.md\` and nothing else about the format.** \`ENVIRONMENT.md\` is operational — it
  says where the bucket is and says nothing about the format. If you find yourself wanting more
  than those two, that is itself a finding: record what you needed and why, then carry on with your
  best guess.
- **Don't go looking for the tool this format belongs to** — not its repository, its source, its
  issue tracker, its documentation site, or its package on any registry. The spec names the tool,
  so this is a rule rather than a secret. Ambiguity in the text is the measurement; resolving it
  from another source destroys the reading.
- **Touch only the bucket \`ENVIRONMENT.md\` names**, and only to read. Its neighbours are in use
  by other work.
- Report findings as you go rather than saving everything for the end.
- Before reporting any finding, audit it against something you actually ran. If a comparison
  failed, say so with the output; if you skipped a case, say that.
`;

const expiry = credentials?.expiration?.toISOString().replace(/\.\d{3}Z$/, "Z");
const environment = `# Environment

## The bucket

\`s3://${bucket}\`${region ? `, in \`${region}\`` : ""}

Read from it; don't write to it. It is the only bucket this exercise touches.

\`\`\`sh
. ./credentials.env
${region ? `export AWS_REGION=${region}\n` : ""}export BUCKET=${bucket}
\`\`\`

## Credentials

\`credentials.env\` holds \`AWS_ACCESS_KEY_ID\`, \`AWS_SECRET_ACCESS_KEY\` and
\`AWS_SESSION_TOKEN\` for that bucket. They are **session** credentials, so the token is not
optional: it goes in the \`x-amz-security-token\` header, and that header is part of what you sign.
${
  expiry
    ? `
**They expire at ${expiry}.** Requests that were working and then start coming
back 403 mean the window closed, not that your signing is wrong — ask me to refresh the file
rather than debugging it.
`
    : ""
}
The \`aws\` CLI is installed and these credentials work with it, which makes it a quick way to
confirm you can reach the bucket before writing any code. The restorer itself must not use it —
see CLAUDE.md.

## The reference restores

\`reference/\` holds one directory per snapshot, restored by the tool itself, named for the set and
snapshot it came from. Those are what you compare against, byte-for-byte, including paths and
modification times.

Work out for yourself which sets and snapshots the bucket holds — the spec describes the layout,
and finding your way around from it is part of what is being tested.
`;

mkdirSync(target, { recursive: true });
cpSync(join(repoRoot, "guide", "format.md"), join(target, "format.md"));
writeFileSync(join(target, "CLAUDE.md"), brief, "utf8");
const written = ["format.md", "CLAUDE.md"];
if (bucket && credentials) {
  writeFileSync(join(target, "ENVIRONMENT.md"), environment, "utf8");
  // Separate from ENVIRONMENT.md so the secret sits in one obviously-disposable file
  // rather than inside prose the session may quote back into a report — and so it can
  // be rewritten on its own when the window closes mid-run. Single-quoted because a
  // session token is base64 and a shell would otherwise be free to read it.
  writeFileSync(
    join(target, "credentials.env"),
    [
      `export AWS_ACCESS_KEY_ID='${credentials.accessKeyId}'`,
      `export AWS_SECRET_ACCESS_KEY='${credentials.secretAccessKey}'`,
      ...(credentials.sessionToken
        ? [`export AWS_SESSION_TOKEN='${credentials.sessionToken}'`]
        : []),
      "",
    ].join("\n"),
    "utf8",
  );
  written.push("ENVIRONMENT.md", "credentials.env");
}

// --force overwrites what this script writes and leaves everything else, which in a
// clean room is the wrong kind of quiet: a renamed or moved directory can carry an
// older brief in beside the new one, and the session would read both. Don't delete
// anyone's files — just refuse to be silent about them.
const strays = readdirSync(target).filter(
  (entry) => !written.includes(entry) && entry !== "reference",
);

console.log(`staged a ${language} clean room in ${target}`);
console.log("  format.md       the spec, byte-for-byte");
console.log("  CLAUDE.md       the task, auto-loaded so a bare 'go' starts it");
if (bucket) {
  console.log(`  ENVIRONMENT.md  s3://${bucket}`);
  console.log(
    `  credentials.env static keys${profile ? ` from ${profile}` : ""}${expiry ? `, good until ${expiry}` : ""}`,
  );
} else {
  console.log(
    "  (no ENVIRONMENT.md — pass --bucket, or run with --env-file=.env.test)",
  );
}
if (strays.length > 0) {
  console.log(
    `\n! ${target} also holds ${strays.join(", ")}, which this script did not write.\n` +
      "  A clean room is only meaningful when the spec is the only thing in reach —\n" +
      "  and an older brief left beside the new one gets read as readily as it does.\n" +
      "  Delete anything stale before the run.",
  );
}

console.log(
  `\nStill to do before the run:\n` +
    `  - stage the fixture repositories in the bucket, and restore each one into\n` +
    `    ${join(target, "reference")} with the tool itself. Don't let the session run\n` +
    `    s3cab for its own comparison: the npm package ships source (ADR-0017), so\n` +
    `    installing it would put src/ in reach.\n` +
    `  - raise the bucket's expiry past the run: scripts/setup-test-bucket.mjs --days\n` +
    `\nOpen the session in that directory — never in the repo — and keep the previous\n` +
    `run's report out of it. Diffing the two ambiguity lists is your job afterwards,\n` +
    `not the session's: a reappearing item is a fix that didn't land.`,
);
