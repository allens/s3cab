#!/usr/bin/env node

import pkg from "../package.json" with { type: "json" };

import { parseArgs } from "node:util";

import { commands } from "./commands.mjs";
import { errorMessage, helpTopics, synopsis, usage } from "./help.mjs";
import { isCredentialProviderError } from "./lib/auth.mjs";
import {
  EXIT_INTERRUPTED,
  InterruptedError,
  errorText,
  isInputError,
  isUsageError,
} from "./lib/error.mjs";
import { formatByteValue, secondsSince } from "./lib/format.mjs";
import { statusLine } from "./lib/progress.mjs";
import { bold, styleEnabled } from "./lib/style.mjs";

const start = Temporal.Now.instant();
const debug = Boolean(process.env.S3CAB_DEBUG);

// Bold section headings on an interactive stdout only (lib/style.mjs): piped
// `s3cab --help | less` output stays escape-free (clig.dev). Error-path usage
// goes to stderr and stays plain.
const helpStyle = styleEnabled(process.stdout) ? { heading: bold } : undefined;

const [execPath, jsPath, commandName, ...args] = process.argv;

// Global --version, handled before command dispatch. pkg.version is the single
// source of truth (package.json); esbuild inlines this JSON into the SEA bundle,
// so the native binary reports the same version as the npm/source CLI.
if (commandName === "--version" || commandName === "-v") {
  console.log(pkg.version);
  process.exit(0);
}

// Top-level help: no command given, or an explicit help request. `help <topic>`
// (e.g. `help exclude`) prints that topic; `help <command>` prints that command's
// help. Topic and command names are disjoint by convention (test-enforced in
// help.test.mjs), so the topics-first lookup order can never shadow a command.
if (
  !commandName ||
  commandName === "help" ||
  commandName === "--help" ||
  commandName === "-h"
) {
  const topic = args[0];
  // A name that is neither a topic nor a command is a failed request, so it
  // reports as one: the miss and the list go to stderr and the exit is non-zero
  // (clig.dev), rather than the command list arriving on stdout under exit 0 —
  // which made `s3cab help "$topic" || fallback` never take the fallback. Bare
  // `help` still prints the list on stdout, because that request succeeded.
  if (
    topic !== undefined &&
    !Object.hasOwn(helpTopics, topic) &&
    !Object.hasOwn(commands, topic)
  ) {
    console.error(
      `No help available for '${topic}' (not a command or a help topic).\n`,
    );
    console.error(usage(commands));
    process.exit(2);
  }
  console.log(helpTopics[topic ?? ""] ?? usage(commands, topic, helpStyle));
  process.exit(0);
}

const command = commands[commandName];

if (!command) {
  console.error(`Unknown command: ${commandName}\n`);
  console.error(usage(commands));
  process.exit(127);
}

// Per-command help: `s3cab <command> --help`.
if (args.includes("--help") || args.includes("-h")) {
  console.log(usage(commands, commandName, helpStyle));
  process.exit(0);
}

// The AWS SDK refreshes near-expiry credentials on a promise it never attaches a
// `catch` to and never awaits (`isCredentialProviderError` documents the
// mechanism), so a refresh that fails mid-run becomes an unhandled rejection —
// and Node's default for that is to kill the process. That lands on exactly the
// command that can least afford it: an hours-long `backup`, dropped by a hiccup
// the SDK is already set up to retry through. Disarm that one rejection and let
// the retry run; if the credentials really are gone, the awaited path reports it
// properly. Everything else is a floating promise of ours, so it is re-thrown to
// keep Node's fatal default rather than papering over a real bug.
//
// The warning is once-only. The retry fires per request, so a refresh that keeps
// failing would otherwise repeat this line hundreds of times before the
// credentials actually lapse — and once said, it has nothing to add: the error
// that follows an unrecoverable lapse speaks for itself.
let warnedRefreshFailure = false;
process.on("unhandledRejection", (reason) => {
  if (!isCredentialProviderError(reason)) {
    throw reason;
  }
  if (!warnedRefreshFailure) {
    warnedRefreshFailure = true;
    // `statusLine`, not `console.warn`: a progress bar may be mid-line (ADR-0044).
    statusLine(
      process.stderr,
      `Couldn't refresh your cloud credentials just now — carrying on, and ` +
        `s3cab will keep trying in the background. If they do run out, it will ` +
        `stop and tell you how to sign in again. (${errorText(reason)})`,
    );
  }
});

try {
  const { values: options, positionals } = parseArgs({
    args,
    // `--json` is a global flag, owned by the dispatcher (like --help/--version):
    // merged into every command's parse here, then stripped before `exec` below
    // so no command ever sees it (ADR-0043).
    options: { ...command.options, json: { type: "boolean" } },
    allowPositionals: true,
    allowNegative: true,
  });

  if (debug) {
    console.warn({ execPath, jsPath, commandName, positionals, options });
  }

  const { json, ...execOptions } = options;
  const result = await command.exec({ ...execOptions, debug }, positionals);

  // Human-readable text is the stdout default; `--json` emits the raw structure
  // (ADR-0043 inverts ADR-0010's JSON-everything default). Both paths never
  // truncate — JSON.stringify doesn't, and a renderer returns a whole string —
  // keeping results on stdout, separate from progress/warnings on stderr. Every
  // command has a `render` now (required in the registry, tsc-enforced), so there
  // is no fallback. Colour gates on the stdout TTY (`styleEnabled`). The
  // defined-result guard stays: a command's declared return type still admits
  // `undefined`, and calling a renderer on it would throw.
  if (result !== undefined) {
    const output = json
      ? JSON.stringify(result, null, 2)
      : command.render(result, { color: styleEnabled(process.stdout) });
    // A renderer can return "" — an empty `tree`/`hashes` stream. Emit nothing
    // then, not a lone "\n": the empty→empty-string contract must survive a
    // redirect/pipe (a stray newline would corrupt it, and read as one line to
    // `wc -l`). ADR-0043. JSON output is never empty, so this only trims the
    // empty-stream case.
    if (output) {
      process.stdout.write(output + "\n");
    }
  }
} catch (error) {
  // A run the user stopped is not a failure: print what it saved, plainly, and
  // exit on the shell's signal convention (ADR-0067) — no `ERROR:`, no usage.
  if (error instanceof InterruptedError) {
    console.error(error.message);
    process.exitCode = EXIT_INTERRUPTED;
  } else {
    // Two independent axes (see lib/error.mjs): print the usage help only for a
    // structural usage error, and pick the exit code by input-vs-runtime. Exit-code
    // convention: 2 for bad input (args/options/values — the argparse/getopt
    // convention), 1 for any other runtime failure. (Success is 0; an unknown
    // command exits 127 above, the shell's "command not found".) `errorMessage`
    // owns the text — a missing argument is spelled from the registry (ADR-0038);
    // debug prints the error object whole instead, stack and all.
    console.error("ERROR:", debug ? error : errorMessage(command, error));
    // A usage error prints the one-line synopsis + a --help pointer, not the full
    // arg/option tables (those live behind --help) — ADR-0038.
    if (isUsageError(error)) {
      console.error();
      console.error(synopsis(commands, commandName));
      console.error(`Run 's3cab ${commandName} --help' for details.`);
    }
    process.exitCode = isInputError(error) ? 2 : 1;
  }
} finally {
  if (debug) {
    console.warn(
      "Memory usage:",
      formatByteValue(process.memoryUsage().heapUsed),
    );
    console.warn("Runtime:", secondsSince(start));
  }
}
