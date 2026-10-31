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
//   bucket, the figures are a real library's (48,210 objects), and the
//   restores write to `C:\Users\me`. What drifts is the wording and layout,
//   and that is the renderer's. Each result is typed as its command's own, so
//   `typecheck` catches one that no longer matches.
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
import { readFileSync, readdirSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { parseArgs } from "node:util";
import { commands } from "../src/commands.mjs";
import { errorReport } from "../src/help.mjs";
import { uploadRunningError } from "../src/lib/locks.mjs";
import {
  noBackupsError,
  selectTargets,
  snapshotNotFoundError,
} from "../src/lib/restore.mjs";
import { authNotice } from "../src/lib/s3.mjs";
import { file, photosSet, restoreResult } from "./helpers/photos-set.mjs";

/** @import { Command } from "../src/commands.mjs" */
/** @import { CleanupResult } from "../src/commands/cleanup.mjs" */
/** @import { deleteHashes } from "../src/commands/delete.mjs" */
/** @import { extract } from "../src/commands/extract.mjs" */
/** @import { forget } from "../src/commands/forget.mjs" */
/** @import { restore } from "../src/commands/restore.mjs" */
/** @import { cleanup } from "../src/commands/cleanup.mjs" */
/** @import { verify } from "../src/commands/verify.mjs" */
/** @import { VerifyResult } from "../src/commands/verify.mjs" */
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
// `> ` prompt, everything else is output), or an untagged or shell block of
// bare commands. `text`, `json`, … hold output and data, never commands.
const SHELL = new Set(["", "sh", "bash", "powershell"]);

/**
 * Every `s3cab …` command line the docs show, with where it came from. Inline
 * code is marked: there a trailing flag can be a mention of the flag rather
 * than half an invocation (`s3cab upload --dir`).
 * @returns {{ where: string, line: string, inline: boolean }[]}
 */
function documentedCommands() {
  const found = [];
  for (const page of PAGES) {
    const text = readFileSync(page, "utf8");
    for (const [, lang = "", body = ""] of text.matchAll(FENCE)) {
      for (const raw of body.split("\n")) {
        const line = raw.trim();
        const command =
          lang.trim() === "console"
            ? /^> (s3cab\s.*)/.exec(line)?.[1]
            : SHELL.has(lang.trim()) && /^s3cab\s/.test(line)
              ? line
              : undefined;
        if (command) {
          found.push({ where: page, line: command, inline: false });
        }
      }
    }
    const prose = text.replace(FENCE, "");
    for (const [, , span = ""] of prose.matchAll(/(`+)(s3cab\s[\s\S]*?)\1/g)) {
      found.push({
        where: page,
        line: span.replace(/\s+/g, " "),
        inline: true,
      });
    }
  }
  for (const [name, { examples = [] }] of Object.entries(commands)) {
    for (const line of examples) {
      found.push({
        where: `the '${name}' --help examples`,
        line,
        inline: false,
      });
    }
  }
  return found;
}

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
    const { positionals } = parseArgs({
      args,
      options: { ...command.options, json: { type: "boolean" } },
      allowPositionals: true,
      allowNegative: true,
    });
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
    assert.ok(lines.includes("s3cab compare photos --since 20251111T0830"));
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
      problemWith("s3cab find secretsdir/ > hashes.txt", false),
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

// The transcripts are POSIX ones (`~/Pictures`, `/home/me/…`); a Windows run
// would print the same report with `\`.
const posixOnly = {
  skip: process.platform === "win32" && "the page shows a POSIX transcript",
};

describe("documented output", () => {
  it("guide/compare.md shows what compare prints", posixOnly, async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const command = "s3cab compare photos --since 20251111T0830";
    // The page's scenario: a photo filed into a subfolder, a note renamed, a
    // logo copied, a report edited, one new photo and one old note gone.
    const { run } = await photosSet(dir.path, {
      "20251111T0830": [
        file("2024/IMG_001.jpg", "i", 3_400_000),
        file("logo.png", "l", 41_000),
        file("notes.txt", "n", 2_100),
        file("old notes.txt", "o", 900),
        file("report.pdf", "r", 1_200_000),
      ],
      "20251112T0915": [
        file("2024/sorted/IMG_001.jpg", "i", 3_400_000),
        file("2025/new.jpg", "j", 4_000_000),
        file("brand-logo.png", "l", 41_000),
        file("diary.txt", "n", 2_100),
        file("logo.png", "l", 41_000),
        file("report.pdf", "R", 1_250_000),
      ],
    });

    const { status, stdout, stderr } = run(...argv(command).slice(1));

    assert.equal(status, 0, stderr);
    assert.equal(stdout.trimEnd(), transcript("guide/compare.md", command));
  });

  it(
    "guide/output.md's --json example is what compare --json prints",
    posixOnly,
    async () => {
      await using dir = await mkdtempDisposable(join("test", ".tmp"));
      const command = "s3cab compare photos --json";
      const { home, run } = await photosSet(dir.path, {
        "20251111T0830": [file("diary.txt", "d", 180)],
        "20251112T0915": [
          file("2025/new.jpg", "j", 812_043),
          file("diary.txt", "D", 240),
        ],
      });

      const { status, stdout, stderr } = run(...argv(command).slice(1));

      // The page lays the JSON out by hand to keep it short, so the comparison is
      // of the data, with the temp home spelled as the page's `/home/me`.
      assert.equal(status, 0, stderr);
      assert.deepEqual(
        JSON.parse(stdout.replaceAll(home, "/home/me")),
        JSON.parse(transcript("guide/output.md", command)),
      );
    },
  );
});

/**
 * One set's verify report, clean unless `report` says otherwise.
 * @param {string} set
 * @param {number} referencedObjects
 * @param {Partial<SetReport>} [report]
 * @returns {SetReport}
 */
const setReport = (set, referencedObjects, report = {}) => ({
  set,
  snapshotsChecked: 40,
  referencedObjects,
  problems: [],
  expectedMissing: [],
  unreadableSnapshots: [],
  ...report,
});

/**
 * A verify of `my-backups`: the page's three sets, `photos` as given. The other
 * two are always clean and only add to the object count.
 * @param {SetReport} photos
 * @returns {VerifyResult}
 */
const verifyResult = (photos) => ({
  bucket: "my-backups",
  sets: [photos, setReport("documents", 6_211), setReport("music", 497)],
});

/**
 * A cleanup of `my-backups` with the page's figures, having removed `deleted`
 * objects (0 for a dry run).
 * @param {number} deleted
 * @returns {CleanupResult}
 */
const cleanupResult = (deleted) => ({
  bucket: "my-backups",
  storedObjects: 48_210,
  referencedObjects: 47_898,
  orphanObjects: 312,
  reclaimableBytes: 1_400_000_000,
  missingObjects: 0,
  deleted,
  compactedRecordFiles: 0,
  trimmedRecordRows: 0,
});

const PHOTOS = "C:\\Users\\me\\Photos";

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
    command: "s3cab verify my-backups",
    containing: "48,210 objects checked — all verified",
    output: () => printed("verify", verifyResult(setReport("photos", 41_502))),
  },
  {
    page: "guide/maintenance.md",
    command: "s3cab verify my-backups",
    containing: "1 set with findings",
    output: () =>
      printed(
        "verify",
        verifyResult(
          setReport("photos", 41_502, {
            problems: [
              {
                path: `${PHOTOS}\\beach.jpg`,
                problem: "missing",
                snapshots: ["20260612T0915"],
              },
              {
                path: `${PHOTOS}\\report.pdf`,
                problem: "wrong-size",
                snapshots: ["20260612T0915"],
                recordedSize: 245_760,
                storedSize: 0,
              },
            ],
          }),
        ),
      ),
  },
  {
    page: "guide/maintenance.md",
    command: "s3cab verify my-backups",
    containing: "files deleted from backups",
    output: () =>
      printed(
        "verify",
        verifyResult(
          setReport("photos", 41_205, {
            expectedMissing: Array.from({ length: 312 }, (_, i) => ({
              path: `${PHOTOS}\\raw-footage\\clip${i}.mov`,
              snapshots: ["20260612T0915"],
              deletedOn: "2026-07-19T10:41:07.000Z",
            })),
          }),
        ),
      ),
  },
  {
    page: "guide/maintenance.md",
    command: "s3cab forget --set photos 20260501T0800",
    ending: true,
    output: () =>
      printed("forget", {
        set: "photos",
        snapshots: ["20260501T0800"],
        forgotten: true,
      }),
  },
  {
    page: "guide/maintenance.md",
    command:
      "s3cab forget --set photos 20260501T0800 20260508T0800 20260515T0800",
    ending: true,
    output: () =>
      printed("forget", {
        set: "photos",
        snapshots: ["20260501T0800", "20260508T0800", "20260515T0800"],
        forgotten: true,
      }),
  },
  {
    page: "guide/maintenance.md",
    command: "s3cab delete --bucket my-backups --from-file footage.txt",
    ending: true,
    output: () =>
      printed("delete", {
        bucket: "my-backups",
        deletedObjects: 297,
        deletedBytes: 48_100_000_000,
        missing: [],
        record: "s3://my-backups/objects.deleted-1.tsv",
        deleted: true,
      }),
  },
  {
    page: "guide/maintenance.md",
    command: "s3cab cleanup my-backups",
    containing: "reclaimed",
    ending: true,
    output: () => printed("cleanup", cleanupResult(312)),
  },
  {
    page: "guide/maintenance.md",
    command: "s3cab cleanup my-backups --dry-run",
    ending: true,
    output: () => printed("cleanup", cleanupResult(0)),
  },
  {
    page: "guide/maintenance.md",
    command: "s3cab cleanup my-backups",
    containing: "Can't clean up right now",
    ending: true,
    output: () => {
      // The lock's age is reckoned from now, so now is the page's.
      const now = mock.method(Temporal.Now, "instant", () =>
        Temporal.Instant.from("2026-10-27T14:05:17.123Z"),
      );
      try {
        return printedError("cleanup", () => {
          throw uploadRunningError("my-backups", "cleanup", [
            {
              id: "upload-20261027T140205.123Z",
              kind: "upload",
              command: "backup",
              set: "photos",
              by: "me@LAPTOP",
              os: "win32",
              pid: 18204,
              started: "2026-10-27T14:02:05.123Z",
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
    command: `s3cab restore --set photos ${PHOTOS}\\beach.jpg`,
    containing: "Restored 1 file",
    output: () =>
      printed("restore", restoreResult({ restored: [`${PHOTOS}\\beach.jpg`] })),
  },
  {
    page: "guide/restore.md",
    command: `s3cab restore --set photos ${PHOTOS}\\nope.jpg`,
    output: () =>
      printedError("restore", () =>
        selectTargets(
          {
            entries: new Map([
              [
                `${PHOTOS}\\beach.jpg`,
                {
                  hash: "0".repeat(64),
                  size: 4_915_200,
                  mtime: "2026-06-01T12:00:00.000Z",
                },
              ],
            ]),
            errors: new Map(),
            refused: new Map(),
            dirs: [PHOTOS],
          },
          /** @type {BackupSet} */ ({ name: "photos" }),
          "20260612T0915",
          [`${PHOTOS}\\nope.jpg`],
        ),
      ),
  },
  {
    page: "guide/restore.md",
    command: "s3cab restore --set photos --all --snapshot 2026-05-01",
    output: () =>
      printedError("restore", () => {
        throw snapshotNotFoundError("photos", "2026-05-01", [
          "20260612T0915",
          "20260501T0800",
        ]);
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
    command: `s3cab restore --set photos ${PHOTOS}\\report.pdf --snapshot 20260501T0800`,
    output: () =>
      printed(
        "restore",
        restoreResult({
          snapshot: "20260501T0800",
          restored: [`${PHOTOS}\\report.pdf`],
        }),
      ),
  },
  {
    page: "guide/restore.md",
    command: "s3cab restore --set photos --all",
    containing: "Skipped 1 existing file",
    output: () =>
      printed(
        "restore",
        restoreResult({
          restored: [`${PHOTOS}\\beach.jpg`, `${PHOTOS}\\2024\\IMG_001.jpg`],
          skipped: [`${PHOTOS}\\report.pdf`],
        }),
      ),
  },
  {
    page: "guide/restore.md",
    command: `s3cab extract --set photos ${PHOTOS}\\report.pdf --snapshot 20260501T0800`,
    output: () =>
      printed(
        "extract",
        restoreResult({
          snapshot: "20260501T0800",
          restored: [`${PHOTOS}\\report.pdf`],
          to: "C:\\Users\\me\\report.pdf",
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
          restored: Array.from(
            { length: 1_238 },
            (_, i) => `${PHOTOS}\\${i}.jpg`,
          ),
          missing: [`${PHOTOS}\\2019\\hike.jpg`, `${PHOTOS}\\2019\\summit.jpg`],
        }),
      ),
  },
  {
    page: "README.md",
    command: `s3cab restore --set photos ${PHOTOS}\\beach.jpg`,
    output: () =>
      printed(
        "restore",
        restoreResult({
          snapshot: "20251112T0915",
          restored: [`${PHOTOS}\\beach.jpg`],
        }),
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
