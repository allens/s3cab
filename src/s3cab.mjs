#!/usr/bin/env node

import pkg from "../package.json" with { type: "json" };

import { parseArgs } from "node:util";

import { commands } from "./commands.mjs";
import { errorMessage, helpTopics, synopsis, usage } from "./help.mjs";
import { loadEnv } from "./lib/env.mjs";
import {
  EXIT_INTERRUPTED,
  InterruptedError,
  isInputError,
  isUsageError,
} from "./lib/error.mjs";
import { formatByteValue, secondsSince } from "./lib/format.mjs";
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
// help (usage() falls back to the command list for anything unrecognized).
// Topic and command names are disjoint by convention (test-enforced in
// help.test.mjs), so the topics-first lookup order can never shadow a command.
if (
  !commandName ||
  commandName === "help" ||
  commandName === "--help" ||
  commandName === "-h"
) {
  console.log(helpTopics[args[0] ?? ""] ?? usage(commands, args[0], helpStyle));
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

  // Mark the environment initialized once, up front (ADR-0022) — the tripwire
  // s3.mjs's client() asserts. There is no user layer to load (ADR-0055);
  // set-accepting commands apply their set layer via `loadSet`.
  loadEnv();

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
