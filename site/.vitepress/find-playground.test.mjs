import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findReport } from "./find-playground.mjs";

/**
 * The paths `pattern` matches, out of `paths`.
 * @param {string} pattern
 * @param {string[]} paths
 */
const matched = (pattern, paths) =>
  findReport(pattern, paths.join("\n"))
    .paths.filter((path) => path.matchedBy.length > 0)
    .map((path) => path.path);

// guide/find.md's examples, each against a Windows, a share and a POSIX path.
describe("guide/find.md's patterns", () => {
  it("a file name matches that name in any directory", () => {
    assert.deepEqual(
      matched("aws-keys.txt", [
        String.raw`C:\Users\me\secretsdir\aws-keys.txt`,
        String.raw`\\nas\home\aws-keys.txt`,
        "/home/me/secretsdir/aws-keys.txt",
        "/home/me/aws-keys.txt.bak",
        "/home/me/old-aws-keys.txt",
      ]),
      [
        String.raw`C:\Users\me\secretsdir\aws-keys.txt`,
        String.raw`\\nas\home\aws-keys.txt`,
        "/home/me/secretsdir/aws-keys.txt",
      ],
    );
  });

  it("*.mov matches every .mov file, in any case", () => {
    assert.deepEqual(
      matched("*.mov", [
        String.raw`D:\Videos\2019\hike.MOV`,
        "/Users/me/Movies/beach.mov",
        "/home/me/Videos/beach.mp4",
        "/home/me/Videos/.mov",
      ]),
      [String.raw`D:\Videos\2019\hike.MOV`, "/Users/me/Movies/beach.mov"],
    );
  });

  it("a path fragment matches at any depth, segments aligned", () => {
    assert.deepEqual(
      matched("Documents/tax", [
        String.raw`C:\Users\me\Documents\tax`,
        "/home/me/documents/tax",
        "/home/me/Documents/old/tax",
        "/home/me/MyDocuments/tax",
        "/home/me/Documents/tax/2019.pdf",
      ]),
      [String.raw`C:\Users\me\Documents\tax`, "/home/me/documents/tax"],
    );
  });

  it("a trailing separator matches everything beneath that directory", () => {
    assert.deepEqual(
      matched("secretsdir/", [
        String.raw`C:\Users\me\secretsdir\aws-keys.txt`,
        String.raw`\\nas\home\secretsdir\deep\id_rsa`,
        "/home/me/secretsdir/aws-keys.txt",
        "/home/me/secretsdir",
        "/home/me/not-secretsdir/aws-keys.txt",
      ]),
      [
        String.raw`C:\Users\me\secretsdir\aws-keys.txt`,
        String.raw`\\nas\home\secretsdir\deep\id_rsa`,
        "/home/me/secretsdir/aws-keys.txt",
      ],
    );
  });

  it("* is one or more characters, so *keys.txt misses keys.txt", () => {
    assert.deepEqual(
      matched("*keys.txt", [
        String.raw`C:\Users\me\aws-keys.txt`,
        String.raw`C:\Users\me\keys.txt`,
        "/home/me/keys.txt",
      ]),
      [String.raw`C:\Users\me\aws-keys.txt`],
    );
    assert.deepEqual(
      matched("*secret1", ["/home/me/copy-secret1", "/home/me/secret1"]),
      ["/home/me/copy-secret1"],
    );
  });

  it("case never matters, on any system", () => {
    assert.deepEqual(
      matched("photos/", [
        "/home/me/Photos/beach.jpg",
        String.raw`C:\Users\me\PHOTOS\beach.jpg`,
      ]),
      ["/home/me/Photos/beach.jpg", String.raw`C:\Users\me\PHOTOS\beach.jpg`],
    );
  });
});

describe("findReport", () => {
  it("reads a backslash by the path's shape: a separator only on Windows", () => {
    assert.deepEqual(
      matched("name.txt", [
        String.raw`C:\Users\me\odd\name.txt`,
        String.raw`/home/me/odd\name.txt`,
      ]),
      [String.raw`C:\Users\me\odd\name.txt`],
    );
  });

  it("names every pattern that matches a path, in input order", () => {
    const report = findReport(
      "*.jpg\nnothing-here\nPhotos/",
      "/home/me/Photos/beach.jpg\n/home/me/notes.txt",
    );
    assert.deepEqual(report.paths, [
      { path: "/home/me/Photos/beach.jpg", matchedBy: ["*.jpg", "Photos/"] },
      { path: "/home/me/notes.txt", matchedBy: [] },
    ]);
  });

  it("reports a pattern s3cab would refuse, and still matches the rest", () => {
    const report = findReport("/\nbeach.jpg", "/home/me/beach.jpg");
    assert.equal(report.patterns[0]?.pattern, "/");
    assert.match(report.patterns[0]?.error ?? "", /nothing to search for/);
    assert.deepEqual(report.patterns[1], { pattern: "beach.jpg" });
    assert.deepEqual(report.paths[0]?.matchedBy, ["beach.jpg"]);
  });

  it("skips blank lines and takes Windows line endings", () => {
    const report = findReport("\r\n*.jpg\r\n  \r\n", "a.jpg\r\n\r\n/b.jpg\r\n");
    assert.deepEqual(
      report.patterns.map((pattern) => pattern.pattern),
      ["*.jpg"],
    );
    assert.deepEqual(
      report.paths.map((path) => path.path),
      ["a.jpg", "/b.jpg"],
    );
  });
});
