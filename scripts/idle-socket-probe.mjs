/**
 * Measure how long an S3 connection may sit idle before reusing it stops working
 * — the experiment behind ADR-0091, which set `IDLE_SOCKET_TIMEOUT_MS` in
 * src/lib/s3.mjs. Re-run it when a link, a region, or a provider changes.
 *
 * ## The question
 *
 * The SDK pools sockets with keep-alive on. `backup`'s fused pass is strictly
 * sequential and dedup means most rows need no PUT at all, so the client can sit
 * idle for minutes between transfers and then reuse a long-idle socket. If the
 * far end (S3, or a NAT/firewall in between) has closed that connection, the
 * write either draws an ECONNRESET — noisy but instantly retryable — or vanishes
 * into a half-open socket that nothing ends until the 30 s socket timeout fires.
 *
 * A run that dies this way looks exactly like a dropped internet connection and
 * is not one, which is why it needs measuring rather than reasoning about.
 *
 * ## What it does
 *
 * For each idle gap in the ladder: one PUT to warm a connection, then nothing for
 * the gap, then a second PUT. It reports, for that second PUT:
 *
 *   - **reused** — whether it went out on the pooled socket or opened a new one.
 *     Counted by overriding the agent's `createConnection`, so it is the TCP
 *     connection count, not an inference.
 *   - **pooled** — how many sockets were sitting in the free pool when the gap
 *     ended. Zero means S3 closed the connection *and Node noticed*, so there was
 *     nothing to go stale and the gap proves nothing. This is the confounder the
 *     whole measurement turns on.
 *   - **warm** — the same count taken the instant the warm-up PUT resolved,
 *     before any idling. It is the instrument checking itself: if this is 0 the
 *     socket was never pooled in the first place (an undrained response body
 *     would do it), every `pooled` below it is 0 for that reason rather than the
 *     interesting one, and the whole table means nothing.
 *   - **took** — wall-clock for the second PUT. A reused-and-healthy socket is a
 *     round trip; ~30 s is the socket timeout, i.e. the black-hole case.
 *   - **outcome** — ok, or the error name/code.
 *
 * `maxAttempts: 1`, deliberately: the SDK's own retries would paper over exactly
 * the failure being measured and report a cheerful success.
 *
 * ## Reading the result
 *
 * The interesting row is the first gap where `reused` is yes and the outcome is
 * not ok — that is the stale-socket failure, and the bound belongs comfortably
 * below that gap. **No such row has ever been observed.** Against eu-west-1 in
 * September 2026 the peer closed the idle connection between 5 s and 6 s and Node
 * heard it every time, so from 6 s out to 300 s nothing was pooled, every gap
 * opened a fresh connection, and every one succeeded. The failure the bound
 * guards needs the close to go *unheard* — a firewall or NAT dropping the flow —
 * and no ladder of idle gaps conjures one to order.
 *
 * So the honest expectation is a table of `pooled 0` rows. That is a real result
 * and worth re-taking on a new link: it is what says reuse past a few seconds
 * doesn't happen here, which is simultaneously why the stale socket is rare and
 * why bounding it gives up nothing. `--bound <ms>` applies the same eviction
 * production ships; where the peer already closes first it changes no column,
 * which is the point rather than a disappointment.
 *
 * Bucket comes from S3CAB_TEST_BUCKET (the gated-suite bucket) or the first arg.
 * Probe objects go under `probe/idle-socket/` and are deleted at the end; the
 * ~1-day lifecycle rule setup-test-bucket.mjs applies sweeps any that leak.
 *
 * Usage:
 *   S3CAB_TEST_BUCKET=<bucket> node scripts/idle-socket-probe.mjs
 *   node scripts/idle-socket-probe.mjs <bucket> [--bound <ms>] [--gaps 5,30,120]
 *
 * With .env.test set up for the integration suite:
 *   node --env-file-if-exists=.env.test scripts/idle-socket-probe.mjs --bound 10000
 *
 * Credentials and region are ambient, as in setup-test-bucket.mjs and
 * multipart-bench.mjs: AWS_PROFILE / the standard chain, and AWS_REGION or
 * AWS_DEFAULT_REGION (default us-east-1, auto-corrected via S3's 301).
 */

import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Agent } from "node:https";
import { argv, env, exit, stderr, stdout } from "node:process";
import { setTimeout as delay } from "node:timers/promises";

/** Idle gaps to probe, in seconds. Spans a wifi blip to a long hashing stretch. */
const DEFAULT_GAPS = [5, 15, 30, 60, 120, 300];

/**
 * An agent that counts the TCP connections it opens, which is the only way to
 * tell a reused socket from a fresh one without guessing.
 */
class CountingAgent extends Agent {
  opened = 0;

  /**
   * @param {any} options
   * @param {any} callback
   */
  createConnection(options, callback) {
    this.opened += 1;
    return /** @type {any} */ (super.createConnection)(options, callback);
  }

  /** How many sockets are sitting unused in the pool right now. */
  get pooled() {
    return Object.values(this.freeSockets).reduce(
      (total, sockets) => total + (sockets?.length ?? 0),
      0,
    );
  }
}

const USAGE =
  "Usage: node scripts/idle-socket-probe.mjs <bucket> [--bound <ms>] [--gaps 5,30,120]";

/**
 * Refuse a malformed value rather than coercing it. `Number("nope")` is `NaN`,
 * which is falsy for the bound and a zero-length sleep for a gap — so without
 * this the probe runs happily and measures something other than what was asked
 * for, which is the one failure a measuring instrument must not have.
 * @param {string} message
 */
function refuse(message) {
  stderr.write(`${message}\n${USAGE}\n`);
  exit(2);
}

/**
 * @param {string[]} args
 * @returns {{ bucket: string | undefined, bound: number, gaps: number[] }}
 */
function parseArgs(args) {
  let bucket = env.S3CAB_TEST_BUCKET;
  let bound = 0;
  let gaps = DEFAULT_GAPS;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--bound") {
      const value = Number(args[++i]);
      if (!Number.isFinite(value) || value <= 0) {
        refuse(
          `--bound wants a positive number of milliseconds, got '${args[i]}'.`,
        );
      }
      bound = value;
    } else if (args[i] === "--gaps") {
      const raw = String(args[++i]);
      const parsed = raw.split(",").map((g) => Number(g.trim()));
      if (parsed.some((gap) => !Number.isFinite(gap) || gap <= 0)) {
        refuse(
          `--gaps wants a comma-separated list of positive seconds, got '${raw}'.`,
        );
      }
      gaps = parsed;
    } else {
      bucket = args[i];
    }
  }
  return { bucket, bound, gaps };
}

/**
 * One probe: warm a connection, idle, then send again on the same client.
 * @param {string} bucket
 * @param {number} gapSeconds
 * @param {number} bound - Agent idle timeout in ms; 0 for none (the old default)
 */
async function probe(bucket, gapSeconds, bound) {
  const agent = new CountingAgent({
    keepAlive: true,
    ...(bound ? { timeout: bound } : {}),
  });
  const client = new S3Client({
    region: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1",
    followRegionRedirects: true,
    requestHandler: {
      httpsAgent: agent,
      // Production's bounds (ADR-0065), because the outcome this exists to catch
      // is a *half-open* socket: without a socket timeout the second PUT would
      // hang for ever, and the black-hole row would never be printed at all.
      socketTimeout: 30_000,
      connectionTimeout: 10_000,
    },
    // The SDK's own retries would hide the very failure being measured.
    maxAttempts: 1,
  });
  const key = `probe/idle-socket/${gapSeconds}s-${Date.now()}`;
  const send = () =>
    client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: "probe" }),
    );

  try {
    await send();
    const openedAfterWarmup = agent.opened;
    const warm = agent.pooled;
    await delay(gapSeconds * 1000);
    const pooled = agent.pooled;

    const startedAt = performance.now();
    /** @type {string} */
    let outcome;
    try {
      await send();
      outcome = "ok";
    } catch (error) {
      const { name, code, message } = /** @type {any} */ (error);
      outcome = code ?? name ?? message;
    }
    const tookMs = performance.now() - startedAt;

    return {
      gapSeconds,
      warm,
      pooled,
      reused: agent.opened === openedAfterWarmup,
      tookMs,
      outcome,
    };
  } finally {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch {
      // A leaked probe object is swept by the bucket's lifecycle rule; failing
      // the run over the cleanup would lose the measurement it just took.
    }
    client.destroy();
    agent.destroy();
  }
}

const { bucket, bound, gaps } = parseArgs(argv.slice(2));
if (!bucket) {
  stderr.write(
    "Set S3CAB_TEST_BUCKET or pass a bucket name.\n" +
      "Never point this at a real backup bucket.\n",
  );
  exit(2);
}

stdout.write(
  `Probing idle-socket reuse against s3://${bucket}\n` +
    `Agent idle bound: ${bound ? `${bound} ms` : "none (the pre-ADR-0091 default)"}\n` +
    `Gaps: ${gaps.join(", ")} s — about ${Math.round(gaps.reduce((a, b) => a + b, 0) / 60)} min of idling\n\n` +
    "  gap  warm  pooled  reused       took  outcome\n",
);

for (const gapSeconds of gaps) {
  const result = await probe(bucket, gapSeconds, bound);
  stdout.write(
    `${String(result.gapSeconds).padStart(5)}s` +
      `${String(result.warm).padStart(6)}` +
      `${String(result.pooled).padStart(8)}` +
      `${(result.reused ? "yes" : "no").padStart(8)}` +
      `${`${(result.tookMs / 1000).toFixed(2)}s`.padStart(11)}` +
      `  ${result.outcome}\n`,
  );
}

stdout.write(
  "\nwarm 0 anywhere means the instrument is broken, not the connection.\n" +
    "A row with pooled 0 proves nothing — the connection was already gone.\n" +
    "The bound belongs below the first gap where a reused socket stops working.\n",
);
