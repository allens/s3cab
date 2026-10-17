/**
 * What counts as a stray, for audit-transcript.mjs (its header lists them), split out so a
 * test can import the matchers. Each returns the text that matched, so the audit can say
 * why a move was flagged, or undefined.
 */
import { homedir, tmpdir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import { repoRoot } from "./cleanroom.mjs";

const windows = process.platform === "win32";
/** @param {string} path */
const fold = (path) => (windows ? path.toLowerCase() : path);
/** @param {string} child @param {string} parent */
const inside = (child, parent) => {
  const rel = relative(fold(parent), fold(child));
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
};
// What ends a path in a command's text.
const edge = "\\s\"'`;|&(),=";
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
  [
    tmpdir(),
    [
      "$env:TEMP",
      "$env:TMP",
      "${env:TEMP}",
      "${env:TMP}",
      "%TEMP%",
      "%TMP%",
      "$TMPDIR",
      "${TMPDIR}",
    ],
  ],
  [
    homedir(),
    [
      "$env:USERPROFILE",
      "$env:HOME",
      "${env:USERPROFILE}",
      "${env:HOME}",
      "%USERPROFILE%",
      "$USERPROFILE",
      "$HOME",
      "${HOME}",
      "~",
    ],
  ],
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
    // A bare `~` followed by a regex or a quoted string is awk's or perl's match operator
    // (`$1 ~ /^@SET/`), not home.
    String.raw`|(?<=^|[\s"'(=,])~(?=[\\/]|\s*($|[;&|)}])|\s+[^\s/"'])|\$(HOME|USERPROFILE)\b|\$\{HOME\}|\$\{?env:(USERPROFILE|HOME|TEMP|TMP|LOCALAPPDATA|APPDATA)\b|%(USERPROFILE|TEMP|TMP|LOCALAPPDATA|APPDATA)%`,
  "i",
);
// The path the match is part of, not just the watched prefix: `$env:USERPROFILE\.dotnet`,
// not `$env:USERPROFILE`. A path with a space in it is cut at the space.
/** @param {string} text @param {RegExpMatchArray} match */
const wholePath = (text, match) => {
  const ends = new RegExp(`[${edge}]`);
  let start = match.index ?? 0;
  let end = start + match[0].length;
  while (start > 0 && !ends.test(text[start - 1] ?? "")) {
    start--;
  }
  while (end < text.length && !ends.test(text[end] ?? "")) {
    end++;
  }
  return text.slice(start, end);
};
// After a space, a separator, a quote or a slash, prose included (`so s3cab withholds too`): a
// missed run voids the audit, and a false alarm costs a glance at the input printed beside
// it. Not before `|` or `)`, where it is a regex alternative (`@(CLIENT|SNAPSHOT|S3CAB|SET)`).
// Case-insensitive, since Windows runs `S3CAB` too. `@` admits a version (`s3cab@latest`).
const runsS3cab =
  /(?<=^|[\s;&|(`"'{\\/])((npx|pnpx|bunx)\s+|npm\s+exec\s+)?s3cab(\.exe|\.cmd|\.ps1|\.mjs)?(?=$|[\s;&@"'>])/im;
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
  /(?<=^|[\s;&|(`])gh(\.exe)?\s+(api|repo|browse|gist|release|search|pr|issue|run|workflow)\b/im;
/** @param {string} command */
const reachesWeb = (command) => {
  const rest = command.replaceAll(formatUrl, "");
  return (
    [...rest.matchAll(urlHosts)]
      .map(([, host = ""]) => host)
      .find((host) => host !== "" && !s3Host.test(host)) ??
    rest.match(sourceHosts)?.[0] ??
    rest.match(runsGh)?.[0]
  );
};

/** @param {string[]} allowed the places the session may use: the root and its own scratch */
export function strayFinders(allowed) {
  const allowedSpelled = new RegExp(
    `(${allowed.flatMap(aliases).map(spellings).join("|")})(?=[\\\\/${edge}]|$)`,
    "gi",
  );
  // Nothing is cut from a command holding a `..` anywhere: what's left after the cut no
  // longer names home (`~/s3cab.sandbox/../.aws`). Not a check of each path's own `..`,
  // since quoting, escaped spaces and split arguments (`Join-Path ~/s3cab.sandbox ../..`)
  // each hid a climb-out from one.
  const climbs = new RegExp(
    `(^|[\\\\/${edge}])\\.\\.(?=[\\\\/${edge}]|$)`,
    "m",
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
      const rest = climbs.test(command)
        ? command
        : command.replace(allowedSpelled, "");
      const place = rest.match(named);
      return (
        (place && wholePath(rest, place)) ||
        command.match(runsS3cab)?.[0] ||
        reachesWeb(command)
      );
    },
  };
}
