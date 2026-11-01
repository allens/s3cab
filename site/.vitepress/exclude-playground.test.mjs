import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { excludeReport } from "./exclude-playground.mjs";
import starter from "./starter-exclude.data.mjs";

/** @import { Platform } from "./exclude-playground.mjs" */

/**
 * Each path that is left out, with the pattern that left it out; kept paths
 * are absent.
 * @param {string[]} patterns
 * @param {string[]} paths
 * @param {Platform} [platform]
 */
const leftOut = (patterns, paths, platform = "linux") =>
  Object.fromEntries(
    excludeReport(patterns.join("\n"), paths.join("\n"), platform)
      .filter(({ pattern }) => pattern)
      .map(({ path, pattern }) => [path, pattern]),
  );

describe("excludeReport", () => {
  // guide/exclude.md, "Examples": each pattern against the paths it names, and
  // a near miss that must be kept.
  it("gives guide/exclude.md's examples their documented results", () => {
    assert.deepEqual(
      leftOut(
        ["Tests/**/*.js"],
        [
          "Tests/HelloWorld.js",
          "Tests/UI/HelloWorld.js",
          "Tests/UI/Feature1/HelloWorld.js",
          "HelloWorld.js",
        ],
      ),
      {
        "Tests/HelloWorld.js": "Tests/**/*.js",
        "Tests/UI/HelloWorld.js": "Tests/**/*.js",
        "Tests/UI/Feature1/HelloWorld.js": "Tests/**/*.js",
      },
    );
    assert.deepEqual(
      leftOut(
        ["**/log.txt"],
        ["log.txt", "Tests/log.txt", "Tests/UI/log.txt", "Tests/catalog.txt"],
      ),
      {
        "log.txt": "**/log.txt",
        "Tests/log.txt": "**/log.txt",
        "Tests/UI/log.txt": "**/log.txt",
      },
    );
    assert.deepEqual(
      leftOut(
        ["**/node_modules/"],
        [
          "node_modules/",
          "app/node_modules/",
          "app/web/node_modules/",
          "node_modules",
        ],
      ),
      {
        "node_modules/": "**/node_modules/",
        "app/node_modules/": "**/node_modules/",
        "app/web/node_modules/": "**/node_modules/",
      },
    );
    assert.deepEqual(leftOut(["build/"], ["build/", "app/build/", "build"]), {
      "build/": "build/",
    });
    assert.deepEqual(
      leftOut(
        ["logs/**"],
        ["logs/", "logs/a.txt", "logs/2026/a.txt", "logsheet.txt"],
      ),
      {
        "logs/": "logs/**",
        "logs/a.txt": "logs/**",
        "logs/2026/a.txt": "logs/**",
      },
    );
  });

  it("anchors a pattern to the member directory, and `*` needs a character", () => {
    const paths = ["a.log", "sub/a.log", ".log"];
    assert.deepEqual(leftOut(["*.log"], paths), { "a.log": "*.log" });
    assert.deepEqual(leftOut(["**/*.log"], paths), {
      "a.log": "**/*.log",
      "sub/a.log": "**/*.log",
    });
  });

  it("leaves out everything in a left-out folder, naming the outermost one", () => {
    assert.deepEqual(
      excludeReport("a/b/\na/", "a/b/c.txt\na/\nd/e.txt", "linux"),
      [
        { path: "a/b/c.txt", pattern: "a/", folder: "a/" },
        { path: "a/", pattern: "a/" },
        { path: "d/e.txt" },
      ],
    );
  });

  it("reads a typed path as the walk would spell it: trimmed, `.` and repeated or leading separators dropped", () => {
    assert.deepEqual(
      excludeReport(
        "*.log\nbuild/",
        "./a.log\n/build/\n  c.log  \nsub//d.log\n./build/x.js",
        "linux",
      ),
      [
        { path: "./a.log", pattern: "*.log" },
        { path: "/build/", pattern: "build/" },
        { path: "c.log", pattern: "*.log" },
        { path: "sub//d.log" },
        { path: "./build/x.js", pattern: "build/", folder: "build/" },
      ],
    );
  });

  it("names the first pattern that matches", () => {
    assert.deepEqual(leftOut(["*.log", "**/*"], ["a.log"]), {
      "a.log": "*.log",
    });
    assert.deepEqual(leftOut(["**/*", "*.log"], ["a.log"]), {
      "a.log": "**/*",
    });
  });

  it("reads the patterns as an exclude.txt: comments and blank lines skipped, lines trimmed", () => {
    assert.deepEqual(
      leftOut(
        ["# a.log", "", "   # b.log", "  c.log  "],
        ["a.log", "b.log", "c.log"],
      ),
      { "c.log": "c.log" },
    );
  });

  it("ignores case on Windows and macOS, and not on Linux", () => {
    const paths = ["Pics/thumbs.db"];
    const verdict = { "Pics/thumbs.db": "**/Thumbs.db" };
    assert.deepEqual(leftOut(["**/Thumbs.db"], paths, "win32"), verdict);
    assert.deepEqual(leftOut(["**/Thumbs.db"], paths, "darwin"), verdict);
    assert.deepEqual(leftOut(["**/Thumbs.db"], paths, "linux"), {});
  });

  it("takes `\\` as a separator on Windows, and as a filename character elsewhere", () => {
    const paths = ["photos/raw/", "photos\\raw\\a.jpg"];
    assert.deepEqual(leftOut(["photos\\raw/"], paths, "win32"), {
      "photos/raw/": "photos\\raw/",
      "photos\\raw\\a.jpg": "photos\\raw/",
    });
    assert.deepEqual(leftOut(["photos\\raw/"], paths, "linux"), {});
    assert.deepEqual(leftOut(["photos\\raw/"], paths, "darwin"), {});
  });

  it("ignores how an accent is spelled on macOS only", () => {
    const pattern = "café.txt".normalize("NFC");
    const path = "café.txt".normalize("NFD");
    assert.deepEqual(leftOut([pattern], [path], "darwin"), { [path]: pattern });
    assert.deepEqual(leftOut([pattern], [path], "win32"), {});
    assert.deepEqual(leftOut([pattern], [path], "linux"), {});
  });

  it("starts from the starter exclude.txt, written with `/`", () => {
    const patterns = starter.load();
    assert.doesNotMatch(patterns, /\\/);
    for (const platform of /** @type {Platform[]} */ ([
      "win32",
      "darwin",
      "linux",
    ])) {
      assert.deepEqual(
        excludeReport(
          patterns,
          "app/node_modules/x/index.js\napp/.git/\nPics/Thumbs.db\nPics/beach.jpg",
          platform,
        ),
        [
          {
            path: "app/node_modules/x/index.js",
            pattern: "**/node_modules/",
            folder: "app/node_modules/",
          },
          { path: "app/.git/", pattern: "**/.git/" },
          { path: "Pics/Thumbs.db", pattern: "**/Thumbs.db" },
          { path: "Pics/beach.jpg" },
        ],
      );
    }
  });
});
