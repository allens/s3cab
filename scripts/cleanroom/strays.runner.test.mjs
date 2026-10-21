import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { exampleRoot } from "./cleanroom.mjs";

// strays.mjs reads RUNNER_TEMP as it loads, so it is set first and the module imported after.
const work = resolve("/s3cab-runner-work");
process.env.RUNNER_TEMP = join(work, "_temp");
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
});
