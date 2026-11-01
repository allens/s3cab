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
// - **The printed result** for the cloud transcripts (backup, verify, restore,
//   extract, and how setup, forget, delete and cleanup end): what the CLI
//   prints for a result built to the page's scenario (the registry's own
//   renderer for the command, or `errorReport` for an error) after the notice
//   every cloud command opens with (`authNotice`). Not a run against a real
//   bucket, which can't reproduce them: verify and cleanup read the whole
//   shared test bucket, the figures are a whole library's, and the restores
//   write to `C:\Users\me`. What drifts is the wording and layout, and that is
//   the renderer's. Each result is typed as its command's own, so `typecheck`
//   catches one that no longer matches. Backup's timings are values in its
//   result, so they are checked too.
//
// Every scenario is built from the story (helpers/story.mjs), and a last check
// fails a page that names a set, a bucket, a snapshot, a home folder or a
// `user@machine` outside it, so a page and its check can't disagree about the
// world.
//
// An example whose paths depend on the OS is two adjacent fences,
// `console windows` then `console posix` (the site makes them tabs), one in
// each of the story's worlds. Each variant is checked on its own: a local
// transcript by a run on that OS, a cloud one through the renderer on both.
//
// Only the transcripts the tests below name are checked; every other one is
// kept right by hand. What a command prints itself, before or around its
// result, can't be checked this way. For those only the transcript's last
// lines are compared (`ending`):
//
// - What forget, delete and cleanup print between the notice and their
//   result: the preview, the prompt, and the lines after the answer (forget's
//   cleanup pointer and record path, delete's record notice).
// - What `setup --keys` prints around the notice: the key prompts before it
//   (`before`), and the starter exclude notice after it (its patterns are
//   spelled with the platform's separator).
// - What README's quick start `backup` prints around the notice: the
//   `Using s3cab home` line before it, and the progress lines after it.
//
// Cross-cutting, with no module to sit beside, so it lives in test/ (ADR-0049).

import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
import { freshInfo, writeClaim } from "../src/lib/set-marker.mjs";
import { firstBackup, restoreResult, storySet } from "./helpers/photos-set.mjs";
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

/** @import { Command } from "../src/commands.mjs" */
/** @import { Content, World } from "./helpers/story.mjs" */
/** @import { backup, BackupResult } from "../src/commands/backup.mjs" */
/** @import { CleanupResult } from "../src/commands/cleanup.mjs" */
/** @import { compare } from "../src/commands/compare.mjs" */
/** @import { deleteHashes } from "../src/commands/delete.mjs" */
/** @import { extract } from "../src/commands/extract.mjs" */
/** @import { forget } from "../src/commands/forget.mjs" */
/** @import { restore } from "../src/commands/restore.mjs" */
/** @import { setup } from "../src/commands/setup.mjs" */
/** @import { status } from "../src/commands/status.mjs" */
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
// `> ` prompt, and the output can suggest more, indented on lines of their
// own), or an untagged or shell block of bare commands. `text`, `json`, … hold
// output and data, never commands.
const SHELL = new Set(["", "sh", "bash", "powershell"]);

/**
 * A fence's language, and the OS it is the variant for: `console windows` is
 * the Windows variant of a `console` block, which the site turns into a tab.
 * @param {string} info
 */
const fenceLang = (info) => {
  const [lang = "", os] = info.trim().split(/\s+/);
  return { lang, os };
};

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
    const tag = fenceLang(lang).lang;
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
 * example can't point a check at a different one. `os` takes only that OS's
 * variants, and the examples the same on every OS.
 * @param {string} page
 * @param {string} command
 * @param {{ containing?: string, os?: World }} [pick]
 */
function transcript(page, command, { containing, os } = {}) {
  /** @type {string[]} */
  const shown = [];
  for (const [, info = "", body = ""] of readFileSync(page, "utf8").matchAll(
    FENCE,
  )) {
    const fence = fenceLang(info);
    if (
      fence.lang !== "console" ||
      (fence.os !== undefined && fence.os !== os)
    ) {
      continue;
    }
    const lines = body.trimEnd().split("\n");
    for (const [at, line] of lines.entries()) {
      if (line === `> ${command}`) {
        const rest = lines.slice(at + 1);
        const next = rest.findIndex((after) => after.startsWith("> "));
        const output = next < 0 ? rest : rest.slice(0, next);
        // Not the page's own `# ` note introducing the next command (the
        // README quick start's numbered steps), nor the blank line before it.
        while (/^(#.*)?$/.test(output.at(-1) ?? "x")) {
          output.pop();
        }
        shown.push(output.join("\n"));
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
      (os === undefined ? "" : ` for ${os}`) +
      (containing === undefined
        ? ""
        : `, ${picked.length} with '${containing}'`) +
      ": expected exactly one",
  );
  return /** @type {string} */ (picked[0]);
}

const OSES = /** @type {World[]} */ (Object.keys(worlds));

// A local transcript is what the CLI prints on this machine, so each OS's
// variant is checked by a run on that OS.
const here = process.platform === "win32" ? "windows" : "posix";

// The site's `osVariants` tabs only a language then one of these; any other
// word after the language would leave the example a plain block.
it("tags each OS variant windows or posix", () => {
  const variant = new RegExp(`^\\S+ +(${OSES.join("|")})$`);
  for (const page of PAGES) {
    for (const [, info = ""] of readFileSync(page, "utf8").matchAll(FENCE)) {
      const { os } = fenceLang(info);
      assert.ok(
        os === undefined || variant.test(info.trim()),
        `${page}: '${info.trim()}'`,
      );
    }
  }
});

// The tutorial shows Windows transcripts only (`C:\Users\me\Photos`); a POSIX
// run would print the same report with `/`.
const windowsOnly = {
  skip: process.platform !== "win32" && "the page shows a Windows transcript",
};

// The tutorial (guide/getting-started.md) follows the story's first two
// backups, of a set created with `--keys`. AWS's own documentation example
// key, so it can't be anyone's.
const HOME = worlds.windows.home;
const PHOTOS = photo("windows");
const [FIRST = "", TIDY = ""] = timeline.map(({ name }) => name);
const KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const TUTORIAL = "guide/getting-started.md";

describe("documented output", () => {
  for (const os of OSES) {
    const onOs = { skip: os !== here && `the ${os} variant prints on ${os}` };

    it(`guide/compare.md shows what compare prints (${os})`, onOs, async () => {
      await using dir = await mkdtempDisposable(join("test", ".tmp"));
      const command = "s3cab compare photos --since 20251110T2104";
      const { run } = await storySet(dir.path, "20251112T0915");

      const { status, stdout, stderr } = run(...argv(command).slice(1));

      assert.equal(status, 0, stderr);
      assert.equal(
        stdout.trimEnd(),
        transcript("guide/compare.md", command, { os }),
      );
    });

    it(
      `guide/output.md's --json example is what compare --json prints (${os})`,
      onOs,
      async () => {
        await using dir = await mkdtempDisposable(join("test", ".tmp"));
        const command = "s3cab compare photos --until 20251111T0830 --json";
        const { home, run } = await storySet(dir.path, "20251112T0915");

        const { status, stdout, stderr } = run(...argv(command).slice(1));

        // The page lays the JSON out by hand to keep it short, so the
        // comparison is of the data, with the temp home spelled as the page's.
        assert.equal(status, 0, stderr);
        assert.deepEqual(
          JSON.parse(stdout, (_, value) =>
            typeof value === "string"
              ? value.replace(home, worlds[os].home)
              : value,
          ),
          JSON.parse(transcript("guide/output.md", command, { os })),
        );
      },
    );
  }

  /**
   * The tutorial's set after its two backups, as `setup --keys` leaves a set:
   * held by this machine, with its access key on it, which is what `list`
   * shows of a set.
   * @param {string} root
   */
  const tutorialSet = async (root) => {
    const made = await storySet(root, TIDY);
    const set = join(made.home, ".s3cab", "sets", "photos");
    writeFileSync(
      join(set, "env"),
      `S3CAB_BUCKET=${bucket}\nAWS_ACCESS_KEY_ID=${KEY_ID}\nAWS_SECRET_ACCESS_KEY=not-a-secret\n`,
    );
    writeClaim(join(set, "claim"), freshInfo());
    return made;
  };

  it(`${TUTORIAL} shows what list prints`, async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const command = "s3cab list";
    const { run } = await tutorialSet(dir.path);

    const { status, stdout, stderr } = run(...argv(command).slice(1));

    assert.equal(status, 0, stderr);
    assert.equal(stdout.trimEnd(), transcript(TUTORIAL, command));
  });

  it(`${TUTORIAL} shows what list prints of a set`, windowsOnly, async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const command = "s3cab list photos";
    const { home, run } = await tutorialSet(dir.path);

    const { status, stdout, stderr } = run(...argv(command).slice(1));

    // The set's files are under the temp home; the page's are under its.
    assert.equal(status, 0, stderr);
    assert.equal(
      stdout.trimEnd().replaceAll(home, HOME),
      transcript(TUTORIAL, command),
    );
  });
});

// When restore.md is read: the latest backup, with the May snapshots forgotten.
const JUNE = "20260612T0915";

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
 *   backup: Awaited<ReturnType<typeof backup>>,
 *   verify: Awaited<ReturnType<typeof verify>>,
 *   restore: Awaited<ReturnType<typeof restore>>,
 *   extract: Awaited<ReturnType<typeof extract>>,
 *   forget: Awaited<ReturnType<typeof forget>>,
 *   delete: Awaited<ReturnType<typeof deleteHashes>>,
 *   cleanup: Awaited<ReturnType<typeof cleanup>>,
 *   setup: Awaited<ReturnType<typeof setup>>,
 *   compare: Awaited<ReturnType<typeof compare>>,
 *   status: Awaited<ReturnType<typeof status>>,
 * }} Results
 */

/**
 * The photos set as `setup` returns it in `os`'s world, every path under its
 * home.
 * @param {World} os
 * @returns {BackupSet}
 */
const setOf = (os) => {
  const { home, sep } = worlds[os];
  const dir = [home, ".s3cab", "sets", "photos"].join(sep);
  return {
    name: "photos",
    dirs: [photo(os)],
    bucket,
    dir,
    snapshotsDir: `${dir}${sep}snapshots`,
    dirsPath: `${dir}${sep}dirs.txt`,
    excludePath: `${dir}${sep}exclude.txt`,
    envPath: `${dir}${sep}env`,
    claimPath: `${dir}${sep}claim`,
  };
};

const TUTORIAL_SET = setOf("windows");

/**
 * A backup of the tutorial's set: the story's first, unless `result` says
 * otherwise.
 * @param {Partial<BackupResult>} result
 * @returns {BackupResult}
 */
const backupResult = (result) => ({
  ...firstBackup,
  excludePath: TUTORIAL_SET.excludePath,
  ...result,
});

// The compare report shortens paths against the set's folder and spells that
// folder from the home (`~\Photos`), so the folder has to sit under this
// machine's own home for the renderer to print the page's header.
const MY_PHOTOS = join(homedir(), sets.photos.folder);
const mine = (/** @type {string} */ path) =>
  join(MY_PHOTOS, ...path.split("/"));

const [before, after] = [filesAt(FIRST), filesAt(TIDY)];
const size = (/** @type {Map<string, Content>} */ files, path = "") =>
  files.get(path)?.size ?? 0;

/**
 * What the tutorial's second backup found: the story's tidy-up.
 * @type {Results["compare"]}
 */
const TUTORIAL_CHANGES = {
  setName: "photos",
  dirs: [MY_PHOTOS],
  since: FIRST,
  until: TIDY,
  added: [
    {
      path: mine("brand-logo.png"),
      size: size(after, "brand-logo.png"),
      duplicates: [mine("logo.png")],
      wasUnreadable: false,
    },
  ],
  moved: [
    {
      path: mine("notes.txt"),
      size: size(before, "notes.txt"),
      to: mine("diary.txt"),
    },
  ],
  modified: [{ path: mine("report.pdf"), size: size(after, "report.pdf") }],
  deleted: [
    { path: mine("old notes.txt"), size: size(before, "old notes.txt") },
  ],
  errors: [],
};

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

// The tutorial's world, and the one the shared entries spell paths in.
const at = (/** @type {string} */ path) => photo("windows", path);

/**
 * Each cloud transcript a page shows, and what the CLI prints for the page's
 * scenario after the notice. `os` names the OS variant it is, and
 * `containing` picks among the times a page shows the same command line.
 * `ending` marks a transcript with the command's own
 * preview or prompt between the notice and the result, so only its last lines
 * are the printed result. `before` counts the lines a command prints before
 * its first cloud touch (`setup --keys` asks for the key and the secret first,
 * and every set command opens with `Using s3cab home`). `skip` is
 * `windowsOnly`'s, for a result whose rendering spells paths the platform's way.
 * @type {{ page: string, command: string, containing?: string, os?: World, ending?: boolean, before?: number, skip?: string | false, output: () => string }[]}
 */
const CLOUD = [
  {
    page: TUTORIAL,
    command: `s3cab setup --set photos --bucket ${bucket} --keys ${PHOTOS}`,
    before: 2,
    ending: true,
    output: () => printed("setup", TUTORIAL_SET),
  },
  {
    page: TUTORIAL,
    command: "s3cab backup",
    containing: "First backup",
    output: () => printed("backup", backupResult({})),
  },
  {
    page: TUTORIAL,
    command: `s3cab restore --set photos ${at("beach.jpg")}`,
    output: () =>
      printed(
        "restore",
        restoreResult({ snapshot: FIRST, restored: [at("beach.jpg")] }),
      ),
  },
  {
    page: TUTORIAL,
    command: "s3cab backup",
    containing: "Changes since",
    ...windowsOnly,
    // At a terminal the report ends by offering the full comparison, and a
    // yes prints it through `compare`'s own renderer (ADR-0078 §5).
    output: () => {
      // Read again: the copy and the renamed file at their new paths, and the
      // edited one. Only the edit is new content.
      const read = ["brand-logo.png", "diary.txt", "report.pdf"];
      const sum = (/** @type {Map<string, Content>} */ files) =>
        [...files.values()].reduce((total, { size }) => total + size, 0);
      return [
        printed(
          "backup",
          backupResult({
            snapshot: TIDY,
            files: firstBackup.files + after.size - before.size,
            bytes: firstBackup.bytes + sum(after) - sum(before),
            hashedFiles: read.length,
            hashedBytes: read.reduce(
              (total, path) => total + size(after, path),
              0,
            ),
            scanMs: 1_000,
            candidates: 1,
            uploaded: 1,
            uploadedBytes: size(after, "report.pdf"),
            uploadMs: 2_000,
            comparison: TUTORIAL_CHANGES,
          }),
        ),
        "Compare now? [y/N] y",
        printed("compare", TUTORIAL_CHANGES),
      ].join("\n");
    },
  },
  {
    page: TUTORIAL,
    command: "s3cab status",
    output: () =>
      printed("status", {
        set: "photos",
        snapshot: TIDY,
        backedUp: TIDY,
        toUpload: 0,
      }),
  },
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
  ...OSES.flatMap((os) => {
    const at = (/** @type {string} */ path) => photo(os, path);
    return [
      {
        page: "guide/maintenance.md",
        command: `s3cab verify ${bucket}`,
        os,
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
        command: `s3cab forget --set photos ${MAY[0]}`,
        os,
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
        os,
        ending: true,
        output: () =>
          printed("forget", { set: "photos", snapshots: MAY, forgotten: true }),
      },
      {
        page: "guide/maintenance.md",
        command: `s3cab delete --bucket ${bucket} --from-file footage.txt`,
        os,
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
        page: "guide/restore.md",
        command: `s3cab restore --set photos ${at("beach.jpg")}`,
        os,
        containing: "Restored 1 file",
        output: () =>
          printed("restore", restoreResult({ restored: [at("beach.jpg")] })),
      },
      {
        page: "guide/restore.md",
        command: `s3cab restore --set photos ${at("nope.jpg")}`,
        os,
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
        command: `s3cab restore --set photos ${at("report.pdf")} --snapshot ${FIRST}`,
        os,
        output: () =>
          printed(
            "restore",
            restoreResult({ snapshot: FIRST, restored: [at("report.pdf")] }),
          ),
      },
      {
        page: "guide/restore.md",
        command: `s3cab restore --set photos ${at("2019")} ${at("report.pdf")}`,
        os,
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
        os,
        output: () =>
          printed(
            "extract",
            restoreResult({
              snapshot: FIRST,
              restored: [at("report.pdf")],
              to: `${worlds[os].home}${worlds[os].sep}report.pdf`,
            }),
          ),
      },
      {
        page: "guide/restore.md",
        command: "s3cab restore --set photos --all",
        os,
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
        command: `s3cab setup --set photos --bucket my-backups --keys ${at("")}`,
        os,
        before: 2,
        ending: true,
        output: () => printed("setup", setOf(os)),
      },
      {
        page: "README.md",
        command: "s3cab backup",
        os,
        before: 1,
        ending: true,
        output: () => printed("backup", firstBackup),
      },
      {
        page: "README.md",
        command: `s3cab restore --set photos ${at("beach.jpg")}`,
        os,
        output: () =>
          printed(
            "restore",
            restoreResult({ snapshot: FIRST, restored: [at("beach.jpg")] }),
          ),
      },
    ];
  }),
];

describe("documented output, cloud", () => {
  for (const {
    page,
    command,
    containing,
    os,
    ending,
    before = 0,
    skip = false,
    output,
  } of CLOUD) {
    const title = `${page}: '${command}'${containing ? ` (showing '${containing}')` : ""}${os ? ` (${os})` : ""}`;
    it(title, { skip }, () => {
      const [first, ...rest] = transcript(page, command, { containing, os })
        .split("\n")
        .slice(before);
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
