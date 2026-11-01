// The examples in the user docs are what s3cab really accepts and prints.
//
// A doc example is a promise twice over: the command line has to run, and the
// output under it has to be what the reader will see. Neither is checked by
// anything else — a renamed flag leaves every guide that spells the old one
// quietly wrong, and a renderer change leaves every transcript stale.
//
// Three checks, by what each can reach:
//
// - **Every command line**, in README.md, guide/ and the registry's own
//   `examples`, goes through the dispatcher's own `parseArgs` call: the command
//   exists, every flag exists and has its value, and the positionals fit. Not
//   whether a *required* positional is present — the registry can't say
//   "required unless --save" (`aws`), and a prose mention like `s3cab forget`
//   names a command rather than running it.
// - **Exact output** for the transcripts that are local and deterministic: the
//   real CLI, run against snapshots built to the page's own scenario.
// - **The printed result** for the cloud transcripts (verify, restore,
//   extract, and how forget, delete and cleanup end): what the CLI prints for a
//   result built to the page's scenario (the registry's own renderer for the
//   command, or `errorReport` for an error) after the notice every cloud
//   command opens with (`authNotice`). Not a run against a real bucket, which
//   can't reproduce them: verify and cleanup read the whole shared test
//   bucket, the figures are a whole library's, and the restores write to
//   `C:\Users\me`. What drifts is the wording and layout, and that is the
//   renderer's. Each result is typed as its command's own, so `typecheck`
//   catches one that no longer matches.
//
// Every scenario is built from the story (helpers/story.mjs), and a last check
// fails a page that names a set, a bucket, a snapshot or a home folder outside
// it, so a page and its check can't disagree about the world.
//
// Only the transcripts the tests below name are checked; every other one is
// kept right by hand. Two kinds can't be checked this way:
//
// - What forget, delete and cleanup print between the notice and their
//   result: the preview, the prompt, and the lines after the answer (forget's
//   cleanup pointer and record path, delete's record notice). For those only
//   the transcript's last lines are compared (`ending`).
// - README's quick start `setup` and `backup`: `setup --keys` prompts, and
//   prints the starter exclude notice, in an order only a real run would
//   settle; `backup` carries timings.
//
// Cross-cutting, with no module to sit beside, so it lives in test/ (ADR-0049).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, it, mock } from "node:test";
import { parseArgs } from "node:util";
import { commands } from "../src/commands.mjs";
import { errorReport, helpTopics, usage } from "../src/help.mjs";
import { uploadRunningError } from "../src/lib/locks.mjs";
import {
  noBackupsError,
  selectTargets,
  snapshotNotFoundError,
} from "../src/lib/restore.mjs";
import { authNotice } from "../src/lib/s3.mjs";
import {
  backedUp,
  bucket,
  deleted,
  filesAt,
  homeFolders,
  photo,
  scale,
  sets,
  timeline,
  user,
  worlds,
} from "./helpers/story.mjs";
import { writeSnapshot } from "./helpers/write-snapshot.mjs";

/** @import { Command } from "../src/commands.mjs" */
/** @import { CleanupResult } from "../src/commands/cleanup.mjs" */
/** @import { deleteHashes } from "../src/commands/delete.mjs" */
/** @import { extract } from "../src/commands/extract.mjs" */
/** @import { forget } from "../src/commands/forget.mjs" */
/** @import { restore } from "../src/commands/restore.mjs" */
/** @import { cleanup } from "../src/commands/cleanup.mjs" */
/** @import { verify } from "../src/commands/verify.mjs" */
/** @import { VerifyResult } from "../src/commands/verify.mjs" */
/** @import { RestoreResult } from "../src/lib/restore.mjs" */
/** @import { BackupSet } from "../src/lib/sets.mjs" */
/** @import { SetReport } from "../src/lib/verify.mjs" */

// A suggested command inside a message is bold when stderr is a terminal, as
// it can be under `node --test` run by hand. The pages show it plain.
process.env.NO_COLOR = "1";

const PAGES = [
  "README.md",
  ...readdirSync("guide")
    .filter((file) => file.endsWith(".md"))
    .map((file) => join("guide", file)),
];

const FENCE = /^ *```([^\n]*)\n([\s\S]*?)^ *```/gm;
// A fence that holds commands: a `console` transcript (commands follow its
// `> ` prompt, and the output can suggest more, indented on lines of their
// own), or an untagged or shell block of bare commands. `text`, `json`, … hold
// output and data, never commands.
const SHELL = new Set(["", "sh", "bash", "powershell"]);

/**
 * A page's code, never its prose: its fenced blocks and inline spans, and the
 * `s3cab …` command lines among them. Inline code is marked: there a trailing
 * flag can be a mention of the flag rather than half an invocation
 * (`s3cab upload --dir`).
 * @param {string} text
 */
function codeOf(text) {
  const code = [];
  /** @type {{ line: string, inline: boolean }[]} */
  const lines = [];
  for (const [, lang = "", body = ""] of text.matchAll(FENCE)) {
    code.push(body);
    const tag = lang.trim();
    const rows = body.split("\n").filter((row) => row.trim());
    const indent = (/** @type {string} */ row) =>
      row.length - row.trimStart().length;
    // A fence inside a list item is indented as a whole.
    const margin = Math.min(...rows.map(indent));
    for (const row of rows) {
      const line = row.trim();
      const bare = /^s3cab\s/.test(line) ? line : undefined;
      const command =
        tag === "console"
          ? (/^> (s3cab\s.*)/.exec(line)?.[1] ??
            (indent(row) > margin ? bare : undefined))
          : SHELL.has(tag)
            ? bare
            : undefined;
      if (command) {
        lines.push({ line: command, inline: false });
      }
    }
  }
  for (const [, , raw = ""] of text
    .replace(FENCE, "")
    .matchAll(/(`+)([\s\S]*?)\1/g)) {
    const span = raw.replace(/\s+/g, " ");
    code.push(span);
    if (/^s3cab\s/.test(span)) {
      lines.push({ line: span, inline: true });
    }
  }
  return { code: code.join("\n"), lines };
}

/** The registry's own `examples`, each with the command it is under. */
const helpExamples = Object.entries(commands).flatMap(
  ([name, { examples = [] }]) => examples.map((line) => ({ name, line })),
);

/**
 * Every `s3cab …` command line the docs show, with where it came from.
 * @returns {{ where: string, line: string, inline: boolean }[]}
 */
const documentedCommands = () => [
  ...PAGES.flatMap((page) =>
    codeOf(readFileSync(page, "utf8")).lines.map((found) => ({
      where: page,
      ...found,
    })),
  ),
  ...helpExamples.map(({ name, line }) => ({
    where: `the '${name}' --help examples`,
    line,
    inline: false,
  })),
];

/**
 * The words s3cab would receive: quotes honoured, and the shell's own syntax
 * dropped — a `#` comment, anything after a pipe or `||`/`&&`/`;`, and each
 * redirect with its target. A backslash is literal, since most of these lines
 * are Windows paths.
 * @param {string} line
 */
function argv(line) {
  const words = [...line.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map(
    ([, single, double, bare]) => single ?? double ?? bare ?? "",
  );
  const end = words.findIndex(
    (word) => word.startsWith("#") || ["|", "||", "&&", ";"].includes(word),
  );
  const kept = end < 0 ? words : words.slice(0, end);
  return kept.filter(
    (word, i) =>
      !/^\d?>>?$|^<$/.test(word) && !/^\d?>>?$|^<$/.test(kept[i - 1] ?? ""),
  );
}

/**
 * A command line's words as the dispatcher's own `parseArgs` call reads them,
 * throwing where it would.
 * @param {Command} command
 * @param {string[]} args
 * @returns {{ values: Record<string, unknown>, positionals: string[] }}
 */
const parse = (command, args) =>
  parseArgs({
    args,
    options: { ...command.options, json: { type: "boolean" } },
    allowPositionals: true,
    allowNegative: true,
  });

/**
 * Why a documented command line wouldn't run, or `undefined` if it would.
 * @param {string} line
 * @param {boolean} inline
 */
function problemWith(line, inline) {
  const [, name = "", ...args] = argv(line);
  // `s3cab <command> --help`, `s3cab --version`, `s3cab help exclude`: not a
  // command's invocation.
  if (!name || /^[<[-]/.test(name) || name === "help") {
    return undefined;
  }
  const command = commands[name];
  if (!command) {
    return `there is no '${name}' command`;
  }
  try {
    const { positionals } = parse(command, args);
    const declared = Object.values(command.args ?? {});
    const elided = args.some((arg) => arg === "…" || arg === "...");
    if (
      !elided &&
      !declared.some((arg) => arg.variadic) &&
      positionals.length > declared.length
    ) {
      return `'${name}' takes ${declared.length} argument(s), not ${positionals.length}`;
    }
  } catch (error) {
    const named =
      /** @type {{ code?: string }} */ (error).code ===
      "ERR_PARSE_ARGS_INVALID_OPTION_VALUE";
    if (!(inline && named)) {
      return /** @type {Error} */ (error).message.split("\n")[0];
    }
  }
  return undefined;
}

describe("documented command lines", () => {
  it("every one is a command s3cab accepts", () => {
    const broken = documentedCommands().flatMap(({ where, line, inline }) => {
      const problem = problemWith(line, inline);
      return problem ? [`${where}: ${line}\n      ${problem}`] : [];
    });

    assert.deepEqual(
      broken,
      [],
      `documented commands s3cab would reject:\n  ${broken.join("\n  ")}`,
    );
  });

  it("finds the command lines it is meant to be checking", () => {
    // Without this the check above passes just as well on an empty list.
    const lines = documentedCommands().map(({ line }) => line);
    assert.ok(lines.length > 150, `only ${lines.length} found`);
    assert.ok(lines.includes("s3cab compare photos --since 20251110T2104"));
    assert.ok(
      lines.some((line) => line.startsWith("s3cab restore --set photos")),
    );
  });

  it("catches a flag that doesn't exist, and nothing in a prose mention", () => {
    assert.match(
      problemWith("s3cab restore --set photos --overwite", false) ?? "",
      /--overwite/,
    );
    assert.match(problemWith("s3cab nonesuch", false) ?? "", /no 'nonesuch'/);
    assert.match(problemWith("s3cab prop a b", false) ?? "", /1 argument/);
    assert.equal(problemWith("s3cab upload --dir", true), undefined);
    assert.equal(
      problemWith("s3cab verify my-backups || alert", false),
      undefined,
    );
    assert.equal(
      problemWith("s3cab find raw-footage/ > footage.txt", false),
      undefined,
    );
  });
});

/**
 * The output a page shows under `> command` in a `console` block: the lines up
 * to the next prompt or the end of the block. Where a page shows the same
 * command line more than once, `containing` picks the one whose output
 * includes it: by what it shows, not where it sits, so adding or moving an
 * example can't point a check at a different one.
 * @param {string} page
 * @param {string} command
 * @param {string} [containing]
 */
function transcript(page, command, containing) {
  /** @type {string[]} */
  const shown = [];
  for (const [, lang, body = ""] of readFileSync(page, "utf8").matchAll(
    FENCE,
  )) {
    if (lang?.trim() !== "console") {
      continue;
    }
    const lines = body.trimEnd().split("\n");
    for (const [at, line] of lines.entries()) {
      if (line === `> ${command}`) {
        const rest = lines.slice(at + 1);
        const next = rest.findIndex((after) => after.startsWith("> "));
        shown.push((next < 0 ? rest : rest.slice(0, next)).join("\n"));
      }
    }
  }
  const picked =
    containing === undefined
      ? shown
      : shown.filter((output) => output.includes(containing));
  assert.equal(
    picked.length,
    1,
    `${page} shows '> ${command}' ${shown.length} time(s)` +
      (containing === undefined
        ? ""
        : `, ${picked.length} with '${containing}'`) +
      ": expected exactly one",
  );
  return /** @type {string} */ (picked[0]);
}

/**
 * The story's `photos` set in a temp home, with its snapshots up to and
 * including `until`, and a way to run the CLI there. Paths are written as the
 * snapshot would hold them, so the report shortens them against the home
 * exactly as on a real machine.
 * @param {string} root
 * @param {string} until
 */
async function photosSet(root, until) {
  // Absolute, as `setup` writes it: the snapshot rows are absolute paths.
  const home = resolve(root, "home");
  const folder = join(home, sets.photos.folder);
  const set = join(home, ".s3cab", "sets", "photos");
  mkdirSync(join(set, "snapshots"), { recursive: true });
  writeFileSync(join(set, "dirs.txt"), `${folder}\n`);
  writeFileSync(join(set, "env"), `S3CAB_BUCKET=${bucket}\n`);
  for (const { name } of timeline.filter(({ name }) => name <= until)) {
    const files = [...filesAt(name)].map(
      ([path, { fill, size, mtime }]) =>
        new File([new Uint8Array(size).fill(fill.charCodeAt(0))], path, {
          lastModified: Date.parse(mtime),
        }),
    );
    await writeSnapshot(join(set, "snapshots"), name, files, folder);
  }
  return {
    home,
    /** @param {...string} args */
    run: (...args) =>
      spawnSync(process.execPath, ["src/s3cab.mjs", ...args], {
        encoding: "utf8",
        env: { ...process.env, HOME: home, USERPROFILE: home },
      }),
  };
}

// The transcripts are POSIX ones (`~/Photos`, `/home/me/…`); a Windows run
// would print the same report with `\`.
const posixOnly = {
  skip: process.platform === "win32" && "the page shows a POSIX transcript",
};

describe("documented output", () => {
  it("guide/compare.md shows what compare prints", posixOnly, async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const command = "s3cab compare photos --since 20251110T2104";
    const { run } = await photosSet(dir.path, "20251112T0915");

    const { status, stdout, stderr } = run(...argv(command).slice(1));

    assert.equal(status, 0, stderr);
    assert.equal(stdout.trimEnd(), transcript("guide/compare.md", command));
  });

  it(
    "guide/output.md's --json example is what compare --json prints",
    posixOnly,
    async () => {
      await using dir = await mkdtempDisposable(join("test", ".tmp"));
      const command = "s3cab compare photos --until 20251111T0830 --json";
      const { home, run } = await photosSet(dir.path, "20251112T0915");

      const { status, stdout, stderr } = run(...argv(command).slice(1));

      // The page lays the JSON out by hand to keep it short, so the comparison is
      // of the data, with the temp home spelled as the page's.
      assert.equal(status, 0, stderr);
      assert.deepEqual(
        JSON.parse(stdout.replaceAll(home, worlds.posix.home)),
        JSON.parse(transcript("guide/output.md", command)),
      );
    },
  );
});

// When restore.md is read: the latest backup, with the May snapshots forgotten.
const JUNE = "20260612T0915";
const [FIRST = ""] = timeline.map(({ name }) => name);

/** The May snapshots `forget` removes. */
const MAY = timeline.flatMap(({ name, forgotten }) =>
  forgotten ? [name] : [],
);

/**
 * The bucket's snapshots of `photos`, oldest first, where `path` holds the
 * content it has in June: verify reports an object per path.
 * @param {string} path
 */
const holding = (path) => {
  const june = filesAt(JUNE).get(path);
  if (!june) {
    throw new Error(`the story has no '${path}' in ${JUNE}`);
  }
  return backedUp(JUNE)
    .filter((name) => {
      const content = filesAt(name).get(path);
      return content?.fill === june.fill && content.size === june.size;
    })
    .reverse();
};

/**
 * One set's verify report, clean unless `report` says otherwise.
 * @param {keyof typeof scale.referenced} set
 * @param {Partial<SetReport>} [report]
 * @returns {SetReport}
 */
const setReport = (set, report = {}) => ({
  set,
  snapshotsChecked: set === "photos" ? backedUp(JUNE).length : 40,
  referencedObjects: scale.referenced[set],
  problems: [],
  expectedMissing: [],
  unreadableSnapshots: [],
  ...report,
});

/**
 * A verify of the bucket: its three sets, `photos` as given. The other two are
 * always clean and only add to the object count.
 * @param {SetReport} photos
 * @returns {VerifyResult}
 */
const verifyResult = (photos) => ({
  bucket,
  sets: [photos, setReport("documents"), setReport("music")],
});

/**
 * A restore of `photos` from the bucket's June snapshot, empty unless `result`
 * says otherwise.
 * @param {Partial<RestoreResult>} result
 * @returns {RestoreResult}
 */
const restoreResult = (result) => ({
  set: "photos",
  bucket,
  snapshot: JUNE,
  restored: [],
  skipped: [],
  collided: [],
  missing: [],
  corrupt: [],
  refused: [],
  blocked: [],
  clamped: [],
  coarseTimes: 0,
  invalid: [],
  deleted: [],
  unmatched: [],
  ...result,
});

/**
 * The cleanup after the May snapshots are forgotten, having removed `deleted`
 * objects (0 for a dry run): what only they held is what is orphaned.
 * @param {number} deleted
 * @returns {CleanupResult}
 */
const cleanupResult = (deleted) => {
  const referenced = Object.values(scale.referenced).reduce((a, b) => a + b);
  const { objects, shared, ...each } = scale.forgotten;
  return {
    bucket,
    storedObjects: referenced + objects,
    referencedObjects: referenced,
    orphanObjects: objects,
    reclaimableBytes: [shared, ...Object.values(each)].reduce(
      (sum, { bytes }) => sum + bytes,
      0,
    ),
    missingObjects: 0,
    deleted,
    compactedRecordFiles: 0,
    trimmedRecordRows: 0,
  };
};

/**
 * The result each checked command returns, by name.
 * @typedef {{
 *   verify: Awaited<ReturnType<typeof verify>>,
 *   restore: Awaited<ReturnType<typeof restore>>,
 *   extract: Awaited<ReturnType<typeof extract>>,
 *   forget: Awaited<ReturnType<typeof forget>>,
 *   delete: Awaited<ReturnType<typeof deleteHashes>>,
 *   cleanup: Awaited<ReturnType<typeof cleanup>>,
 * }} Results
 */

/**
 * What the CLI prints as `name`'s result: the registry's own renderer for that
 * command, so a command given a renderer of its own is checked against it.
 * @template {keyof Results} N
 * @param {N} name
 * @param {Results[N]} result
 */
const printed = (name, result) =>
  /** @type {Command} */ (commands[name]).render(result, { color: false });

/**
 * What the CLI prints for the error `run` throws as `name`: `errorReport`, the
 * text the dispatcher itself prints.
 * @param {keyof Results} name
 * @param {() => unknown} run
 */
function printedError(name, run) {
  try {
    run();
  } catch (error) {
    return errorReport(name, /** @type {Command} */ (commands[name]), error);
  }
  assert.fail(`'${name}' was expected to throw`);
}

// The line every cloud command prints first, on its first touch of the bucket:
// the default one, for a set with no profile or endpoint of its own.
const NOTICE = authNotice({});

const at = (/** @type {string} */ path) => photo("windows", path);

/**
 * Each cloud transcript a page shows, and what the CLI prints for the page's
 * scenario after the notice. `containing` picks among the times a page shows
 * the same command line. `ending` marks a transcript with the command's own
 * preview or prompt between the notice and the result, so only its last lines
 * are the printed result.
 * @type {{ page: string, command: string, containing?: string, ending?: boolean, output: () => string }[]}
 */
const CLOUD = [
  {
    page: "guide/maintenance.md",
    command: `s3cab verify ${bucket}`,
    containing: `${Object.values(scale.referenced)
      .reduce((a, b) => a + b)
      .toLocaleString("en-US")} objects checked — all verified`,
    output: () => printed("verify", verifyResult(setReport("photos"))),
  },
  {
    page: "guide/maintenance.md",
    command: `s3cab verify ${bucket}`,
    containing: "1 set with findings",
    output: () =>
      printed(
        "verify",
        verifyResult(
          setReport("photos", {
            problems: [
              {
                path: at("beach.jpg"),
                problem: "missing",
                snapshots: holding("beach.jpg"),
              },
              {
                path: at("report.pdf"),
                problem: "wrong-size",
                snapshots: holding("report.pdf"),
                recordedSize: filesAt(JUNE).get("report.pdf")?.size,
                storedSize: 0,
              },
            ],
          }),
        ),
      ),
  },
  {
    page: "guide/maintenance.md",
    command: `s3cab verify ${bucket}`,
    containing: "files deleted from backups",
    output: () =>
      printed(
        "verify",
        verifyResult(
          setReport("photos", {
            referencedObjects: scale.referenced.photos - scale.footage.objects,
            expectedMissing: Array.from(
              { length: scale.footage.files },
              (_, i) => ({
                path: at(
                  `raw-footage/clip${String(i + 1).padStart(3, "0")}.mov`,
                ),
                snapshots: [JUNE],
                deletedOn: deleted,
              }),
            ),
          }),
        ),
      ),
  },
  {
    page: "guide/maintenance.md",
    command: `s3cab forget --set photos ${MAY[0]}`,
    ending: true,
    output: () =>
      printed("forget", {
        set: "photos",
        snapshots: MAY.slice(0, 1),
        forgotten: true,
      }),
  },
  {
    page: "guide/maintenance.md",
    command: `s3cab forget --set photos ${MAY.join(" ")}`,
    ending: true,
    output: () =>
      printed("forget", { set: "photos", snapshots: MAY, forgotten: true }),
  },
  {
    page: "guide/maintenance.md",
    command: `s3cab delete --bucket ${bucket} --from-file footage.txt`,
    ending: true,
    output: () =>
      printed("delete", {
        bucket,
        deletedObjects: scale.footage.objects,
        deletedBytes: scale.footage.bytes,
        missing: [],
        record: `s3://${bucket}/objects.deleted-1.tsv`,
        deleted: true,
      }),
  },
  {
    page: "guide/maintenance.md",
    command: `s3cab cleanup ${bucket}`,
    containing: "reclaimed",
    ending: true,
    output: () => printed("cleanup", cleanupResult(scale.forgotten.objects)),
  },
  {
    page: "guide/maintenance.md",
    command: `s3cab cleanup ${bucket} --dry-run`,
    ending: true,
    output: () => printed("cleanup", cleanupResult(0)),
  },
  {
    page: "guide/maintenance.md",
    command: `s3cab cleanup ${bucket}`,
    containing: "Can't clean up right now",
    ending: true,
    output: () => {
      // The lock's age is reckoned from now, so now is the page's: just after
      // the forget, while the other machine backs up its set.
      const now = mock.method(Temporal.Now, "instant", () =>
        Temporal.Instant.from("2026-06-12T13:21:55.123Z"),
      );
      try {
        return printedError("cleanup", () => {
          throw uploadRunningError(bucket, "cleanup", [
            {
              id: "upload-20260612T131843.123Z",
              kind: "upload",
              command: "backup",
              set: "music",
              by: sets.music.by,
              os: sets.music.os,
              pidns: "pid:[4026531836]",
              pid: 18311,
              started: "2026-06-12T13:18:43.123Z",
            },
          ]);
        });
      } finally {
        now.mock.restore();
      }
    },
  },
  {
    page: "guide/restore.md",
    command: `s3cab restore --set photos ${at("beach.jpg")}`,
    containing: "Restored 1 file",
    output: () =>
      printed("restore", restoreResult({ restored: [at("beach.jpg")] })),
  },
  {
    page: "guide/restore.md",
    command: `s3cab restore --set photos ${at("nope.jpg")}`,
    output: () =>
      printedError("restore", () =>
        selectTargets(
          {
            entries: new Map(
              [...filesAt(JUNE)].map(([path, { size, mtime }]) => [
                at(path),
                { hash: "0".repeat(64), size, mtime },
              ]),
            ),
            errors: new Map(),
            refused: new Map(),
            dirs: [at("")],
          },
          /** @type {BackupSet} */ ({ name: "photos" }),
          JUNE,
          [at("nope.jpg")],
        ),
      ),
  },
  {
    page: "guide/restore.md",
    command: "s3cab restore --set photos --all --snapshot 2026-05-01",
    output: () =>
      printedError("restore", () => {
        throw snapshotNotFoundError("photos", "2026-05-01", backedUp(JUNE));
      }),
  },
  {
    page: "guide/restore.md",
    command: "s3cab restore --set photos --all",
    containing: "No backups for set",
    output: () =>
      printedError("restore", () => {
        throw noBackupsError("photos");
      }),
  },
  {
    page: "guide/restore.md",
    command: `s3cab restore --set photos ${at("report.pdf")} --snapshot ${FIRST}`,
    output: () =>
      printed(
        "restore",
        restoreResult({ snapshot: FIRST, restored: [at("report.pdf")] }),
      ),
  },
  {
    page: "guide/restore.md",
    command: `s3cab restore --set photos ${at("2019")} ${at("report.pdf")}`,
    output: () =>
      printed(
        "restore",
        restoreResult({
          restored: [at("2019/hike.jpg"), at("2019/summit.jpg")],
          skipped: [at("report.pdf")],
        }),
      ),
  },
  {
    page: "guide/restore.md",
    command: `s3cab extract --set photos ${at("report.pdf")} --snapshot ${FIRST}`,
    output: () =>
      printed(
        "extract",
        restoreResult({
          snapshot: FIRST,
          restored: [at("report.pdf")],
          to: `${worlds.windows.home}\\report.pdf`,
        }),
      ),
  },
  {
    page: "guide/restore.md",
    command: "s3cab restore --set photos --all",
    containing: "Could not restore 2 files",
    output: () =>
      printed(
        "restore",
        restoreResult({
          restored: Array.from({ length: scale.files - 2 }, (_, i) =>
            at(`${i}.jpg`),
          ),
          missing: [at("2024/sorted/IMG_001.jpg"), at("2025/new.jpg")],
        }),
      ),
  },
  {
    page: "README.md",
    command: `s3cab restore --set photos ${at("beach.jpg")}`,
    output: () =>
      printed(
        "restore",
        restoreResult({ snapshot: FIRST, restored: [at("beach.jpg")] }),
      ),
  },
];

describe("documented output, cloud", () => {
  for (const { page, command, containing, ending, output } of CLOUD) {
    it(`${page}: '${command}'${containing ? ` (showing '${containing}')` : ""}`, () => {
      const [first, ...rest] = transcript(page, command, containing).split(
        "\n",
      );
      const result = output();

      assert.equal(first, NOTICE, "the notice every cloud command opens with");
      assert.equal(
        (ending ? rest.slice(-result.split("\n").length) : rest).join("\n"),
        result,
      );
    });
  }
});

// Snapshot-shaped names a page shows as what is *not* a snapshot: format.md's
// key no date makes, and one in a folder below a set's.
const NOT_SNAPSHOTS = new Set(["20261345T9999", "20990101T0000"]);

/** @param {string} name - A name standing for any value: `<set>`, `…` */
const placeholder = (name) => /^(?:[<[{…]|\.\.\.$|$)/.test(name);

/** @typedef {"set" | "bucket" | "snapshot" | "home" | "identity"} Kind */

/**
 * Every name some code gives a set, a bucket, a snapshot, a home folder or a
 * `user@machine`, and the set or bucket each of its command lines names. A
 * home folder is named `user/folder`.
 * @param {string} code
 */
function storyNames(code) {
  /** @type {{ kind: Kind, name: string }[]} */
  const names = [];
  /**
   * @param {Kind} kind
   * @param {RegExp} pattern
   */
  const add = (kind, pattern) => {
    for (const [, first = "", second = ""] of code.matchAll(pattern)) {
      names.push({
        kind,
        name: kind === "home" ? `${first}/${second}` : first,
      });
    }
  };
  add("snapshot", /(?<!\d)(\d{8}T\d{4})(?!\d)/g);
  add("set", /\bset '([^']*)'/g);
  add("set", /@SET[ \t]+NAME[ \t]+(\S+)/g);
  add("set", /\bsets[\\/]([^\\/\s`'"]+)/g);
  add("bucket", /\bs3:\/\/([^/\s`'"]+)/g);
  add("bucket", /\bbucket '([^']*)'/g);
  add("home", /\b[A-Za-z]:[\\/]Users[\\/]([^\\/\s`'"]+)[\\/]?([^\\/\s`'")]*)/g);
  add("home", /(?<![\w.\\:])\/home\/([^/\s`'"]+)\/?([^/\s`'")]*)/g);
  add("home", /(?<![\w.\\:])\/(Users)\/([^/\s`'"]+)/g);
  add("home", /(?<![\w])~()[\\/]([^\\/\s`'")]+)/g);
  add(
    "identity",
    /(?<![\w.@-])([\w.-]+@[A-Za-z][\w-]*(?:\.[\w-]+)*)(?![\w@-])/g,
  );
  // Every line that reads as a command, in any block: more than `codeOf`
  // takes, since a line that names no command is skipped here.
  for (const [, line = ""] of code.matchAll(
    /^[ \t]*(?:> )?(s3cab[ \t].*)$/gm,
  )) {
    const [, name = "", ...args] = argv(line);
    const command = commands[name];
    if (!command) {
      continue;
    }
    try {
      const { values, positionals } = parse(command, args);
      const [first] = Object.keys(command.args ?? {});
      for (const kind of /** @type {const} */ (["set", "bucket"])) {
        const given = [
          values[kind],
          first === kind ? positionals[0] : undefined,
        ];
        for (const value of given) {
          if (typeof value === "string") {
            names.push({ kind, name: value });
          }
        }
      }
    } catch {
      // A line s3cab would reject is the first check's to report.
    }
  }
  return names;
}

/**
 * The names the story doesn't have, as `kind 'name'`.
 * @param {ReturnType<typeof storyNames>} names
 */
function strangers(names) {
  const known = {
    snapshot: (/** @type {string} */ name) =>
      timeline.some((snapshot) => snapshot.name === name) ||
      NOT_SNAPSHOTS.has(name),
    set: (/** @type {string} */ name) => Object.hasOwn(sets, name),
    bucket: (/** @type {string} */ name) => name === bucket,
    // `Users/…` is the macOS home, which neither world has. A file directly
    // in the home, like what `extract` writes there, is no folder to know.
    home: (/** @type {string} */ name) => {
      const [who = "", entry = ""] = name.split("/");
      const folder = entry.replace(/[.,;:]+$/, "");
      return (
        (who === user || who === "") &&
        (placeholder(folder) ||
          homeFolders.includes(folder) ||
          /^[^.].*\.\w+$/.test(folder))
      );
    },
    // `user@machine` is format.md's name for the form itself.
    identity: (/** @type {string} */ name) =>
      name === "user@machine" ||
      Object.values(sets).some(({ by }) => by === name),
  };
  return names.flatMap(({ kind, name }) =>
    placeholder(name) || known[kind](name) ? [] : [`${kind} '${name}'`],
  );
}

describe("the story", () => {
  for (const page of PAGES) {
    it(`${page} names only what the story has`, () => {
      const { code } = codeOf(readFileSync(page, "utf8"));
      assert.deepEqual(strangers(storyNames(code)), []);
    });
  }

  it("the built-in help names only what the story has", () => {
    const help = [
      usage(commands),
      ...Object.keys(commands).map((name) => usage(commands, name)),
      ...Object.values(helpTopics),
    ].join("\n");
    assert.deepEqual(strangers(storyNames(help)), []);
  });

  it("catches a name outside the story, and not a placeholder", () => {
    // One name each pattern should catch, so a pattern that stops matching
    // fails here.
    const page = [
      "```console",
      "> s3cab restore --set holiday C:\\Users\\you\\Photos\\beach.jpg",
      "> s3cab verify my-bucket",
      "> s3cab compare photos --since 20250101T0000",
      "photos: ~/Pictures  /Users/me/Photos  /home/me/Pictures  s3://other",
      "Can't reach bucket 'elsewhere': set 'travel' is locked.",
      "  s3cab cleanup spare",
      "s3cab 0.14.0",
      "> s3cab backup <set>",
      "> s3cab cleanup <bucket> --dry-run",
      "```",
      "```text",
      "@SET NAME videos",
      "OWNER=allen@DESKTOP",
      "held by allen@Allens-MacBook.local.",
      "s3cab provider --keys garden",
      "```",
      "`~/.s3cab/sets/<set>/env`, `~/.s3cab/sets/work/env` and",
      "`s3cab list photos`, and a bare `s3cab` before `cleanup stray`",
    ].join("\n");
    const { code, lines } = codeOf(page);

    assert.ok(lines.some(({ line }) => line === "s3cab cleanup spare"));
    assert.ok(
      !lines.some(({ line }) => line === "s3cab 0.14.0"),
      "output that only starts with the tool's name is no command",
    );
    assert.deepEqual(strangers(storyNames(code)), [
      "snapshot '20250101T0000'",
      "set 'travel'",
      "set 'videos'",
      "set 'work'",
      "bucket 'other'",
      "bucket 'elsewhere'",
      "home 'you/Photos'",
      "home 'me/Pictures'",
      "home 'Users/me'",
      "home '/Pictures'",
      "identity 'allen@DESKTOP'",
      "identity 'allen@Allens-MacBook.local'",
      "set 'holiday'",
      "bucket 'my-bucket'",
      "bucket 'spare'",
      "set 'garden'",
    ]);
  });

  it("finds the names it is meant to be checking", () => {
    // Without this the checks above pass just as well on a pattern that
    // matches nothing.
    const found = storyNames(
      codeOf(readFileSync("README.md", "utf8")).code,
    ).map(({ kind, name }) => `${kind} '${name}'`);
    for (const name of [
      "snapshot '20251110T2104'",
      "set 'photos'",
      "bucket 'my-backups'",
      "home 'me/Photos'",
    ]) {
      assert.ok(found.includes(name), `${name} not found in README.md`);
    }
  });
});
