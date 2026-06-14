import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectEntries } from "./restore.mjs";

// `selectEntries` is the pure path-filter selector behind `restore [paths…]`.
// Paths are written with forward slashes: on POSIX they are native, and on
// Windows `normalize` converts both separators to `/`, so these cases exercise
// the same matching on every OS (the win32-only case/separator behaviour gets
// its own guarded tests below).
const paths = [
  "/home/me/Photos/beach.jpg",
  "/home/me/Photos/2024/ski.jpg",
  "/home/me/PhotosArchive/old.jpg",
  "/home/me/Docs/cv.pdf",
];

describe("selectEntries", () => {
  it("returns every path, in order, when there are no filters", () => {
    assert.deepEqual(selectEntries(paths, []), paths);
  });

  it("treats blank/separator-only filters as no filter", () => {
    assert.deepEqual(selectEntries(paths, ["", "/"]), paths);
  });

  it("matches a path exactly", () => {
    assert.deepEqual(selectEntries(paths, ["/home/me/Docs/cv.pdf"]), [
      "/home/me/Docs/cv.pdf",
    ]);
  });

  it("matches everything under a folder filter", () => {
    assert.deepEqual(selectEntries(paths, ["/home/me/Photos"]), [
      "/home/me/Photos/beach.jpg",
      "/home/me/Photos/2024/ski.jpg",
    ]);
  });

  it("respects the /-boundary so a sibling prefix does not match", () => {
    // `/home/me/Photos` must not pull in `/home/me/PhotosArchive/old.jpg`.
    assert.deepEqual(selectEntries(paths, ["/home/me/Photos"]), [
      "/home/me/Photos/beach.jpg",
      "/home/me/Photos/2024/ski.jpg",
    ]);
  });

  it("ignores a trailing separator on the filter", () => {
    assert.deepEqual(selectEntries(paths, ["/home/me/Photos/"]), [
      "/home/me/Photos/beach.jpg",
      "/home/me/Photos/2024/ski.jpg",
    ]);
  });

  it("unions multiple filters, keeping input order and no duplicates", () => {
    assert.deepEqual(
      selectEntries(paths, ["/home/me/Docs", "/home/me/Photos/2024"]),
      ["/home/me/Photos/2024/ski.jpg", "/home/me/Docs/cv.pdf"],
    );
  });

  it("selects nothing when no path matches", () => {
    assert.deepEqual(selectEntries(paths, ["/home/me/Music"]), []);
  });

  const onWin32 = process.platform === "win32";

  it("is case-insensitive on Windows, case-sensitive elsewhere", () => {
    const got = selectEntries(paths, ["/HOME/ME/photos"]);
    if (onWin32) {
      assert.deepEqual(got, [
        "/home/me/Photos/beach.jpg",
        "/home/me/Photos/2024/ski.jpg",
      ]);
    } else {
      assert.deepEqual(got, []);
    }
  });

  it(
    "accepts backslash paths and filters on Windows",
    { skip: !onWin32 },
    () => {
      const winPaths = ["C:\\Users\\me\\Photos\\beach.jpg"];
      assert.deepEqual(
        selectEntries(winPaths, ["C:\\Users\\me\\Photos"]),
        winPaths,
      );
      // A user who types forward slashes on Windows matches the same files.
      assert.deepEqual(
        selectEntries(winPaths, ["C:/Users/me/Photos"]),
        winPaths,
      );
    },
  );
});
