// The story the user docs tell: one person's photo library, backed up to one
// bucket, followed through time. This is its definition. README.md and every
// guide/*.md page draw their examples from it, and test/doc-examples.test.mjs
// builds each page's scenario from it and fails a page that names a set, a
// bucket, a snapshot or a home folder the story doesn't have. A page changes
// with the story, never past it.
//
// The library exists in two worlds, the same names under a Windows home and a
// POSIX one. A page uses one: Windows, unless a check runs the real CLI on it,
// which only POSIX can reproduce (compare.md, output.md).

export const user = "me";

/** The home in each world. */
export const worlds = {
  windows: { home: `C:\\Users\\${user}`, sep: "\\" },
  posix: { home: `/home/${user}`, sep: "/" },
};

/** @typedef {keyof typeof worlds} World */

/** The folders a page may name directly under the home. */
export const homeFolders = ["Photos", "Documents", "Music", ".s3cab", ".aws"];

export const bucket = "my-backups";

/** The zone LAPTOP's clock keeps, and so the one snapshot names are in. */
export const zone = "Europe/London";

/**
 * The sets in the bucket, each with the folder it backs up and the machine
 * that holds it. `photos` is the one the story follows, and the only set on
 * LAPTOP, so a command there may leave its name out and `find` searches it
 * alone. The other two only share the bucket.
 */
export const sets = {
  photos: { folder: "Photos", by: "me@LAPTOP", os: "win32" },
  documents: { folder: "Documents", by: "me@DESKTOP", os: "linux" },
  music: { folder: "Music", by: "me@DESKTOP", os: "linux" },
};

/**
 * A path in the photos folder, in `world`'s spelling.
 * @param {World} world
 * @param {string} [path] - Relative to the folder, written with `/`
 */
export const photo = (world, path = "") => {
  const { home, sep } = worlds[world];
  return [home, sets.photos.folder, ...(path ? path.split("/") : [])].join(sep);
};

/**
 * A file's content, as `fill` repeated `size` times: the same fill and size
 * is the same content, which is what makes a copy or a move.
 * @typedef {{ fill: string, size: number, mtime: string }} Content
 */

const logo = { fill: "l", size: 41_000, mtime: "2025-03-14T09:00:00.000Z" };

/**
 * What changed at one snapshot, in the files the pages name. `move` is a
 * rename or a move, old path to new. `forgotten` is gone from the bucket;
 * `forget` leaves the local copy, so `find` and `compare` still read it.
 * @typedef {{
 *   name: string,
 *   by: "backup" | "snapshot",
 *   forgotten?: true,
 *   add?: Record<string, Content>,
 *   move?: Record<string, string>,
 *   modify?: Record<string, Content>,
 *   remove?: string[],
 * }} Snapshot
 */

/**
 * The photos set's snapshots, oldest first, named as `backup` names them:
 * local time (`zone`), so `20260612T0915` began 08:15 UTC.
 * @type {Snapshot[]}
 */
export const timeline = [
  // The quick start: the set's first backup.
  {
    name: "20251110T2104",
    by: "backup",
    add: {
      "2019/hike.jpg": {
        fill: "h",
        size: 3_100_000,
        mtime: "2019-08-17T10:22:00.000Z",
      },
      "2019/summit.jpg": {
        fill: "s",
        size: 2_900_000,
        mtime: "2019-08-17T13:05:00.000Z",
      },
      "2024/IMG_001.jpg": {
        fill: "i",
        size: 3_400_000,
        mtime: "2024-07-02T15:40:00.000Z",
      },
      "beach.jpg": {
        fill: "b",
        size: 4_915_200,
        mtime: "2025-06-01T12:00:00.000Z",
      },
      "logo.png": logo,
      "notes.txt": {
        fill: "n",
        size: 2_100,
        mtime: "2025-10-28T19:30:00.000Z",
      },
      "old notes.txt": {
        fill: "o",
        size: 900,
        mtime: "2024-11-02T08:00:00.000Z",
      },
      "report.pdf": {
        fill: "r",
        size: 1_200_000,
        mtime: "2025-11-03T17:45:00.000Z",
      },
    },
  },
  // A tidy-up the next morning.
  {
    name: "20251111T0830",
    by: "backup",
    add: { "brand-logo.png": { ...logo, mtime: "2025-11-11T08:12:00.000Z" } },
    move: { "notes.txt": "diary.txt" },
    modify: {
      "report.pdf": {
        fill: "R",
        size: 1_250_000,
        mtime: "2025-11-11T08:05:00.000Z",
      },
    },
    remove: ["old notes.txt"],
  },
  // A snapshot, not a backup: what compare.md and output.md report.
  {
    name: "20251112T0915",
    by: "snapshot",
    add: {
      "2025/new.jpg": {
        fill: "j",
        size: 812_043,
        mtime: "2025-11-12T08:50:00.000Z",
      },
    },
    move: { "2024/IMG_001.jpg": "2024/sorted/IMG_001.jpg" },
  },
  // Spring: a trip's raw footage arrives, and is edited over three weeks.
  {
    name: "20260501T0800",
    by: "backup",
    forgotten: true,
    add: {
      "raw-footage/clip001.mov": {
        fill: "f",
        size: 161_906_688,
        mtime: "2026-04-26T16:02:00.000Z",
      },
      "raw-footage/clip002.mov": {
        fill: "g",
        size: 158_334_976,
        mtime: "2026-04-26T16:09:00.000Z",
      },
    },
    modify: {
      "diary.txt": {
        fill: "d",
        size: 2_400,
        mtime: "2026-04-30T21:10:00.000Z",
      },
    },
  },
  { name: "20260508T0800", by: "backup", forgotten: true },
  { name: "20260515T0800", by: "backup", forgotten: true },
  // The latest backup when restore.md is read.
  { name: "20260612T0915", by: "backup" },
  // The footage gone from disk, and deleted from the backups (`deleted`).
  {
    name: "20260814T0930",
    by: "backup",
    remove: ["raw-footage/clip001.mov", "raw-footage/clip002.mov"],
  },
];

/**
 * The files the pages name in snapshot `name`, path → content.
 * @param {string} name
 * @returns {Map<string, Content>}
 */
export function filesAt(name) {
  const at = timeline.findIndex((snapshot) => snapshot.name === name);
  if (at < 0) {
    throw new Error(`no snapshot '${name}' in the story`);
  }
  /** @type {Map<string, Content>} */
  const files = new Map();
  for (const {
    add = {},
    move = {},
    modify = {},
    remove = [],
  } of timeline.slice(0, at + 1)) {
    for (const [from, to] of Object.entries(move)) {
      const content = files.get(from);
      if (!content) {
        throw new Error(`the story moves '${from}' before it has one`);
      }
      files.set(to, content);
      files.delete(from);
    }
    for (const [path, content] of Object.entries({ ...add, ...modify })) {
      files.set(path, content);
    }
    for (const path of remove) {
      files.delete(path);
    }
  }
  return files;
}

/**
 * The photos snapshots in the bucket once the May ones are forgotten, newest
 * first, up to and including `until`.
 * @param {string} until
 */
export const backedUp = (until) =>
  timeline
    .filter(
      ({ name, by, forgotten }) =>
        by === "backup" && !forgotten && name <= until,
    )
    .map(({ name }) => name)
    .reverse();

/** The day the raw footage was deleted from every backup. */
export const deleted = "2026-07-19T10:41:07.000Z";

/**
 * The figures the named files can't show: how big the library is, when.
 * The checked transcripts take theirs from here.
 */
export const scale = {
  // 72 of the first backup's files are small copies, so fewer objects.
  firstBackup: {
    files: 1_312,
    bytes: 4_200_000_000,
    objects: 1_240,
    scanMs: 161_000,
    uploadMs: 368_000,
  },
  // By 20260612T0915, 1,313 files plus 214 new photos and the footage.
  files: 1_839,
  footage: { files: 312, objects: 297, bytes: 48_100_000_000 },
  // What only the May snapshots held, exports since remade: what forgetting
  // them makes unrestorable, and the clean-up after it reclaims.
  forgotten: {
    "20260501T0800": { files: 18, bytes: 2_600_000_000 },
    "20260508T0800": { files: 7, bytes: 940_000_000 },
    "20260515T0800": { files: 0, bytes: 0 },
    shared: { files: 23, bytes: 3_100_000_000 },
    objects: 46,
  },
  // Distinct objects each set's snapshots reference, after that clean-up and
  // before the footage is deleted.
  referenced: { photos: 1_754, documents: 6_211, music: 497 },
};
