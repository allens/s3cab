import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { registerHooks } from "node:module";

/** @import { IncomingMessage } from "node:http" */

// The crash-tier instrument, loaded into an s3cab child process with
// `node --import`. It does exactly three things, all observation-side —
// nothing here fakes an S3 response or alters what s3cab sends:
//
//   1. **Trace**: append one line per outgoing S3-plane HTTP(S) request (and
//      one per response) to `S3CAB_XLOG`, so the orchestrating test can audit
//      exactly which protocol steps completed before a kill.
//   2. **Kill**: `S3CAB_XKILL="<n>:<METHOD>:<pathRegex>"` — immediately before
//      the n-th matching request is dispatched, SIGKILL this process. A real
//      hard kill (TerminateProcess on Windows): no cleanup handlers run, the
//      request never goes out, and whatever the previous requests committed is
//      what the bucket keeps.
//   3. **Hold**: `S3CAB_XHOLD="<n>:<METHOD>:<pathRegex>"` — immediately before
//      the n-th matching request, write `S3CAB_XHOLD_REACHED` and block (the
//      whole event loop, deliberately) until `S3CAB_XHOLD_GATE` exists, then
//      let the request proceed. This is how a real multi-process interleaving
//      is made deterministic: the child is parked *between* two protocol
//      steps while another real process runs to completion.
//
// Matching is restricted to the S3 data plane (hostname contains ".s3." or
// starts with "s3.") so credential traffic (SSO/STS) never counts toward a
// kill/hold index. The trace records every request either way, host included,
// so the restriction is auditable.
//
// One deliberate deviation from production, opt-in and labeled: with
// `S3CAB_XGRACE_MS` set, `cleanup`'s 7-day grace window constant is rewritten
// at module load to the given number of milliseconds (time compression — the
// scenario that needs it is "an object *past grace*", which a test cannot
// wait 7 days for). Nothing else about the command changes, and the rewrite
// throws loudly if the source no longer matches.

const LOG = process.env.S3CAB_XLOG;
const TAG = process.env.S3CAB_XTAG ?? String(process.pid);

/** @param {string} line */
function trace(line) {
  if (LOG) {
    appendFileSync(LOG, `${new Date().toISOString()} [${TAG}] ${line}\n`);
  }
}

/**
 * Parse "<n>:<METHOD>:<pathRegex>" into a matcher spec.
 * @param {string | undefined} spec
 * @returns {{ n: number, method: string, path: RegExp } | undefined}
 */
function parseSpec(spec) {
  if (!spec) {
    return undefined;
  }
  const match = /^(\d+):([A-Z]+):(.+)$/.exec(spec);
  if (!match) {
    throw new Error(
      `killswitch: bad spec '${spec}' (want "<n>:<METHOD>:<pathRegex>")`,
    );
  }
  return {
    n: Number(match[1]),
    method: /** @type {string} */ (match[2]),
    path: new RegExp(/** @type {string} */ (match[3])),
  };
}

const killSpec = parseSpec(process.env.S3CAB_XKILL);
const holdSpec = parseSpec(process.env.S3CAB_XHOLD);
let killSeen = 0;
let holdSeen = 0;
let held = false;

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
/** @param {number} ms */
const sleepSync = (ms) => {
  Atomics.wait(sleepBuffer, 0, 0, ms);
};

/**
 * Whether a request is S3 data-plane traffic (vs SSO/STS/other credential
 * calls, which must never count toward a kill or hold index).
 * @param {string} host
 */
const isS3Plane = (host) => host.includes(".s3.") || host.startsWith("s3.");

/**
 * @param {string} method
 * @param {string} host
 * @param {string} path
 */
function beforeDispatch(method, host, path) {
  trace(`REQ  ${method} ${host}${path}`);
  if (!isS3Plane(host)) {
    return;
  }
  if (
    holdSpec &&
    !held &&
    method === holdSpec.method &&
    holdSpec.path.test(path)
  ) {
    holdSeen++;
    if (holdSeen === holdSpec.n) {
      held = true; // one hold per process — releasing it must not re-arm
      const gate = process.env.S3CAB_XHOLD_GATE;
      const reached = process.env.S3CAB_XHOLD_REACHED;
      if (!gate || !reached) {
        throw new Error(
          "killswitch: S3CAB_XHOLD needs S3CAB_XHOLD_GATE and S3CAB_XHOLD_REACHED",
        );
      }
      const timeoutMs = Number(process.env.S3CAB_XHOLD_TIMEOUT_MS ?? 120_000);
      trace(`HOLD ${method} ${host}${path} (until ${gate})`);
      writeFileSync(reached, `${method} ${path}\n`);
      const deadline = Date.now() + timeoutMs;
      while (!existsSync(gate)) {
        if (Date.now() > deadline) {
          trace(`HOLD-TIMEOUT after ${timeoutMs}ms — proceeding`);
          break;
        }
        sleepSync(100);
      }
      trace(`RELEASED ${method} ${host}${path}`);
    }
  }
  if (killSpec && method === killSpec.method && killSpec.path.test(path)) {
    killSeen++;
    if (killSeen === killSpec.n) {
      trace(`KILL before ${method} ${host}${path}`);
      process.kill(process.pid, "SIGKILL");
      // SIGKILL is TerminateProcess — nothing below should run. Belt and
      // braces: never let the request escape even if termination is slow.
      for (;;) {
        sleepSync(1000);
      }
    }
  }
}

/**
 * Wrap `http.request`/`https.request` (the properties the SDK's
 * NodeHttpHandler reads per call) with the trace/hold/kill gate.
 * @param {typeof https.request} original
 * @returns {typeof https.request}
 */
function wrapRequest(original) {
  return function wrapped(arg1, arg2) {
    /** @type {URL | undefined} */
    let url;
    /** @type {Record<string, any>} */
    let opts;
    if (typeof arg1 === "string" || arg1 instanceof URL) {
      url = new URL(String(arg1));
      opts = typeof arg2 === "object" && arg2 !== null ? arg2 : {};
    } else {
      opts = arg1 ?? {};
    }
    const method = String(opts.method ?? "GET").toUpperCase();
    const host = String(url?.hostname ?? opts.hostname ?? opts.host ?? "");
    const path = url ? url.pathname + url.search : String(opts.path ?? "/");
    beforeDispatch(method, host, path);
    // @ts-expect-error — arguments passthrough keeps every call shape intact
    const req = original.apply(this, arguments);
    req.on("response", (/** @type {IncomingMessage} */ res) => {
      trace(`RESP ${res.statusCode} ${method} ${host}${path}`);
    });
    return req;
  };
}

https.request = wrapRequest(https.request);
http.request = wrapRequest(http.request);

// Opt-in time compression for cleanup's grace window (see header).
const graceMs = process.env.S3CAB_XGRACE_MS;
if (graceMs) {
  const PRODUCTION_LINE = "export const GRACE_MS = 7 * 24 * 60 * 60 * 1000;";
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (url.endsWith("src/lib/cleanup.mjs")) {
        const source = String(result.source);
        if (!source.includes(PRODUCTION_LINE)) {
          throw new Error(
            "killswitch: GRACE_MS line not found in cleanup.mjs — the source moved; fix the rewrite",
          );
        }
        trace(`GRACE_MS compressed to ${Number(graceMs)}ms`);
        return {
          ...result,
          source: source.replace(
            PRODUCTION_LINE,
            `export const GRACE_MS = ${Number(graceMs)};`,
          ),
        };
      }
      return result;
    },
  });
}
