import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { MINUTE_MS, VirtualClock, clockHolder } from "./clock.mjs";
import { FakeS3, backendHolder } from "./fake-s3.mjs";
import { StepFaults } from "./faults.mjs";
import {
  checkNoDuplicateObjectPuts,
  checkObjectsBeforeManifest,
  checkRestores,
  checkStore,
  compareTrees,
} from "./invariants.mjs";
import { RepoModel } from "./model.mjs";
import * as s3cab from "./seam.mjs";
import { contentBytes } from "./sequence.mjs";

/** @import { Step } from "./sequence.mjs" */
/** @import { TrackedSnapshot } from "./model.mjs" */

// The sequence runner: interprets generated steps against the seam-mocked
// commands, reconciles the model after every step, and stops at the first
// invariant violation. Preconditions are checked here (not by the generator)
// so any *subsequence* still runs — the property shrinking depends on.
//
// Fault discipline: a step's pre-rolled fault may legitimately make its
// command throw or exit nonzero. What a fault never excuses is a *lie* — a
// command that returns success must have actually succeeded (a restore that
// claims success must have written correct bytes), and the store must satisfy
// the shape invariants after every step, faulted or not.
//
// Locks (ADR-0112) are judged from the `locks/` keys before and after a step.
// A faulted step may leave its lock (the DELETE that failed), and that lock
// then legitimately turns away later steps: a backup meeting a delete lock,
// or a cleanup meeting an upload lock, must refuse — which looks like a
// throw, and is expected. An unfaulted step never adds a lock.

const BUCKET = "model-bucket";

/**
 * @typedef {{
 *   ok: boolean,
 *   stepIndex: number,
 *   step: Step | null,
 *   violations: string[],
 *   output: string[],
 * }} RunResult
 */

/**
 * Replace console with a capture, returning the restorer. Commands narrate on
 * warn/log; a failing step's narration goes in the report, the rest is
 * discarded.
 * @param {string[]} into
 */
const captureConsole = (into) => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  const savedStderrWrite = process.stderr.write;
  /** @type {(...args: unknown[]) => void} */
  const sink = (...args) => {
    into.push(args.map(String).join(" "));
  };
  console.log = sink;
  console.warn = sink;
  console.error = sink;
  // Progress lines (lib/progress.mjs) write to the stderr stream directly,
  // not through console — intercept those too. Honour the full write()
  // signature: a caller passing a callback would otherwise wait forever.
  process.stderr.write = /** @type {typeof process.stderr.write} */ (
    (
      /** @type {string | Uint8Array} */ chunk,
      /** @type {BufferEncoding | ((error?: Error | null) => void) | undefined} */ encoding,
      /** @type {((error?: Error | null) => void) | undefined} */ callback,
    ) => {
      into.push(String(chunk).trimEnd());
      const cb = typeof encoding === "function" ? encoding : callback;
      cb?.();
      return true;
    }
  );
  return () => {
    console.log = saved.log;
    console.warn = saved.warn;
    console.error = saved.error;
    process.stderr.write = savedStderrWrite;
  };
};

/**
 * Run one sequence in a disposable root directory. Deterministic given the
 * steps: fresh clock, backend and model; virtual time only; faults are the
 * steps' own.
 * @param {Step[]} steps
 * @param {string} root - A disposable directory this run owns
 * @returns {Promise<RunResult>}
 */
export async function runSequence(steps, root) {
  const clock = new VirtualClock(Date.UTC(2026, 0, 5));
  clockHolder.current = clock;
  const fake = new FakeS3();
  backendHolder.current = fake;
  const model = new RepoModel(BUCKET, fake);

  /** @type {Map<string, string>} set → its (shared) data directory */
  const setDirs = new Map();
  /** @type {Set<string>} `${machine}:${set}` — which machines have which sets */
  const machineSets = new Set();
  /** @type {Map<string, number>} set → the machine holding it (ADR-0108) */
  const holders = new Map();

  const homeOf = (/** @type {number} */ machine) =>
    join(root, `m${machine}`, ".s3cab");
  const switchTo = (/** @type {number} */ machine) => {
    process.env.S3CAB_HOME = homeOf(machine);
  };
  const ownerOf = (/** @type {string} */ set) => {
    for (const entry of machineSets) {
      const [machine, owned] = entry.split(":");
      if (owned === set) {
        return Number(machine);
      }
    }
    return 0;
  };
  const trackedFor = (/** @type {string} */ set) =>
    [...model.snapshots.values()]
      .filter((tracked) => tracked.set === set)
      .sort((a, b) => a.name.localeCompare(b.name));

  const restoreSnapshot = async (
    /** @type {TrackedSnapshot} */ tracked,
    /** @type {string} */ output,
  ) => {
    switchTo(ownerOf(tracked.set));
    // Invariant-check restores run outside the per-step capture window, so
    // silence their narration here.
    const restoreConsole = captureConsole([]);
    try {
      await s3cab.restore([], {
        all: true,
        set: tracked.set,
        snapshot: tracked.name,
        output,
      });
    } finally {
      restoreConsole();
    }
  };

  const savedHome = process.env.S3CAB_HOME;
  const savedExitCode = process.exitCode;

  try {
    for (let i = 0; i < steps.length; i++) {
      const step = /** @type {Step} */ (steps[i]);
      /** @type {string[]} */
      const violations = [];
      /** @type {string[]} */
      const output = [];

      // ── Pre-op bookkeeping the judgement needs ─────────────────────────
      const fault = "fault" in step ? step.fault : undefined;
      /** @type {Awaited<ReturnType<RepoModel["expectedVerifyFindings"]>> | null} */
      let expectedVerify = null;
      if (step.kind === "verify") {
        expectedVerify = await model.expectedVerifyFindings();
      }
      const keysBefore = (await fake.listAll(BUCKET)).map(({ key }) => key);
      const locksBefore = keysBefore.filter((key) => key.startsWith("locks/"));
      const objectsBefore = keysBefore.filter((key) =>
        key.startsWith("objects/"),
      );
      // A refusal that is the expected outcome: a backup or forget from a
      // machine that has the set but doesn't hold it, a backup while a delete
      // lock stands, a cleanup while an upload lock stands.
      /** @type {string | null} */
      let refused = null;
      if (
        (step.kind === "backup" || step.kind === "forget") &&
        holders.get(step.set) !== step.machine
      ) {
        refused = `machine ${step.machine} doesn't hold ${step.set}`;
      }
      const blockingLock =
        step.kind === "backup"
          ? locksBefore.find((key) => key.startsWith("locks/delete-"))
          : step.kind === "cleanup"
            ? locksBefore.find((key) => key.startsWith("locks/upload-"))
            : undefined;
      if (blockingLock) {
        refused = `${blockingLock} stands`;
      }

      // ── Execute ────────────────────────────────────────────────────────
      const logStart = fake.log.length;
      const restoreConsole = captureConsole(output);
      process.exitCode = 0;
      fake.faults = fault ? new StepFaults(fault) : null;
      /** @type {unknown} */
      let threw = null;
      let skipped = false;
      /** @type {TrackedSnapshot | undefined} the target of restore/forget */
      let target;
      /** @type {string | undefined} a restore step's output dir */
      let restoreOut;
      try {
        switch (step.kind) {
          case "create-set": {
            if (machineSets.has(`${step.machine}:${step.set}`)) {
              skipped = true;
              break;
            }
            const dir = join(root, "data", step.set);
            mkdirSync(dir, { recursive: true });
            step.seedFiles.forEach((kind, n) => {
              writeFileSync(join(dir, `f${n}.txt`), contentBytes(kind));
            });
            switchTo(step.machine);
            await s3cab.setup([dir], { set: step.set, bucket: BUCKET });
            // Blank the starter excludes so generated names can't be
            // silently skipped (a user-legal edit).
            writeFileSync(
              join(homeOf(step.machine), "sets", step.set, "exclude.txt"),
              "",
            );
            // As setup canonicalizes it, so `asRestored` finds its restore.
            setDirs.set(step.set, realpathSync.native(dir));
            machineSets.add(`${step.machine}:${step.set}`);
            holders.set(step.set, step.machine);
            break;
          }
          case "mutate": {
            const dir = setDirs.get(step.set);
            if (!dir) {
              skipped = true;
              break;
            }
            const path = join(dir, step.file);
            if (step.content === null) {
              if (existsSync(path)) {
                rmSync(path);
              } else {
                skipped = true;
              }
            } else {
              mkdirSync(dirname(path), { recursive: true });
              writeFileSync(path, contentBytes(step.content));
            }
            break;
          }
          case "advance": {
            clock.advance(step.ms);
            break;
          }
          case "backup": {
            if (!machineSets.has(`${step.machine}:${step.set}`)) {
              skipped = true;
              break;
            }
            switchTo(step.machine);
            await s3cab.backup(step.set);
            break;
          }
          case "snapshot": {
            if (!machineSets.has(`${step.machine}:${step.set}`)) {
              skipped = true;
              break;
            }
            switchTo(step.machine);
            await s3cab.snapshot(step.set);
            break;
          }
          case "restore": {
            const candidates = trackedFor(step.set);
            if (
              candidates.length === 0 ||
              !machineSets.has(`${step.machine}:${step.set}`)
            ) {
              skipped = true;
              break;
            }
            target = candidates[step.index % candidates.length];
            restoreOut = join(root, "out", `step${i}`);
            mkdirSync(restoreOut, { recursive: true });
            switchTo(step.machine);
            await s3cab.restore([], {
              all: true,
              set: step.set,
              snapshot: /** @type {TrackedSnapshot} */ (target).name,
              output: restoreOut,
            });
            break;
          }
          case "verify": {
            switchTo(0);
            await s3cab.verify(BUCKET);
            break;
          }
          case "forget": {
            const candidates = trackedFor(step.set);
            if (
              candidates.length === 0 ||
              !machineSets.has(`${step.machine}:${step.set}`)
            ) {
              skipped = true;
              break;
            }
            target = candidates[step.index % candidates.length];
            switchTo(step.machine);
            await s3cab.forget([/** @type {TrackedSnapshot} */ (target).name], {
              set: step.set,
              force: true,
            });
            break;
          }
          case "cleanup": {
            switchTo(0);
            await s3cab.cleanup(BUCKET, { force: true });
            break;
          }
          case "takeover": {
            const holder = holders.get(step.set);
            if (holder === undefined || holder === step.machine) {
              skipped = true;
              break;
            }
            switchTo(step.machine);
            await s3cab.takeover(step.set, [], { bucket: BUCKET });
            machineSets.add(`${step.machine}:${step.set}`);
            holders.set(step.set, step.machine);
            break;
          }
        }
      } catch (error) {
        threw = error;
      }
      const exitCode = process.exitCode;
      restoreConsole();
      fake.faults = null;
      const logSlice = fake.log.slice(logStart);
      clock.advance(MINUTE_MS);

      if (skipped) {
        continue;
      }

      // ── Judge ──────────────────────────────────────────────────────────
      const publishing =
        step.kind === "backup"
          ? {
              publishedSet: step.set,
              dirs: [/** @type {string} */ (setDirs.get(step.set))],
            }
          : {};
      const { dropped, unexplained } = await model.reconcile(publishing);

      for (const { set, name } of unexplained) {
        violations.push(
          `manifest snapshots/${set}/${name} appeared without a publishing operation`,
        );
      }
      const dropsAllowed =
        step.kind === "forget"
          ? new Set([target ? `${target.set}/${target.name}` : ""])
          : new Set();
      for (const gone of dropped) {
        if (!dropsAllowed.has(`${gone.set}/${gone.name}`)) {
          violations.push(
            `manifest snapshots/${gone.set}/${gone.name} vanished during ${step.kind}`,
          );
        }
      }

      if (refused && !threw) {
        violations.push(`${step.kind} went ahead although ${refused}`);
      }
      if (
        !refused &&
        !fault &&
        threw &&
        step.kind !== "mutate" &&
        step.kind !== "advance"
      ) {
        violations.push(
          `${step.kind} threw without an injected fault: ${String(threw)}`,
        );
      }

      if (step.kind === "backup") {
        violations.push(...checkObjectsBeforeManifest(logSlice));
        if (!fault && !threw) {
          violations.push(...checkNoDuplicateObjectPuts(logSlice));
        }
      }

      if (step.kind === "restore" && !threw && exitCode === 0 && target?.tree) {
        // Success claimed — the bytes must be right, fault or no fault.
        violations.push(
          ...compareTrees(target, /** @type {string} */ (restoreOut)),
        );
      }
      if (step.kind === "restore" && !fault && !threw && exitCode !== 0) {
        violations.push(`restore exited ${exitCode} with a healthy store`);
      }

      if (step.kind === "verify" && !threw && expectedVerify) {
        const got = exitCode === 1;
        if (got !== expectedVerify.expectExit1) {
          violations.push(
            `verify exited ${exitCode} but the model expected ` +
              (expectedVerify.expectExit1
                ? `findings:\n  ${expectedVerify.findings.join("\n  ")}`
                : `a clean bill`),
          );
        }
      }

      const keysAfter = (await fake.listAll(BUCKET)).map(({ key }) => key);
      if (!fault) {
        for (const key of keysAfter) {
          if (key.startsWith("locks/") && !locksBefore.includes(key)) {
            violations.push(`${step.kind} left its lock ${key}`);
          }
        }
      }
      if (step.kind === "cleanup" && refused) {
        for (const key of objectsBefore) {
          if (!keysAfter.includes(key)) {
            violations.push(`a refused cleanup deleted ${key}`);
          }
        }
      }
      if (step.kind === "cleanup" && !fault && !threw) {
        // No grace window: every unreferenced object is cleanup's to sweep.
        const referenced = new Set();
        for (const manifest of await model.parsedManifests()) {
          for (const { hash } of manifest.rows) {
            referenced.add(hash);
          }
        }
        for (const key of keysAfter) {
          if (
            key.startsWith("objects/") &&
            !referenced.has(key.slice("objects/".length))
          ) {
            violations.push(`cleanup left orphan ${key}`);
          }
        }
      }

      violations.push(...(await checkStore(model)));

      // Full re-restores only after the steps that can *change* what a
      // restore would produce — the bucket writers (backup/forget/cleanup,
      // even faulted: a duplicated read re-runs a side-effect-free effect in
      // the fake, so read steps can't mutate the store). The final sweep
      // below re-restores everything once more regardless, so a hole in this
      // reasoning shows up at the end of the sequence rather than never.
      if (["backup", "forget", "cleanup"].includes(step.kind)) {
        const scratch = join(root, "check", `step${i}`);
        mkdirSync(scratch, { recursive: true });
        violations.push(
          ...(await checkRestores(model, restoreSnapshot, scratch)),
        );
      }

      if (violations.length) {
        return { ok: false, stepIndex: i, step, violations, output };
      }
    }

    // ── End of sequence: the full sweep ──────────────────────────────────
    /** @type {string[]} */
    const finalViolations = [...(await checkStore(model))];
    const scratch = join(root, "check", "final");
    mkdirSync(scratch, { recursive: true });
    finalViolations.push(
      ...(await checkRestores(model, restoreSnapshot, scratch)),
    );
    if (finalViolations.length) {
      return {
        ok: false,
        stepIndex: steps.length,
        step: null,
        violations: finalViolations,
        output: [],
      };
    }
    return {
      ok: true,
      stepIndex: steps.length,
      step: null,
      violations: [],
      output: [],
    };
  } finally {
    if (savedHome === undefined) {
      delete process.env.S3CAB_HOME;
    } else {
      process.env.S3CAB_HOME = savedHome;
    }
    process.exitCode = savedExitCode;
  }
}
