import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { progressLine } from "./snapshot.mjs";

// The fused pass's one progress line (ADR-0069). `progressLine` takes the width
// and the activities' state rather than reading a terminal or a clock of its
// own, so both the wording and the trimming are assertable off a TTY.

const start = Temporal.Now.instant();
const run = { current: 4182, total: 58310, start };

/**
 * A transfer that began long enough ago to be worth reporting, of a file this
 * run hashed unless `hashed` says otherwise.
 * @param {{ path: string, loaded: number, total: number, hashed?: boolean }} current
 */
const sending = (current) => ({
  sent: 1_200_000_000,
  current: { startedAt: performance.now() - 2000, hashed: true, ...current },
});

/**
 * A hash that began long enough ago to be worth reporting. It carries no path,
 * as `fileProps`' does not: the line names it from `currentFile`.
 * @param {number} size
 * @param {number} done - Bytes read so far
 */
const hashing = (size, done) => ({
  size,
  startedAt: performance.now() - 2000,
  read: () => done,
});

describe("progressLine", () => {
  it("starts the path at the same column however long the detail is", () => {
    // The detail follows the path, so `[999.9MB hashed, sending 100%]` — the longest
    // it gets — must leave the path where `[1B hashing]` does.
    const widest = progressLine({
      ...run,
      state: sending({
        path: "/a.jpg",
        loaded: 999_900_000,
        total: 999_900_000,
      }),
      width: 200,
    });
    const shortest = progressLine({
      ...run,
      // Same run stats, so only the activity differs between the two lines.
      state: { sent: 1_200_000_000, current: null },
      currentFile: "/a.jpg",
      hashing: hashing(1, 0),
      width: 200,
    });
    assert.equal(widest.indexOf("/a.jpg"), shortest.indexOf("/a.jpg"));
  });

  it("pads the count to its total, so the columns after it hold still", () => {
    // No label: the pass announced itself once, before the line started.
    const line = progressLine(run);
    assert.equal(line, "     0s   4,182/58,310");
  });

  it("shows how far along it is in bytes, which is what the wait is made of", () => {
    const line = progressLine({
      ...run,
      bytesDone: 900_000_000,
      bytesTotal: 2_400_000_000,
    });
    assert.equal(line, "     0s   4,182/58,310   37% of 2.4GB");
  });

  it("claims no percentage on a first run, which has no baseline to size it", () => {
    // The denominator is the previous snapshot's sizes, so a first backup has
    // none. Counting bytes read against a total of nothing would be 100% from
    // the first file — worse than saying nothing, so it says nothing.
    const line = progressLine({
      ...run,
      bytesDone: 900_000_000,
      bytesTotal: 0,
    });
    assert.equal(line, "     0s   4,182/58,310");
  });

  it("grows the total rather than promise a finish it cannot deliver", () => {
    // New files aren't in the baseline, so a pass can read more than the total
    // predicted. The estimate corrects itself upward — the percentage slows
    // down, and never goes past 100.
    const line = progressLine({
      ...run,
      bytesDone: 3_000_000_000,
      bytesTotal: 2_400_000_000,
    });
    assert.equal(line, "     0s   4,182/58,310  100% of 3.0GB");
  });

  it("holds the columns after it still as the percentage gains a digit", () => {
    const early = progressLine({
      ...run,
      bytesDone: 24_000_000,
      bytesTotal: 2_400_000_000,
      state: { sent: 1_200_000_000, current: null },
    });
    const late = progressLine({
      ...run,
      bytesDone: 2_400_000_000,
      bytesTotal: 2_400_000_000,
      state: { sent: 1_200_000_000, current: null },
    });
    assert.equal(early.indexOf("Uploaded"), late.indexOf("Uploaded"));
  });

  it("holds Uploaded and the path still as the bytes sent and the time grow", () => {
    // The clause is padded on its right, so it grows into its own slack: the
    // label never creeps left and the path never shifts right.
    const path = "D:\\Pictures\\a.jpg";
    const early = progressLine({
      ...run,
      bytesDone: 1,
      bytesTotal: 1_900_000_000_000,
      state: { sent: 0, current: null },
      currentFile: path,
      width: 200,
    });
    const late = progressLine({
      ...run,
      start: start.subtract({ hours: 99, minutes: 59 }),
      bytesDone: 1,
      bytesTotal: 1_900_000_000_000,
      state: { sent: 999_900_000, current: null },
      currentFile: path,
      width: 200,
    });
    assert.match(late, /^99h 59m .*\(Uploaded 999\.9MB\)/, late);
    assert.equal(early.indexOf("Uploaded"), late.indexOf("Uploaded"));
    assert.equal(early.indexOf(path), late.indexOf(path));
  });

  it("adds the bytes gone up when the pass is also sending", () => {
    const line = progressLine({
      ...run,
      state: { sent: 1_200_000_000, current: null },
    });
    assert.equal(line, "     0s   4,182/58,310  (Uploaded 1.2GB)");
  });

  it("names a multipart upload with its size and a parenthetical percentage", () => {
    const line = progressLine({
      ...run,
      state: sending({
        path: "D:\\Videos\\holiday.MOV",
        loaded: 1_320_000_000,
        total: 2_400_000_000,
      }),
    });
    assert.match(
      line,
      / {2}D:\\Videos\\holiday\.MOV {2}\[2\.4GB hashed, sending 55%\]$/,
      line,
    );
  });

  it("claims no hash for a send whose hash this run reused", () => {
    // A resumed backup, or a file whose object went missing from the bucket:
    // the hash came from the baseline, so the only step that happened is the send.
    const line = progressLine({
      ...run,
      state: sending({
        path: "D:\\Videos\\holiday.MOV",
        loaded: 1_320_000_000,
        total: 2_400_000_000,
        hashed: false,
      }),
    });
    assert.match(
      line,
      / {2}D:\\Videos\\holiday\.MOV {2}\[2\.4GB sending 55%\]$/,
      line,
    );
  });

  it("claims no percentage for a single PUT, which reports only at the end", () => {
    // Below the multipart threshold `loaded` stays 0 for the whole transfer, so
    // "0%" would dress up "nothing has come back yet" as a measurement.
    const line = progressLine({
      ...run,
      state: sending({
        path: "D:\\Pictures\\P1060735.JPG",
        loaded: 0,
        total: 1_500_000,
      }),
    });
    assert.ok(!line.includes("%"), `got ${line}`);
    assert.match(
      line,
      / {2}D:\\Pictures\\P1060735\.JPG {2}\[1\.5MB hashed, sending\]$/,
      line,
    );
  });

  it("names a slow hash the same way, from the bytes read so far", () => {
    const line = progressLine({
      ...run,
      currentFile: "D:\\Scans\\big.psd",
      hashing: hashing(1_800_000_000, 864_000_000),
    });
    assert.match(
      line,
      / {2}D:\\Scans\\big\.psd {2}\[1\.8GB hashing 48%\]$/,
      line,
    );
  });

  it("measures nothing for work that has not been going a second", () => {
    // The rule that keeps tens of thousands of fast files from flickering
    // figures past: a row earns a *verb and a size* by taking long enough for
    // them to be read. It no longer decides whether the file is named — the
    // next test is the other half of that.
    const justStarted = {
      sent: 0,
      current: {
        path: "D:\\Pictures\\quick.jpg",
        loaded: 0,
        total: 1_500_000,
        startedAt: performance.now(),
        hashed: true,
      },
    };
    const line = progressLine({ ...run, state: justStarted });
    assert.equal(line, "     0s   4,182/58,310  (Uploaded 0B)");
  });

  it("names the file in hand even when nothing has earned a measurement", () => {
    // The case the whole line used to go blank on: a set of small files, none
    // of them slow enough to be measured, so for hours the detail column said
    // nothing at all and the line read as hung.
    const line = progressLine({
      ...run,
      currentFile: "D:\\OneDrive\\Documents\\notes.txt",
    });
    assert.match(line, /notes\.txt$/, line);
    assert.ok(!line.includes("hashing"), `nothing was measured, got ${line}`);
  });

  it("holds the path column still whether or not a verb has joined it", () => {
    // The reason the empty text still pads: a file that gets slow enough to be
    // measured mid-read must not shunt its own path sideways as it does.
    const bare = progressLine({
      ...run,
      currentFile: "D:\\Scans\\big.psd",
      width: 200,
    });
    const measured = progressLine({
      ...run,
      currentFile: "D:\\Scans\\big.psd",
      hashing: hashing(1_800_000_000, 864_000_000),
      width: 200,
    });
    assert.equal(
      bare.indexOf("D:\\Scans\\big.psd"),
      measured.indexOf("D:\\Scans\\big.psd"),
    );
  });

  it("prefers the measured detail to the bare path", () => {
    const line = progressLine({
      ...run,
      currentFile: "D:\\Scans\\big.psd",
      hashing: hashing(1_800_000_000, 864_000_000),
    });
    assert.match(
      line,
      / {2}D:\\Scans\\big\.psd {2}\[1\.8GB hashing 48%\]$/,
      line,
    );
  });

  it("ends at the figures when a bare path will not fit, not at blank space", () => {
    // A measured detail still says something with its path shed; a bare path is
    // *only* the path, so there is nothing left to print — and the line has to
    // end there rather than at the two spaces that would have preceded it.
    const line = progressLine({
      ...run,
      currentFile: "D:\\OneDrive\\Documents\\notes.txt",
      // Under `MIN_PATH_COLUMNS` of room, where even an elided tail is rubble.
      width: 32,
    });
    assert.equal(line, "     0s   4,182/58,310");
  });

  it("keeps the end of a path too long for the line", () => {
    const line = progressLine({
      ...run,
      state: sending({
        path: "D:\\OneDrive\\Pictures\\Australia 2016\\IMG_20160117_104801.jpg",
        loaded: 1_100_000,
        total: 2_200_000,
      }),
      width: 110,
    });
    assert.ok(
      line.length < 110,
      `expected under 110 columns, got ${line.length}`,
    );
    assert.ok(
      line.endsWith("IMG_20160117_104801.jpg  [2.2MB hashed, sending 50%]"),
      `expected the file name to survive, got ${line}`,
    );
  });

  it("drops the path rather than print a stub of it, and keeps the figures", () => {
    const line = progressLine({
      ...run,
      state: sending({
        path: "/some/very/long/path.jpg",
        loaded: 0,
        total: 1_500_000,
      }),
      width: 75,
    });
    assert.ok(
      line.length < 75,
      `expected under 75 columns, got ${line.length}`,
    );
    // Ending on the figures is itself the proof no path stub followed them.
    assert.match(line, /\[1\.5MB hashed, sending\]$/, line);
  });

  it("keeps the figures at the width where they fit exactly without a path", () => {
    // The boundary: at this width the detail fills the room left exactly, and
    // one column fewer sheds it.
    const state = sending({
      path: "/some/very/long/path.jpg",
      loaded: 0,
      total: 1_500_000,
    });
    const exact = progressLine({ ...run, state, width: 66 });
    assert.match(exact, /\[1\.5MB hashed, sending\]$/, exact);
    assert.equal(exact.length, 65);
    const narrower = progressLine({ ...run, state, width: 65 });
    assert.match(narrower, /\(Uploaded 1\.2GB\)$/, narrower);
  });

  it("sheds the whole detail when even the figures will not fit", () => {
    const line = progressLine({
      ...run,
      state: sending({
        path: "/some/very/long/path.jpg",
        loaded: 0,
        total: 1_500_000,
      }),
      width: 50,
    });
    assert.ok(
      line.length < 50,
      `expected under 50 columns, got ${line.length}`,
    );
    assert.match(line, /\(Uploaded 1\.2GB\)$/, line);
  });

  it("says it is stopping, and keeps measuring what the stop is waiting for", () => {
    // Both halves matter. The stop has to be on the line the eye is already on,
    // because the handler's own message is a line that scrolls; and the file in
    // flight has to keep reporting, because that percentage is what tells the
    // user whether to wait or press Ctrl+C again.
    const state = sending({
      path: "/some/video.mp4",
      loaded: 550_000_000,
      total: 1_000_000_000,
    });
    const line = progressLine({ ...run, state, stopping: true, width: 200 });
    assert.ok(line.includes("Stopping…"), line);
    assert.ok(
      line.endsWith("/some/video.mp4  [1.0GB hashed, sending 55%]"),
      line,
    );
  });

  it("keeps the stop when the width leaves room for nothing else", () => {
    // The shed order, from the other end: a stop is in the figures precisely so
    // the narrowest terminal keeps it, where the detail and the path are gone.
    const state = sending({
      path: "/some/very/long/path.jpg",
      loaded: 0,
      total: 1_500_000,
    });
    const line = progressLine({ ...run, state, stopping: true, width: 55 });
    assert.ok(
      line.length < 55,
      `expected under 55 columns, got ${line.length}`,
    );
    assert.match(line, /Stopping…$/, line);
  });
});
