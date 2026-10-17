import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { strayFinders } from "./strays.mjs";

const root = join(realpathSync.native(homedir()), "s3cab.sandbox");
const { strayPath, strayCommand } = strayFinders([root]);

test("a command is reported as the path in it that left the sandbox", () => {
  const command =
    "Get-ChildItem C:\\Windows\\Microsoft.NET\\Framework64 -Directory -ErrorAction SilentlyContinue | % Name; " +
    "Get-ChildItem 'C:\\Program Files','C:\\Program Files (x86)' -Recurse -Filter csc.* | % FullName; " +
    "Get-ChildItem $env:USERPROFILE\\.dotnet -ErrorAction SilentlyContinue | % Name; where.exe pwsh powershell";
  assert.equal(strayCommand(command), "$env:USERPROFILE\\.dotnet");
});

test("a path is a stray in the home folder but not in the sandbox", () => {
  assert.equal(strayPath(join(homedir(), ".dotnet", "x")), true);
  assert.equal(strayPath(join(root, "cleanroom", "x")), false);
});

test("a command reaching the web is reported as its host", () => {
  assert.equal(
    strayCommand("curl -s https://raw.githubusercontent.com/x/y/main/z"),
    "raw.githubusercontent.com",
  );
  assert.equal(
    strayCommand("curl https://b.s3.eu-west-1.amazonaws.com/k"),
    undefined,
  );
});

test("a tilde is home at the end of a command or before a slash, not as awk's operator", () => {
  assert.equal(strayCommand("ls ~/foo"), "~/foo");
  assert.equal(strayCommand("cd ~ && ls"), "~");
  assert.equal(
    strayCommand(
      "aws s3 cp s3://b/k - --quiet | zcat | awk -F'\\t' '$1 ~ /^@SET/ && $2 ~ /DIR/ { print $3 }'",
    ),
    undefined,
  );
});

test("a command running s3cab is reported as that run", () => {
  assert.equal(strayCommand("cd x; npx s3cab --help"), "npx s3cab");
  assert.equal(strayCommand("s3cab restore x"), "s3cab");
  assert.equal(strayCommand("npm view s3cab@latest"), "npm view s3cab");
});

test("s3cab named in prose or a regex isn't a run of it", () => {
  for (const command of [
    "cat > NOTES.md <<'EOF'\nG09: the reference tree also lacks the file,\n     so s3cab withholds too.\ns3cab refuses the snapshot.\nEOF",
    "@'\ns3cab refuses the snapshot.\n'@ | Set-Content NOTES.md",
    "echo 'Refused whole by my restorer (exit 2) and by s3cab (empty reference dir)'",
    "Get-Content x | ? { $_ -notmatch '^  @(CLIENT|SNAPSHOT|S3CAB|SET) ' }",
  ]) {
    assert.equal(strayCommand(command), undefined, command);
  }
});
