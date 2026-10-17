/**
 * What counts as a stray, for audit-transcript.mjs (its header lists them), split out so a
 * test can import the matchers. Each returns the text that matched, so the audit can say
 * why a move was flagged, or undefined.
 */
import { homedir, tmpdir } from "node:os";
import { isAbsolute, relative } from "node:path";
import { repoRoot } from "./cleanroom.mjs";

const windows = process.platform === "win32";
/** @param {string} path */
const fold = (path) => (windows ? path.toLowerCase() : path);
/** @param {string} child @param {string} parent */
const inside = (child, parent) => {
  const rel = relative(fold(parent), fold(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
const watched = [homedir(), tmpdir(), repoRoot];

// A command can't be resolved the way a path can, so it is read as text: the allowed
// places' spellings are taken out, then anything still naming a watched place is a stray.
/** A path in either slash direction, as a regex source. @param {string} path */
const spellings = (path) =>
  [path, path.replaceAll("\\", "/")]
    .map((spelling) => spelling.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
// A session names its own scratchpad as `$env:TEMP\claude\…` as readily as by full path.
// Only allowed places get these aliases, so a bare `$env:TEMP` still reads as temp.
/** @type {[string, string[]][]} */
const variables = [
  [tmpdir(), ["$env:TEMP", "$env:TMP", "%TEMP%", "%TMP%", "$TMPDIR"]],
  [homedir(), ["$env:USERPROFILE", "$env:HOME", "%USERPROFILE%", "$HOME", "~"]],
];
/** @param {string} path */
const aliases = (path) => [
  path,
  ...variables.flatMap(([prefix, names]) =>
    inside(path, prefix)
      ? names.map((name) => name + path.slice(prefix.length))
      : [],
  ),
];
const named = new RegExp(
  watched.map(spellings).join("|") +
    // Not `'~'`, a quoted tilde: that is a literal string (a -replace target), not home.
    // A bare `~` is home only where its command ends (`cd ~`, `cd ~ && …`): one with an
    // operand after it is awk's or perl's match operator (`$1 ~ /^@SET/`).
    String.raw`|(^|[\s"'(=])~(?=[\\/]|\s*($|[;&|)]))|\$HOME\b|\$env:(USERPROFILE|HOME|TEMP|TMP|LOCALAPPDATA|APPDATA)\b|%(USERPROFILE|TEMP|TMP|LOCALAPPDATA|APPDATA)%`,
  "i",
);
// The path the match is part of, not just the watched prefix: `$env:USERPROFILE\.dotnet`,
// not `$env:USERPROFILE`. A path with a space in it is cut at the space.
/** @param {string} text @param {RegExpMatchArray} match */
const wholePath = (text, match) => {
  const edge = /[\s"'`;|&(),=]/;
  let start = match.index ?? 0;
  // The tilde alternative matches its leading separator too.
  while (edge.test(text[start] ?? "")) {
    start++;
  }
  let end = (match.index ?? 0) + match[0].length;
  while (start > 0 && !edge.test(text[start - 1] ?? "")) {
    start--;
  }
  while (end < text.length && !edge.test(text[end] ?? "")) {
    end++;
  }
  return text.slice(start, end);
};
// Only in command position, after a line start or a separator, since sessions write `s3cab`
// in prose (`so s3cab withholds too`) and in regex filters (`@(CLIENT|SNAPSHOT|S3CAB|SET)`).
// Heredoc bodies are prose, so they're cut first. Case-insensitive, since Windows runs `S3CAB`
// too. `@` admits a version (`npm view s3cab@latest`).
const runsS3cab =
  /(^|[;&|(`])\s*((npx|pnpx|bunx|node)\s+|npm\s+\w+\s+)?s3cab(\.exe|\.cmd|\.mjs)?(?=$|[\s;&@])/im;
// A bash heredoc to its closing word, or a PowerShell here-string to its closing `'@`/`"@`.
const heredocs =
  /<<-?\s*(['"]?)(\w+)\1.*\n[\s\S]*?^\s*\2\s*$|@(['"])\s*\n[\s\S]*?^\3@/gm;
const formatUrl = "s3cab.plantegral.com/guide/format";
// A host ends at the first character a host can't hold, so a query string or a variable
// after it isn't read as part of it. One that starts with a variable reads as empty.
const urlHosts = /\bhttps?:\/\/([^\s/'"`)\\?#:;,|<>&$%{]*)/gi;
const s3Host = /(^|\.)s3[.-]([a-z0-9-]+\.)*amazonaws\.com$/i;
// The npm package ships src/ and guide/, so its registry and CDNs serve s3cab too.
const sourceHosts =
  /\b(github\.(com|io)|githubusercontent\.com|plantegral\.com|pages\.dev|npmjs\.(com|org)|unpkg\.com|jsdelivr\.net)\b/i;
// Keyed on the subcommand, so a variable named `gh` isn't one. Not `git`: a clone from the
// web names its URL, and one between local folders isn't the web.
const runsGh =
  /(^|[\s;&|(`])gh(\.exe)?\s+(api|repo|browse|gist|release|search|pr|issue|run|workflow)\b/im;
/** @param {string} command */
const reachesWeb = (command) => {
  const rest = command.replaceAll(formatUrl, "");
  return (
    [...rest.matchAll(urlHosts)]
      .map(([, host = ""]) => host)
      .find((host) => host !== "" && !s3Host.test(host)) ??
    rest.match(sourceHosts)?.[0] ??
    rest.match(runsGh)?.[0].replace(/^[\s;&|(`]+/, "")
  );
};

/** @param {string[]} allowed the places the session may use: the root and its own scratch */
export function strayFinders(allowed) {
  const allowedSpelled = new RegExp(
    allowed.flatMap(aliases).map(spellings).join("|"),
    "gi",
  );
  return {
    /** @param {string} path */
    strayPath: (path) =>
      !allowed.some((place) => inside(path, place)) &&
      watched.some((place) => inside(path, place)),
    /**
     * @param {string} command
     * @returns {string | undefined}
     */
    strayCommand: (command) => {
      const rest = command.replace(allowedSpelled, "");
      const place = rest.match(named);
      return (
        (place && wholePath(rest, place)) ||
        command
          .replace(heredocs, "")
          .match(runsS3cab)?.[0]
          .replace(/^[\s;&|(`]+/, "") ||
        reachesWeb(command)
      );
    },
  };
}
