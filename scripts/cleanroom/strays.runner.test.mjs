import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { exampleRoot } from "./cleanroom.mjs";

// strays.mjs reads the runner's places as it loads, so they are set first and the module
// imported after: RUNNER_TEMP, and a temp reached through an alias of home, as a Windows
// runner's is through the 8.3 `C:\Users\RUNNER~1`. A junction stands in for the alias,
// named unlike one: Windows may already have given `runneradmin` that 8.3 name.
const work = resolve("/s3cab-runner-work");
process.env.RUNNER_TEMP = join(work, "_temp");
const base = realpathSync.native(mkdtempSync(join(tmpdir(), "s3cab-strays-")));
after(() => rmSync(base, { recursive: true, force: true }));
const home = join(base, "runneradmin");
mkdirSync(join(home, "AppData", "Local", "Temp"), { recursive: true });
const alias = join(base, "home-alias");
symlinkSync(home, alias, "junction");
const temp = join(alias, "AppData", "Local", "Temp");
process.env.HOME = process.env.USERPROFILE = home;
process.env.TMPDIR = process.env.TEMP = process.env.TMP = temp;
const { strayFinders } = await import("./strays.mjs");
const { strayPath, strayCommand } = strayFinders(
  [join(exampleRoot, "cleanroom")],
  exampleRoot,
);

test("on a runner, its work folder is watched: the checkout and RUNNER_TEMP", () => {
  const payload = join(work, "_temp", "_github_workflow", "event.json");
  assert.equal(strayCommand(`Get-Content ${payload}`), payload);
  assert.equal(strayPath(join(work, "s3cab", "s3cab", "package.json")), true);
  const beside = join(resolve("/s3cab-runner-elsewhere"), "x");
  assert.equal(strayCommand(`Get-Content ${beside}`), undefined);
  assert.equal(strayPath(beside), false);
  // A watched place is a whole component: `D:\a` doesn't watch `D:\apps`.
  const sibling = join(`${work}-apps`, "x");
  assert.equal(strayCommand(`Get-ChildItem ${sibling}`), undefined);
});

test("home spelled the way temp spells it is home too", () => {
  for (const root of [alias, home]) {
    const keys = join(root, ".aws", "credentials");
    assert.equal(strayCommand(`Get-Content ${keys}`), keys);
    assert.equal(strayPath(keys), true);
  }
});

test("a watched place followed by a glob, a brace, a colon or a trailing dot is still named", () => {
  for (const command of [
    `ls ${home}*`,
    `Invoke-Command {Get-ChildItem ${home}}`,
    `cp ${home}{/.aws/credentials,} .`,
    `PYTHONPATH=${home}:x py`,
    `Get-Content ${join(`${home}.`, ".aws", "credentials")}`,
  ]) {
    assert.notEqual(strayCommand(command), undefined, command);
  }
  assert.equal(strayCommand(`ls ${home}.old`), undefined);
});
