# An idle connection is thrown away rather than reused, and the retry window runs from the first failure

**Status:** accepted & implemented. Two corrections to the silent-failure path left open by
[0065](0065-s3-client-request-timeouts.md) and [0068](0068-network-retries-above-the-sdk.md) —
neither of which is wrong, and both of which generalized from a link that failed *loudly*.

## Context

A 1.9 TB `backup` of a OneDrive tree died at 99%, nine minutes in, with
`TimeoutError: the request socket timed out after 30000 ms of inactivity` and s3cab's
"your network connection dropped" message.

The connection had not dropped. Three Claude sessions, a browser, a mail client, Discord and
WhatsApp all ran through the whole backup without a hiccup. Nothing in the run's own output
contradicted the diagnosis, and nothing in it supported one either.

What the run *did* record was the shape of its own work. It uploaded **51.3 MB in 9m 10s** across
278,085 files: dedup meant almost every row needed no PUT at all. Set beside
[0069](0069-fused-snapshot-upload-pipeline.md)'s pipeline — strictly sequential, each PUT awaited
before its row is yielded on — that gives a client which holds **one request in flight at most**
and otherwise sits idle for minutes at a time while the pass hashes local files.

Two things were wrong. The measurement below sorts them into the one that explains the failure and
the one that merely made it conceivable.

1. **Nothing bounded how long a pooled socket could sit before reuse.** The SDK's handler pools
   with keep-alive on and evicts nothing of its own: a free socket lives until the peer closes it.
   Writing to one the peer has already closed fails in two flavours, and only one is cheap. If the
   FIN arrived, the write draws `ECONNRESET` — instant, and
   [0068](0068-network-retries-above-the-sdk.md) retries it. If it did not, the request goes into a
   black hole that nothing ends until [0065](0065-s3-client-request-timeouts.md)'s 30 s socket
   timeout fires. The second is the signature this run died with.
2. **The retry window could not absorb that second flavour.** The window was measured from the
   request *starting*. One pass through the relay's `next` is a whole SDK attempt-and-retry cycle
   — up to `maxAttempts` × 30 s — so on a silent socket the first pass alone spent 60–90 s of a
   120 s window. The relay got **one** retry, where the errno flavours 0068 measured get hundreds.
   The same arithmetic made the `Connection lost — waiting for the network` line unreachable on
   this path: it announces from the *second* failure, which by then fell outside the window.

The tempting story is that the first of those explains the run — a client idling for minutes hands
out a long-dead socket on practically every transfer. **It does not, and the probe is what says
so.** S3 closes an idle connection after about five seconds and Node reaps it cleanly, so past
that there is nothing in the pool left to go stale: every gap from 6 s to 300 s opened a fresh
connection and succeeded in a fifth of a second.

What survives is narrower, and cannot be conjured on demand. Reuse can only kill a request when
the peer's close goes **unheard** — which takes a firewall or NAT dropping the flow silently, not
an idle timer — and no ladder of idle gaps produces one to order. The run's own evidence is
consistent with that and does not establish it. So decision 2 below is the fix for what demonstrably
happened; decision 1 is a cheap backstop against the only mechanism that yields the signature.

The run's two `Connection lost` lines and its complete absence of `Back online` lines fit either
reading: something failed loudly twice and was retried, then something failed silently and killed
the run unannounced — unannounced because the announcement sat outside the window too.

### The measurement

`scripts/idle-socket-probe.mjs` is the experiment: warm a connection with one PUT, idle for a gap,
PUT again, and report whether the second went out on the pooled socket, how long it took, and how
it ended. `maxAttempts: 1`, because the SDK's own retries would paper over the failure being
measured. Connections are counted by overriding the agent's `createConnection`, so "reused" is the
TCP connection count rather than an inference; `warm` is the free-pool count taken the instant the
warm-up PUT resolved, and exists because a table of zeroes would otherwise read the same whether
the connection was closed by the peer or never pooled at all.

Against `eu-west-1`, no agent bound (the pre-ADR-0091 default):

| gap | warm | pooled | reused | took | outcome |
| --- | --- | --- | --- | --- | --- |
| 1 s | 1 | 1 | **yes** | 0.08 s | ok |
| 5 s | 1 | 1 | **yes** | 0.37 s | ok |
| 6 s | 1 | 0 | no | 0.18 s | ok |
| 7 s | 1 | 0 | no | 0.16 s | ok |
| 8 s | 1 | 0 | no | 0.18 s | ok |
| 9 s | 1 | 0 | no | 1.16 s | ok |
| 10 s | 1 | 0 | no | 0.16 s | ok |

**The peer's idle close lands in (5 s, 6 s], and Node hears it every time.** The long end adds only
confirmation: 15, 30, 60, 120 and 300 s each reported nothing pooled, a fresh connection, and `ok`
in about a fifth of a second.

Two conclusions follow, and they pull in opposite directions. Reuse beyond ~5 s does not happen on
a healthy link, so the stale-socket hypothesis is **not** the everyday event the first reading made
it; and equally, a bound at 10 s gives up no reuse that this link was ever going to offer.

## Decision

**1. A pooled connection that has sat unused for `IDLE_SOCKET_TIMEOUT_MS` is destroyed rather
than handed out again.** 10 s, passed to the handler as plain agent *options*
(`httpAgent`/`httpsAgent`), which it spreads into the agent it builds — so
`@smithy/node-http-handler` stays unimported, the same reason the timeouts beside it are passed
that way ([0005](0005-builtins-over-dependencies.md)).

- **Why 10 s, when the peer closes at 5.** Deliberately *above* the measured close, because this is
  a backstop and not a competitor to the peer's own housekeeping: on a healthy link it never fires,
  and it fires exactly when the close went unheard. Matching the measured 5 s would weld an s3cab
  constant to an undocumented server-side value that varies by region and provider, and buy nothing
  — the exposure it would shave is the few seconds between the peer's close and ours, on a path
  where reuse in that band does not occur anyway.
- **Why a bound at all, rather than recovering after the fact.** The alternative considered was
  discarding the pool on a network error before retrying. It was rejected: it needs a handle on
  an agent the SDK owns (reaching *through* the boundary s3.mjs exists to be), and once idle
  sockets are evicted the socket that failed was by definition recently active, so a poisoned pool
  is no longer the residual risk. One mechanism, at the point where the staleness is created.
- **Why it costs nothing.** Not "a TLS handshake per request, which is cheap enough" — the
  measurement is stronger than that. s3cab's requests are either back-to-back (a run of files to
  upload, a multipart's parts) or minutes apart while the fused pass hashes rows that dedup away.
  Almost nothing falls in the seconds-wide band the bound governs, and what does was getting a
  fresh connection from the peer regardless.
- **What it is *not*.** It is not a fix validated against the failure it guards. The probe could
  not reproduce a silently-dropped flow, and saying so is the point of recording the measurement at
  all: a future reader deciding whether to keep this should know it rests on mechanism, not on a
  before-and-after.
- **In-flight requests are untouched.** The handler sets its own per-request socket timeout, which
  overrides the agent's for the duration; Node restores the agent's only once the socket is back in
  the pool. The bound sits comfortably above the 3 s the handler defers installing that timeout
  for, so the two never race.

**2. The retry window runs from the first failure, not from the request starting.** Same 120 s
constant, same behaviour on an instant-failure errno. The difference appears only where the failure
is *slow to discover*: a 90 s first pass used to leave 30 s of a 120 s window, enough for one more
pass that could not finish inside it, so the relay effectively got a single retry. Starting the
clock at the failure gives the two minutes to the retrying rather than to the discovering — and it
makes the outage announcement reachable, which on this path it was not.

### Why not shorten the socket timeout

The obvious third change, and it is rejected. Cutting 30 s to 10 s would find a black hole three
times faster, but `socketTimeout` bounds **inactivity on a live request**, and the files this
backup reads come through the Windows Cloud Files filter driver. A local read that stalls longer
than the bound would kill a multipart upload that is perfectly healthy — trading a rare failure
for a routine one, on exactly the data that prompted the work. Decision 2 removes the reason to
want it: the discovery cost no longer comes out of the retry budget.

### Why the error message changed

It opened `Couldn't reach the cloud — your network connection dropped.` and told the reader to get
back online. s3cab cannot know that. All it knows is that one request went unanswered, and a user
whose connection is working will believe the headline and go hunting a fault that isn't there —
this one was diagnosed *despite* the message. It now names the symptom, says the internet may well
be fine, and lists an idle connection quietly closed in between among the causes
([0030](0030-error-message-guidelines.md): plain language, no claim the tool can't support).

## Consequences

- **The pool no longer depends on hearing the peer's close.** That dependency was invisible while
  every close *was* heard, which the measurement shows is the normal case — which is exactly why it
  was worth removing rather than leaving as an unstated assumption.
- **A slow-to-discover failure now gets the tolerance 0068 intended.** More than one retry, and the
  wait announces itself instead of the bar freezing for 90 s and then failing. This is the change
  that would have saved the run that prompted the work.
- **0068's window is unchanged in value and in spirit.** Its measurements were taken against
  instant-failure errnos and remain correct for them; what was wrong was generalizing a window
  measured from request start to a failure mode whose discovery is not instant.
- **Two tests, and the pair is the point.** A behavioural one (a loopback server counting TCP
  connections: idle past the bound opens a new connection, the same gap with a long bound reuses
  one — the control, without which a server-side close would pass just as well) and a value one
  (both schemes carry a bound), because the behavioural test can only drive the http agent while
  every real run uses https. This is 0065's lesson applied — *a value-shaped assertion cannot
  notice that meaning changed* — and its converse.
- **The probe is kept.** `scripts/idle-socket-probe.mjs` re-runs the measurement when a link,
  region or provider changes, and `--bound <ms>` runs it against the fix.
- **Still unfixed, and worth knowing.** `lib/network-status.mjs` promises one message per outage by
  reference-counting the requests waiting it out, which holds only while those requests overlap —
  and [0069](0069-fused-snapshot-upload-pipeline.md)'s sequential pass has one in flight, so the
  count hits zero between them and the same outage is announced again. That is why the run printed
  `Connection lost` twice with no `Back online` between. Cosmetic, left alone here, written up in
  [proposals/output-ux.md](../../proposals/output-ux.md).
