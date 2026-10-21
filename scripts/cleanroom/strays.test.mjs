import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { exampleRoot } from "./cleanroom.mjs";
import { strayFinders } from "./strays.mjs";

// An allowed place in the home folder, as the session's scratchpad is in temp: what the
// `..` rule exists for.
const root = join(realpathSync.native(homedir()), "s3cab.sandbox");
const { strayPath, strayCommand } = strayFinders([root], root);

test("the sandbox root is watched for the file tools, outside its clean room", () => {
  const sandbox = strayFinders([join(exampleRoot, "cleanroom")], exampleRoot);
  assert.equal(sandbox.strayPath(join(exampleRoot, ".s3cab", "sets")), true);
  assert.equal(
    sandbox.strayPath(join(exampleRoot, "reference-exits.json")),
    true,
  );
  assert.equal(
    sandbox.strayPath(join(exampleRoot, "cleanroom", "main.c")),
    false,
  );
  // Not in commands, where the clean room's own path beside a `..` would be kept.
  assert.equal(
    sandbox.strayCommand(`cd ${exampleRoot}/cleanroom && cc main.c ../x.c`),
    undefined,
  );
});

test("a command is reported as the path in it that left the sandbox", () => {
  const command =
    "Get-ChildItem C:\\Windows\\Microsoft.NET\\Framework64 -Directory -ErrorAction SilentlyContinue | % Name; " +
    "Get-ChildItem 'C:\\Program Files','C:\\Program Files (x86)' -Recurse -Filter csc.* | % FullName; " +
    "Get-ChildItem $env:USERPROFILE\\.dotnet -ErrorAction SilentlyContinue | % Name; where.exe pwsh powershell";
  assert.equal(strayCommand(command), "$env:USERPROFILE\\.dotnet");
});

test("a path is a stray in the home folder but not in the sandbox", () => {
  assert.equal(strayPath(join(homedir(), ".dotnet", "x")), true);
  assert.equal(strayPath(join(homedir(), "..notes", "x")), true);
  assert.equal(strayPath(join(root, "cleanroom", "x")), false);
});

test(
  "on Windows, a path is read as Windows opens it",
  { skip: process.platform !== "win32" },
  () => {
    assert.equal(strayPath(resolve(`${homedir()}.\\.aws\\credentials`)), true);
    assert.equal(strayPath(resolve(`${homedir()} \\.aws\\credentials`)), false);
    assert.equal(strayPath(resolve(`${homedir()}2\\.aws\\credentials`)), false);
    // Beside the sandbox, not in it.
    for (const path of [`${root} \\x`, `${root}..\\x`, `${root}. \\x`]) {
      assert.equal(strayPath(resolve(path)), true, path);
    }
    assert.equal(strayPath(resolve(`${root}.\\x`)), false);
    assert.equal(strayPath(resolve(`${root}\\...\\x`)), false);
    assert.equal(strayPath(resolve(`${root}\\x. .`)), false);
  },
);

test("a command naming the sandbox is a stray only once it leaves it", () => {
  assert.equal(strayCommand("ls ~/s3cab.sandbox/cleanroom"), undefined);
  for (const path of [
    "~/s3cab.sandbox/../.aws/credentials",
    "$env:USERPROFILE\\s3cab.sandbox\\..\\.s3cab\\sets\\x",
    "~/s3cab.sandbox.old/cleanroom",
  ]) {
    assert.equal(strayCommand(`cat ${path}`), path);
  }
});

test("a command holding `..` keeps the sandbox path it names, however it climbs", () => {
  for (const [command, reported] of /** @type {[string, string][]} */ ([
    [
      'cat "$HOME/s3cab.sandbox/my dir/../../.aws/credentials"',
      "$HOME/s3cab.sandbox/my",
    ],
    [
      "cat ~/s3cab.sandbox/my\\ dir/../../.aws/credentials",
      "~/s3cab.sandbox/my\\",
    ],
    [
      'dotnet run -- "--out=~/s3cab.sandbox/my dir/../../.aws/credentials"',
      "~/s3cab.sandbox/my",
    ],
    [
      "Get-Content (Join-Path ~/s3cab.sandbox work/../../.aws/credentials)",
      "~/s3cab.sandbox",
    ],
    ["cd ~/s3cab.sandbox; echo hi >../leak.txt", "~/s3cab.sandbox"],
    [
      "cd ~/s3cab.sandbox; cd..; Get-Content .aws/credentials",
      "~/s3cab.sandbox",
    ],
    [
      "Set-Location ~/s3cab.sandbox; Get-Content -Path:..\\.aws\\credentials",
      "~/s3cab.sandbox",
    ],
    ["cat ~/s3cab.sandbox/{..,}/.aws/credentials", "~/s3cab.sandbox/{.."],
    [
      "cat ~/s3cab.sandbox/.\\./.aws/credentials",
      "~/s3cab.sandbox/.\\./.aws/credentials",
    ],
    ['cat ~/s3cab.sandbox/"."./.aws/credentials', "~/s3cab.sandbox/"],
    // A false alarm, taken over a miss.
    ["cd ~/s3cab.sandbox/work\nls src/../lib", "~/s3cab.sandbox/work"],
  ])) {
    assert.equal(strayCommand(command), reported, command);
  }
});

test("each spelling of home is home", () => {
  for (const path of [
    "${HOME}/.aws/credentials",
    "${env:USERPROFILE}\\.aws\\credentials",
    "$USERPROFILE/.aws/credentials",
  ]) {
    assert.equal(strayCommand(`cat ${path}`), path);
  }
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
  for (const [command, host] of /** @type {[string, string][]} */ ([
    ["curl -g 'https://[::1]:8080/x'", "[::1]"],
    ["curl -g 'http://[fe80::1%25en0]/'", "[fe80::1%25en0]"],
    ["curl 'https://[v1.fe80::a]/'", "[v1.fe80::a]"],
    ["curl http://127.0.0.1/x", "127.0.0.1"],
    ["curl https://bücher.example/x", "bücher.example"],
    ["curl https://@example.org/x", "@example.org"],
    ["curl https://_x.example.org/x", "_x.example.org"],
    ["curl -s 'https://[1-3].example.org/index.html'", "[1-3].example.org"],
    ["curl 'https://[1-2]{a,b}.example.org/'", "[1-2]"],
  ])) {
    assert.equal(strayCommand(command), host, command);
  }
});

test("a URL pattern in a regex isn't a host", () => {
  for (const command of [
    "sed 's#https://[^/]*##'",
    "grep -o 'https://[a-z0-9.]*'",
    'curl "https://$HOST/x"',
  ]) {
    assert.equal(strayCommand(command), undefined, command);
  }
});

test("a tilde is home, not as awk's operator", () => {
  assert.equal(strayCommand("ls ~/foo"), "~/foo");
  assert.equal(strayCommand("cd ~ && ls"), "~");
  assert.equal(strayCommand("find ~ -name '*.tsv'"), "~");
  assert.equal(strayCommand("Get-ChildItem ~ -Recurse"), "~");
  assert.equal(strayCommand("Set-Location ~\nls"), "~");
  assert.equal(strayCommand("cat <~/.aws/credentials"), "~/.aws/credentials");
  assert.equal(strayCommand("echo x >~/leak.txt"), "~/leak.txt");
  assert.equal(strayCommand("cd ~; cat .aws/credentials"), "~");
  assert.equal(strayCommand("(cd ~) ; ls"), "~");
  assert.equal(strayCommand("Get-ChildItem .\\a,~\\.aws"), "~\\.aws");
  assert.equal(
    strayCommand(
      "aws s3 cp s3://b/k - --quiet | zcat | awk -F'\\t' '$1 ~ /^@SET/ && $2 ~ /DIR/ { print $3 }'",
    ),
    undefined,
  );
});

test("a command running s3cab is reported as that run", () => {
  assert.equal(strayCommand("cd x; npx s3cab --help"), "npx s3cab");
  assert.equal(strayCommand("npm view s3cab@latest"), "s3cab");
  for (const command of [
    "npx -y s3cab restore x",
    "sudo s3cab list",
    "env FOO=1 s3cab list",
    "for s in a b; do s3cab list $s; done",
    "1..3 | % { s3cab list }",
    "bash <<'EOF'\ns3cab list\nEOF",
    'bash -c "s3cab list"',
    "Invoke-Expression 's3cab list'",
    "% {s3cab list}",
    "./s3cab list",
    '& "s3cab" list',
    "Invoke-Expression 's3cab'",
    "s3cab>out.txt",
    "$snap = s3cab list myset",
    "AWS_PROFILE=x s3cab list",
    "if s3cab list; then echo y; fi",
    "if ! s3cab backup; then exit 1; fi",
    "while s3cab list; do sleep 1; done",
    "timeout 10 s3cab list",
    "nice -n 5 s3cab list",
    "sudo -u root s3cab list",
    "command s3cab list",
    "wsl s3cab list",
    "cmd /c s3cab list",
    "cmd.exe /c s3cab list",
    "Start-Process s3cab -ArgumentList list",
    "powershell -Command s3cab list",
    "pwsh -NoProfile -c s3cab list",
    "for s in a b; do AWS_PROFILE=x s3cab list $s; done",
    "env -u FOO s3cab list",
    "wsl.exe s3cab list",
    "pnpm dlx --silent s3cab list",
    "yarn s3cab list",
    "bun x s3cab list",
    "iex s3cab",
    "watch -n 5 s3cab list",
    "doas s3cab list",
    "alias sc=s3cab",
    "doskey sc=s3cab $*",
    "bin=s3cab; $bin list",
    "x=`s3cab`",
    "& {s3cab}",
    "Start-Process -FilePath:s3cab -ArgumentList list",
    // Prose too: a false alarm, taken over a miss.
    "cat > NOTES.md <<'EOF'\nThe spec says s3cab takes the latest.\nEOF",
  ]) {
    assert.equal(strayCommand(command), "s3cab", command);
  }
  assert.equal(strayCommand(".\\s3cab.exe list"), "s3cab.exe");
  assert.equal(
    strayCommand('Start-Process -FilePath "s3cab.exe" -ArgumentList "list"'),
    "s3cab.exe",
  );
  assert.equal(strayCommand("node ./src/s3cab.mjs list"), "s3cab.mjs");
  assert.equal(strayCommand("s3cab.ps1 list"), "s3cab.ps1");
});

test("s3cab's, or the restorer's name, isn't a run of it", () => {
  for (const command of [
    "echo 'restores what (s3cab's own restore) would' >> REPORT.md",
    "./s3cab-restore bucket set out",
    "dotnet build -o=s3cab-restore",
  ]) {
    assert.equal(strayCommand(command), undefined, command);
  }
});

test("s3cab as a regex alternative isn't a run of it", () => {
  assert.equal(
    strayCommand(
      "Get-Content x | ? { $_ -notmatch '^  @(CLIENT|SNAPSHOT|S3CAB|SET) ' }",
    ),
    undefined,
  );
});
