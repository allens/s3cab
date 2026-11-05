// s3cab-restore: an independent restorer for the s3cab repository format, written from
// format.md alone. .NET Framework 4.8, C# 5, no libraries beyond the standard one.
//
//   s3cab-restore.exe <bucket> <set> <dir> [<snapshot>]
//   s3cab-restore.exe --snapshots <bucket> <set>      list the set's snapshots (real requests)
//   s3cab-restore.exe --check <file.tsv.gz>           parse a local snapshot, no network
//
// Credentials: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AWS_REGION.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using Microsoft.Win32.SafeHandles;

[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8")]

namespace S3cabRestore
{
    // A failure that stops the whole restore.
    class FatalException : Exception { public FatalException(string m) : base(m) { } }
    // A snapshot that is refused whole.
    class RefusedException : Exception { public RefusedException(string m) : base(m) { } }

    static class Util
    {
        public static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);

        public static string Hex(byte[] b)
        {
            var sb = new StringBuilder(b.Length * 2);
            for (int i = 0; i < b.Length; i++) sb.Append(b[i].ToString("x2"));
            return sb.ToString();
        }

        public static byte[] Sha256(byte[] data)
        {
            using (var h = SHA256.Create()) return h.ComputeHash(data);
        }

        public static byte[] HmacSha256(byte[] key, string data)
        {
            using (var h = new HMACSHA256(key)) return h.ComputeHash(Encoding.UTF8.GetBytes(data));
        }

        // JavaScript's trim() set, as the spec lists it.
        public static bool IsJsTrim(char c)
        {
            if (c >= '\u0009' && c <= '\u000D') return true;
            if (c == '\u0020' || c == '\u00A0' || c == '\u1680') return true;
            if (c >= '\u2000' && c <= '\u200A') return true;
            if (c == '\u202F' || c == '\u205F' || c == '\u3000') return true;
            if (c == '\u2028' || c == '\u2029' || c == '\uFEFF') return true;
            return false;
        }

        public static string JsTrim(string s)
        {
            int a = 0, b = s.Length;
            while (a < b && IsJsTrim(s[a])) a++;
            while (b > a && IsJsTrim(s[b - 1])) b--;
            return s.Substring(a, b - a);
        }

        public static bool IsLowerHex64(string s)
        {
            if (s.Length != 64) return false;
            for (int i = 0; i < 64; i++)
            {
                char c = s[i];
                if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
            }
            return true;
        }

        public static bool IsDigits(string s)
        {
            if (s.Length == 0) return false;
            for (int i = 0; i < s.Length; i++) if (s[i] < '0' || s[i] > '9') return false;
            return true;
        }

        // An approximation of JavaScript's toLowerCase(): .NET's invariant simple lowering,
        // plus the two differences the spec names: Final_Sigma and U+0130.
        public static string JsLower(string s)
        {
            string lowered = s.ToLowerInvariant();
            if (lowered.Length != s.Length) return lowered;
            var sb = new StringBuilder(s.Length + 4);
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                if (c == '\u03A3')
                {
                    sb.Append(IsFinalSigma(s, i) ? '\u03C2' : '\u03C3');
                }
                else if (c == '\u0130')
                {
                    sb.Append('i').Append('\u0307');
                }
                else sb.Append(lowered[i]);
            }
            return sb.ToString();
        }

        static bool IsCased(string s, int i)
        {
            var cat = CharUnicodeInfo.GetUnicodeCategory(s, i);
            return cat == UnicodeCategory.UppercaseLetter || cat == UnicodeCategory.LowercaseLetter
                || cat == UnicodeCategory.TitlecaseLetter;
        }

        static bool IsCaseIgnorable(string s, int i)
        {
            char c = s[i];
            if (c == '\'' || c == '.' || c == ':' || c == '\u00B7' || c == '\u0387' || c == '\u05F4'
                || c == '\u2018' || c == '\u2019' || c == '\u2024' || c == '\u2027' || c == '\uFE13'
                || c == '\uFE52' || c == '\uFE55' || c == '\uFF07' || c == '\uFF0E' || c == '\uFF1A')
                return true;
            var cat = CharUnicodeInfo.GetUnicodeCategory(s, i);
            return cat == UnicodeCategory.NonSpacingMark || cat == UnicodeCategory.EnclosingMark
                || cat == UnicodeCategory.Format || cat == UnicodeCategory.ModifierLetter
                || cat == UnicodeCategory.ModifierSymbol;
        }

        static bool IsFinalSigma(string s, int i)
        {
            // Preceded by a cased letter (skipping case-ignorables)...
            bool before = false;
            int j = i - 1;
            while (j >= 0)
            {
                if (char.IsLowSurrogate(s[j]) && j > 0 && char.IsHighSurrogate(s[j - 1])) j--;
                if (IsCaseIgnorable(s, j)) { j--; continue; }
                before = IsCased(s, j);
                break;
            }
            if (!before) return false;
            // ...and not followed by one (skipping case-ignorables).
            int k = i + 1;
            while (k < s.Length)
            {
                if (IsCaseIgnorable(s, k)) { k += char.IsHighSurrogate(s[k]) && k + 1 < s.Length ? 2 : 1; continue; }
                return !IsCased(s, k);
            }
            return true;
        }
    }

    // The 24-character instant: YYYY-MM-DDTHH:MM:SS.sssZ, a real proleptic-Gregorian instant.
    static class Instant
    {
        static readonly Regex Re = new Regex(@"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z\z");

        public static bool TryParseMs(string s, out long ms)
        {
            ms = 0;
            if (s == null || s.Length != 24 || !Re.IsMatch(s)) return false;
            int y = int.Parse(s.Substring(0, 4), CultureInfo.InvariantCulture);
            int mo = int.Parse(s.Substring(5, 2), CultureInfo.InvariantCulture);
            int d = int.Parse(s.Substring(8, 2), CultureInfo.InvariantCulture);
            int h = int.Parse(s.Substring(11, 2), CultureInfo.InvariantCulture);
            int mi = int.Parse(s.Substring(14, 2), CultureInfo.InvariantCulture);
            int se = int.Parse(s.Substring(17, 2), CultureInfo.InvariantCulture);
            int f = int.Parse(s.Substring(20, 3), CultureInfo.InvariantCulture);
            if (mo < 1 || mo > 12 || h > 23 || mi > 59 || se > 59) return false;
            if (d < 1 || d > DaysInMonth(y, mo)) return false;
            long days = DaysFromCivil(y, mo, d);
            ms = (((days * 24 + h) * 60 + mi) * 60 + se) * 1000 + f;
            return true;
        }

        public static bool IsValid(string s) { long ms; return TryParseMs(s, out ms); }

        static int DaysInMonth(int y, int m)
        {
            bool leap = (y % 4 == 0) && (y % 100 != 0 || y % 400 == 0);
            switch (m)
            {
                case 2: return leap ? 29 : 28;
                case 4: case 6: case 9: case 11: return 30;
                default: return 31;
            }
        }

        // Days since 1970-01-01 in the proleptic Gregorian calendar (works for year 0).
        static long DaysFromCivil(long y, int m, int d)
        {
            y -= m <= 2 ? 1 : 0;
            long era = (y >= 0 ? y : y - 399) / 400;
            long yoe = y - era * 400;
            long doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
            long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
            return era * 146097 + doe - 719468;
        }

        public static string FromMs(long ms)
        {
            // Only used for messages; DateTime can't hold year 0 but anything we read back can.
            try
            {
                var dt = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(ms);
                return dt.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
            }
            catch (ArgumentOutOfRangeException) { return ms + "ms"; }
        }
    }

    // gzip, read by its own framing: every member in turn, a zero byte ends the file, anything
    // else after a member is damage, and the CRC-32 and length trailer is checked.
    static class Gzip
    {
        class OneByteStream : Stream
        {
            readonly byte[] d; public int Pos;
            public OneByteStream(byte[] data, int pos) { d = data; Pos = pos; }
            public override int Read(byte[] buffer, int offset, int count)
            {
                if (count == 0 || Pos >= d.Length) return 0;
                buffer[offset] = d[Pos++];
                return 1;
            }
            public override bool CanRead { get { return true; } }
            public override bool CanSeek { get { return false; } }
            public override bool CanWrite { get { return false; } }
            public override long Length { get { throw new NotSupportedException(); } }
            public override long Position { get { throw new NotSupportedException(); } set { throw new NotSupportedException(); } }
            public override void Flush() { }
            public override long Seek(long o, SeekOrigin s) { throw new NotSupportedException(); }
            public override void SetLength(long v) { throw new NotSupportedException(); }
            public override void Write(byte[] b, int o, int c) { throw new NotSupportedException(); }
        }

        static readonly uint[] CrcTable = MakeCrcTable();
        static uint[] MakeCrcTable()
        {
            var t = new uint[256];
            for (uint n = 0; n < 256; n++)
            {
                uint c = n;
                for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
                t[n] = c;
            }
            return t;
        }

        public static byte[] DecompressAll(byte[] data)
        {
            var output = new MemoryStream();
            int pos = 0;
            int members = 0;
            while (true)
            {
                if (pos >= data.Length)
                {
                    if (members == 0) throw new RefusedException("not gzip: empty file");
                    break;
                }
                if (members > 0 && data[pos] == 0) break; // a zero byte after a stream ends the file
                if (pos + 10 > data.Length || data[pos] != 0x1f || data[pos + 1] != 0x8b)
                    throw new RefusedException(members == 0 ? "not gzip: bad magic" : "damaged: bytes after a gzip stream that don't start another");
                if (data[pos + 2] != 8) throw new RefusedException("damaged: gzip compression method isn't deflate");
                int flags = data[pos + 3];
                pos += 10;
                try
                {
                    if ((flags & 4) != 0) { int xlen = data[pos] | (data[pos + 1] << 8); pos += 2 + xlen; }
                    if ((flags & 8) != 0) { while (data[pos] != 0) pos++; pos++; }
                    if ((flags & 16) != 0) { while (data[pos] != 0) pos++; pos++; }
                    if ((flags & 2) != 0) pos += 2;
                    if (pos > data.Length) throw new IndexOutOfRangeException();
                }
                catch (IndexOutOfRangeException) { throw new RefusedException("damaged: gzip header cut short"); }

                var src = new OneByteStream(data, pos);
                uint crc = 0xFFFFFFFFu;
                long len = 0;
                var buf = new byte[65536];
                try
                {
                    using (var ds = new DeflateStream(src, CompressionMode.Decompress))
                    {
                        int n;
                        while ((n = ds.Read(buf, 0, buf.Length)) > 0)
                        {
                            output.Write(buf, 0, n);
                            for (int i = 0; i < n; i++) crc = CrcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >> 8);
                            len += n;
                        }
                    }
                }
                catch (InvalidDataException e) { throw new RefusedException("damaged: gzip error: " + e.Message); }
                crc ^= 0xFFFFFFFFu;
                pos = src.Pos;
                if (pos + 8 > data.Length) throw new RefusedException("damaged: gzip stream cut short (no trailer)");
                uint storedCrc = (uint)(data[pos] | (data[pos + 1] << 8) | (data[pos + 2] << 16) | (data[pos + 3] << 24));
                uint storedLen = (uint)(data[pos + 4] | (data[pos + 5] << 8) | (data[pos + 6] << 16) | (data[pos + 7] << 24));
                if (storedCrc != crc) throw new RefusedException("damaged: gzip CRC-32 mismatch");
                if (storedLen != (uint)(len & 0xFFFFFFFF)) throw new RefusedException("damaged: gzip length mismatch");
                pos += 8;
                members++;
            }
            return output.ToArray();
        }
    }

    // A path as the format sees it: its kind, its root and its segments.
    enum PathKind { None, Posix, Drive, Share }

    class ParsedPath
    {
        public PathKind Kind;
        public string Drive = "";          // upper-case letter for a drive
        public List<string> Segs = new List<string>();
        public string RootKey
        {
            get
            {
                if (Kind == PathKind.Drive) return "drive:" + Drive;
                if (Kind == PathKind.Share) return "share";
                return "/";
            }
        }
        public bool IsWindows { get { return Kind == PathKind.Drive || Kind == PathKind.Share; } }

        public static bool IsSep(PathKind k, char c)
        {
            if (k == PathKind.Posix) return c == '/';
            return c == '/' || c == '\\';
        }

        public static PathKind KindOf(string p)
        {
            if (p.Length >= 3 && ((p[0] >= 'A' && p[0] <= 'Z') || (p[0] >= 'a' && p[0] <= 'z')) && p[1] == ':' && (p[2] == '\\' || p[2] == '/'))
                return PathKind.Drive;
            if (p.Length >= 2 && (p[0] == '\\' || p[0] == '/') && (p[1] == '\\' || p[1] == '/'))
                return PathKind.Share;
            if (p.Length >= 1 && p[0] == '/') return PathKind.Posix;
            return PathKind.None;
        }

        // trimTrailing: a DIR ignores the separators it ends with; a file row doesn't.
        public static ParsedPath Parse(string p, bool trimTrailing)
        {
            var r = new ParsedPath();
            r.Kind = KindOf(p);
            if (r.Kind == PathKind.None) return r;
            string rest;
            if (r.Kind == PathKind.Drive) { r.Drive = char.ToUpperInvariant(p[0]).ToString(); rest = p.Substring(3); }
            else if (r.Kind == PathKind.Share) rest = p.Substring(2);
            else rest = p.Substring(1);
            if (trimTrailing)
            {
                int e = rest.Length;
                while (e > 0 && IsSep(r.Kind, rest[e - 1])) e--;
                rest = rest.Substring(0, e);
            }
            if (rest.Length > 0)
            {
                int start = 0;
                for (int i = 0; i <= rest.Length; i++)
                {
                    if (i == rest.Length || IsSep(r.Kind, rest[i]))
                    {
                        r.Segs.Add(rest.Substring(start, i - start));
                        start = i + 1;
                    }
                }
            }
            return r;
        }

        // Whether this (a DIR) holds the path, by whole segments. equal: the path is the DIR.
        public bool Holds(ParsedPath path, out bool equal)
        {
            equal = false;
            if (Kind == PathKind.None || path.Kind == PathKind.None) return false;
            if (Kind != path.Kind) return false;
            if (Kind == PathKind.Share && Segs.Count < 2) return false;        // \\, \\server\ match nothing
            foreach (var s in Segs) if (s.Length == 0) return false;            // doubled separator
            if (RootKey != path.RootKey) return false;
            if (path.Segs.Count < Segs.Count) return false;
            for (int i = 0; i < Segs.Count; i++)
            {
                string a = Segs[i], b = path.Segs[i];
                bool same = IsWindows ? string.Equals(Util.JsLower(a), Util.JsLower(b), StringComparison.Ordinal)
                                      : string.Equals(a, b, StringComparison.Ordinal);
                if (!same) return false;
            }
            equal = path.Segs.Count == Segs.Count;
            return true;
        }
    }

    class Row
    {
        public string[] F = new string[5];
        public string Type;
        public int Line;
        public string Raw;
        public bool HasValue;  // five fields present
    }

    class FileRow
    {
        public Row Row;
        public string Hash, Size, Mtime, Path;
        public long MtimeMs;
        public ParsedPath P;
        public string Refusal;
    }

    class SnapshotDoc
    {
        public List<ParsedPath> Dirs = new List<ParsedPath>();
        public List<string> DirTexts = new List<string>();
        public string Start;      // valid 24-character instant, or null
        public List<FileRow> Files = new List<FileRow>();
        public int Skipped;       // unknown @/# rows skipped
    }

    static class Tsv
    {
        public const string Heading = "https://s3cab.plantegral.com/guide/format";

        public static List<byte[]> SplitLines(byte[] text, out bool lastTerminated)
        {
            var lines = new List<byte[]>();
            int start = 0;
            for (int i = 0; i < text.Length; i++)
            {
                if (text[i] == 0x0A)
                {
                    var l = new byte[i - start];
                    Array.Copy(text, start, l, 0, l.Length);
                    lines.Add(l);
                    start = i + 1;
                }
            }
            lastTerminated = start == text.Length;
            if (!lastTerminated)
            {
                var l = new byte[text.Length - start];
                Array.Copy(text, start, l, 0, l.Length);
                lines.Add(l);
            }
            return lines;
        }

        public static Row ParseRow(string line, int lineNo)
        {
            var r = new Row();
            r.Raw = line; r.Line = lineNo;
            int start = 0, f = 0;
            for (int i = 0; i < line.Length && f < 4; i++)
            {
                if (line[i] == '\t') { r.F[f++] = line.Substring(start, i - start); start = i + 1; }
            }
            if (f < 4) { r.F[f++] = line.Substring(start); r.HasValue = false; while (f < 5) r.F[f++] = ""; }
            else { r.F[4] = line.Substring(start); r.HasValue = true; }
            for (int i = 0; i < 4; i++) r.F[i] = Util.JsTrim(r.F[i]);
            r.Type = r.F[0];
            return r;
        }

        public static bool IsHeading(Row r)
        {
            return r.HasValue && r.F[0] == "@S3CAB" && r.F[1] == "FORMAT" && r.F[2] == "size" && r.F[3] == "time"
                && string.Equals(r.F[4], Heading, StringComparison.Ordinal);
        }

        static readonly HashSet<string> KnownSnapshotTypes = new HashSet<string>(StringComparer.Ordinal)
            { "-", "@S3CAB", "@CLIENT", "@SET", "@SNAPSHOT", "#excluded", "#error" };

        // Parses and checks a decompressed snapshot. Throws RefusedException to refuse it whole.
        public static SnapshotDoc ParseSnapshot(byte[] text)
        {
            if (text.Length >= 3 && text[0] == 0xEF && text[1] == 0xBB && text[2] == 0xBF)
            {
                var t = new byte[text.Length - 3]; Array.Copy(text, 3, t, 0, t.Length); text = t;
            }
            bool terminated;
            var lines = SplitLines(text, out terminated);
            if (lines.Count == 0) throw new RefusedException("empty file");
            if (!terminated) throw new RefusedException("cut short: last line has no LF");
            var doc = new SnapshotDoc();
            var strs = new List<string>(lines.Count);
            for (int i = 0; i < lines.Count; i++)
            {
                try { strs.Add(Util.StrictUtf8.GetString(lines[i])); }
                catch (DecoderFallbackException) { throw new RefusedException("not UTF-8 at line " + (i + 1)); }
            }
            string last = strs[strs.Count - 1];
            if (!string.Equals(last, ".", StringComparison.Ordinal))
                throw new RefusedException("cut short: last line isn't '.' (it is " + Describe(last) + ")");
            var first = ParseRow(strs[0], 1);
            if (!IsHeading(first)) throw new RefusedException("first line isn't the heading row");
            for (int i = 0; i < strs.Count - 1; i++)
            {
                string line = strs[i];
                if (line.Length == 0) throw new RefusedException("blank line at line " + (i + 1));
                var row = ParseRow(line, i + 1);
                if (row.Type == "." ) throw new RefusedException("a '.' line at line " + (i + 1) + " with lines after it");
                if (row.Type.Length == 0 || (row.Type[0] != '@' && row.Type[0] != '#' && row.Type != "-"))
                    throw new RefusedException("unknown row type " + Describe(row.Type) + " at line " + (i + 1));
                if (row.Type == "-")
                {
                    doc.Files.Add(MakeFileRow(row));
                }
                else if (row.Type == "@SET")
                {
                    if (row.F[1] == "DIR")
                    {
                        if (row.HasValue && row.F[4].Length > 0)
                        {
                            doc.DirTexts.Add(row.F[4]);
                            doc.Dirs.Add(ParsedPath.Parse(row.F[4], true));
                        }
                    }
                }
                else if (row.Type == "@SNAPSHOT")
                {
                    if (row.F[1] == "START" && doc.Start == null && Instant.IsValid(row.F[3])) doc.Start = row.F[3];
                }
                else if (!KnownSnapshotTypes.Contains(row.Type)) doc.Skipped++;
            }
            Validate(doc);
            return doc;
        }

        public static string Describe(string s)
        {
            var sb = new StringBuilder("\"");
            foreach (char c in s)
            {
                if (c == '\t') sb.Append("\\t"); else if (c == '\r') sb.Append("\\r"); else if (c < ' ') sb.Append("\\u" + ((int)c).ToString("X4"));
                else sb.Append(c);
            }
            return sb.Append('"').ToString();
        }

        static FileRow MakeFileRow(Row row)
        {
            var fr = new FileRow { Row = row, Hash = row.F[1], Size = row.F[2], Mtime = row.F[3], Path = row.F[4] };
            if (!Util.IsLowerHex64(fr.Hash)) fr.Refusal = "malformed hash";
            else if (!Util.IsDigits(fr.Size)) fr.Refusal = "malformed size";
            else if (!Instant.TryParseMs(fr.Mtime, out fr.MtimeMs)) fr.Refusal = "malformed time";
            else if (!row.HasValue) fr.Refusal = "no path";
            else if (fr.Path.IndexOf('\t') >= 0) fr.Refusal = "tab in path";
            else if (fr.Path.IndexOf('\r') >= 0) fr.Refusal = "CR in path";
            else if (fr.Path.IndexOf('\0') >= 0) fr.Refusal = "NUL in path";
            else
            {
                fr.P = ParsedPath.Parse(fr.Path, false);
                if (fr.P.Kind == PathKind.None) fr.Refusal = "path isn't absolute";
                else
                {
                    foreach (var s in fr.P.Segs)
                    {
                        if (s.Length == 0) { fr.Refusal = "empty path segment (doubled or trailing separator)"; break; }
                        if (s == "." || s == "..") { fr.Refusal = "'" + s + "' path segment"; break; }
                    }
                    if (fr.Refusal == null && fr.P.Segs.Count == 0) fr.Refusal = "path is a root";
                }
            }
            return fr;
        }

        static void Validate(SnapshotDoc doc)
        {
            // Inside a @SET DIR, and never equal to one.
            foreach (var fr in doc.Files)
            {
                if (fr.Refusal != null) continue;
                bool under = false, isDir = false;
                foreach (var d in doc.Dirs)
                {
                    bool eq;
                    if (d.Holds(fr.P, out eq)) { if (eq) isDir = true; else under = true; }
                }
                if (isDir) fr.Refusal = "path is a @SET DIR";
                else if (!under) fr.Refusal = "path under no @SET DIR";
            }
            // One path in two rows, every file row taking part.
            var byPath = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var fr in doc.Files) { int n; byPath.TryGetValue(fr.Path, out n); byPath[fr.Path] = n + 1; }
            foreach (var fr in doc.Files)
                if (byPath[fr.Path] > 1) fr.Refusal = (fr.Refusal == null ? "" : fr.Refusal + "; ") + "path in more than one row";
            // One path running through another, among the survivors.
            var survivors = new HashSet<string>(StringComparer.Ordinal);
            foreach (var fr in doc.Files) if (fr.Refusal == null) survivors.Add(fr.Path);
            var through = new HashSet<string>(StringComparer.Ordinal);
            foreach (var fr in doc.Files)
            {
                if (fr.Refusal != null) continue;
                string p = fr.Path;
                for (int i = 1; i < p.Length; i++)
                {
                    if (ParsedPath.IsSep(fr.P.Kind, p[i]))
                    {
                        string prefix = p.Substring(0, i);
                        if (survivors.Contains(prefix)) { through.Add(prefix); through.Add(p); }
                    }
                }
            }
            foreach (var fr in doc.Files)
                if (fr.Refusal == null && through.Contains(fr.Path)) fr.Refusal = "path runs through another row's, or another's runs through it";
        }

        // Deletion records: hash -> newest instant, from every well-formed #deleted row.
        public static void ReadRecord(byte[] text, Dictionary<string, string> deleted)
        {
            if (text.Length >= 3 && text[0] == 0xEF && text[1] == 0xBB && text[2] == 0xBF)
            {
                var t = new byte[text.Length - 3]; Array.Copy(text, 3, t, 0, t.Length); text = t;
            }
            bool terminated;
            var lines = SplitLines(text, out terminated);
            for (int i = 0; i < lines.Count; i++)
            {
                string s;
                try { s = Util.StrictUtf8.GetString(lines[i]); } catch (DecoderFallbackException) { continue; }
                var row = ParseRow(s, i + 1);
                if (row.Type != "#deleted") continue;
                string hash = row.F[1], size = row.F[2], when = row.F[3];
                if (!Util.IsLowerHex64(hash) || !Util.IsDigits(size) || !Instant.IsValid(when)) continue;
                string old;
                if (!deleted.TryGetValue(hash, out old) || string.CompareOrdinal(when, old) > 0) deleted[hash] = when;
            }
        }
    }

    // S3 over plain HTTPS with Signature Version 4, signed by hand.
    class S3Client
    {
        readonly string bucket, region, akid, secret, token, host;
        static readonly Random Rng = new Random();
        public int Requests;

        public S3Client(string bucket, string region, string akid, string secret, string token)
        {
            this.bucket = bucket; this.region = region; this.akid = akid; this.secret = secret; this.token = token;
            host = bucket + ".s3." + region + ".amazonaws.com";
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            ServicePointManager.Expect100Continue = false;
        }

        public class Resp
        {
            public int Status; public byte[] Body = new byte[0]; public string ErrorCode = ""; public string ErrorMessage = "";
        }

        class Dropped : Exception { public Dropped(string m) : base(m) { } }

        static string UriEncode(string s, bool encodeSlash)
        {
            var sb = new StringBuilder();
            foreach (byte b in Encoding.UTF8.GetBytes(s))
            {
                char c = (char)b;
                if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~')
                    sb.Append(c);
                else if (c == '/' && !encodeSlash) sb.Append(c);
                else sb.Append('%').Append(((int)b).ToString("X2"));
            }
            return sb.ToString();
        }

        Resp Send(string method, string key, SortedDictionary<string, string> query)
        {
            string canonicalUri = "/" + UriEncode(key, false);
            var qs = new StringBuilder();
            if (query != null)
                foreach (var kv in query)
                {
                    if (qs.Length > 0) qs.Append('&');
                    qs.Append(UriEncode(kv.Key, true)).Append('=').Append(UriEncode(kv.Value, true));
                }
            string canonicalQuery = qs.ToString();
            string amzDate = DateTime.UtcNow.ToString("yyyyMMdd'T'HHmmss'Z'", CultureInfo.InvariantCulture);
            string dateStamp = amzDate.Substring(0, 8);
            const string emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
            var headers = new SortedDictionary<string, string>(StringComparer.Ordinal);
            headers["host"] = host;
            headers["x-amz-content-sha256"] = emptyHash;
            headers["x-amz-date"] = amzDate;
            if (!string.IsNullOrEmpty(token)) headers["x-amz-security-token"] = token;
            var ch = new StringBuilder(); var sh = new StringBuilder();
            foreach (var kv in headers)
            {
                ch.Append(kv.Key).Append(':').Append(kv.Value.Trim()).Append('\n');
                if (sh.Length > 0) sh.Append(';');
                sh.Append(kv.Key);
            }
            string canonicalRequest = method + "\n" + canonicalUri + "\n" + canonicalQuery + "\n" + ch + "\n" + sh + "\n" + emptyHash;
            string scope = dateStamp + "/" + region + "/s3/aws4_request";
            string stringToSign = "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + Util.Hex(Util.Sha256(Encoding.UTF8.GetBytes(canonicalRequest)));
            byte[] kDate = Util.HmacSha256(Encoding.UTF8.GetBytes("AWS4" + secret), dateStamp);
            byte[] kRegion = Util.HmacSha256(kDate, region);
            byte[] kService = Util.HmacSha256(kRegion, "s3");
            byte[] kSigning = Util.HmacSha256(kService, "aws4_request");
            string signature = Util.Hex(Util.HmacSha256(kSigning, stringToSign));
            string auth = "AWS4-HMAC-SHA256 Credential=" + akid + "/" + scope + ", SignedHeaders=" + sh + ", Signature=" + signature;

            string url = "https://" + host + canonicalUri + (canonicalQuery.Length > 0 ? "?" + canonicalQuery : "");
            var req = (HttpWebRequest)WebRequest.Create(url);
            if (!string.Equals(req.RequestUri.PathAndQuery, canonicalUri + (canonicalQuery.Length > 0 ? "?" + canonicalQuery : ""), StringComparison.Ordinal))
                throw new FatalException("the HTTP client rewrote the request path: " + req.RequestUri.PathAndQuery);
            req.Method = method;
            req.Timeout = 30000;
            req.ReadWriteTimeout = 30000;
            req.AllowAutoRedirect = false;
            req.AutomaticDecompression = DecompressionMethods.None;
            req.UserAgent = "s3cab-restore/0.1 (independent restorer)";
            req.Headers["x-amz-content-sha256"] = emptyHash;
            req.Headers["x-amz-date"] = amzDate;
            if (!string.IsNullOrEmpty(token)) req.Headers["x-amz-security-token"] = token;
            req.Headers["Authorization"] = auth;
            Requests++;

            HttpWebResponse resp = null;
            try
            {
                try { resp = (HttpWebResponse)req.GetResponse(); }
                catch (WebException we)
                {
                    if (we.Response == null) throw new Dropped(we.Status + ": " + we.Message);
                    resp = (HttpWebResponse)we.Response;
                }
                var r = new Resp { Status = (int)resp.StatusCode };
                using (var s = resp.GetResponseStream())
                using (var ms = new MemoryStream())
                {
                    try { s.CopyTo(ms); }
                    catch (IOException e) { throw new Dropped("body: " + e.Message); }
                    catch (WebException e) { throw new Dropped("body: " + e.Message); }
                    r.Body = ms.ToArray();
                }
                if (r.Status >= 300)
                {
                    try
                    {
                        var doc = new XmlDocument();
                        doc.LoadXml(Encoding.UTF8.GetString(r.Body));
                        var code = doc.SelectSingleNode("/Error/Code");
                        var msg = doc.SelectSingleNode("/Error/Message");
                        if (code != null) r.ErrorCode = code.InnerText;
                        if (msg != null) r.ErrorMessage = msg.InnerText;
                    }
                    catch (XmlException) { }
                }
                return r;
            }
            finally { if (resp != null) resp.Close(); }
        }

        // Retries: a dropped connection for two minutes (ceiling 0.5s doubling to 2s), a 5xx up
        // to three attempts (ceiling 0.1s, 0.5s when throttled, doubling to 20s).
        public Resp Request(string method, string key, SortedDictionary<string, string> query)
        {
            DateTime firstDrop = DateTime.MinValue; double dropCeiling = 0.5;
            int attempts = 0; double errCeiling = 0.1;
            while (true)
            {
                Resp r;
                try { r = Send(method, key, query); }
                catch (Dropped d)
                {
                    if (firstDrop == DateTime.MinValue) firstDrop = DateTime.UtcNow;
                    if ((DateTime.UtcNow - firstDrop).TotalSeconds >= 120) throw new FatalException("connection kept dropping for two minutes: " + d.Message);
                    Console.Error.WriteLine("  (connection dropped, retrying: " + d.Message + ")");
                    System.Threading.Thread.Sleep((int)(Rng.NextDouble() * dropCeiling * 1000));
                    dropCeiling = Math.Min(2.0, dropCeiling * 2);
                    continue;
                }
                attempts++;
                if (r.Status >= 500 && attempts < 3)
                {
                    if (r.Status == 503 && attempts == 1) errCeiling = 0.5;
                    Console.Error.WriteLine("  (HTTP " + r.Status + " " + r.ErrorCode + ", retrying)");
                    System.Threading.Thread.Sleep((int)(Rng.NextDouble() * errCeiling * 1000));
                    errCeiling = Math.Min(20.0, errCeiling * 2);
                    continue;
                }
                return r;
            }
        }

        // GET objects/<key>; missing is a 404 NoSuchKey / NotFound. Anything else stops the restore.
        public byte[] Get(string key, out bool missing)
        {
            missing = false;
            var r = Request("GET", key, null);
            if (r.Status == 200) return r.Body;
            if (r.Status == 404 && (r.ErrorCode == "NoSuchKey" || r.ErrorCode == "NotFound")) { missing = true; return null; }
            throw new FatalException("GET " + key + ": HTTP " + r.Status + " " + r.ErrorCode + " " + r.ErrorMessage);
        }

        // Keys directly in a folder (ListObjectsV2 with delimiter "/"), every page.
        public List<string> ListFolder(string prefix)
        {
            var keys = new List<string>();
            string token = null;
            while (true)
            {
                var q = new SortedDictionary<string, string>(StringComparer.Ordinal);
                q["list-type"] = "2"; q["prefix"] = prefix; q["delimiter"] = "/"; q["max-keys"] = "1000";
                if (token != null) q["continuation-token"] = token;
                var r = Request("GET", "", q);
                if (r.Status != 200) throw new FatalException("list " + prefix + ": HTTP " + r.Status + " " + r.ErrorCode + " " + r.ErrorMessage);
                var doc = new XmlDocument();
                doc.LoadXml(Encoding.UTF8.GetString(r.Body));
                var ns = new XmlNamespaceManager(doc.NameTable);
                ns.AddNamespace("s3", "http://s3.amazonaws.com/doc/2006-03-01/");
                foreach (XmlNode n in doc.SelectNodes("/s3:ListBucketResult/s3:Contents/s3:Key", ns)) keys.Add(n.InnerText);
                var trunc = doc.SelectSingleNode("/s3:ListBucketResult/s3:IsTruncated", ns);
                var next = doc.SelectSingleNode("/s3:ListBucketResult/s3:NextContinuationToken", ns);
                if (trunc != null && trunc.InnerText == "true" && next != null) token = next.InnerText;
                else break;
            }
            return keys;
        }
    }

    static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct BY_HANDLE_FILE_INFORMATION
        {
            public uint FileAttributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetFileInformationByHandle(SafeFileHandle h, out BY_HANDLE_FILE_INFORMATION info);

        public static string FileId(string path)
        {
            using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                BY_HANDLE_FILE_INFORMATION info;
                if (!GetFileInformationByHandle(fs.SafeFileHandle, out info)) throw new IOException("GetFileInformationByHandle failed");
                return info.VolumeSerialNumber.ToString("x8") + ":" + info.FileIndexHigh.ToString("x8") + info.FileIndexLow.ToString("x8");
            }
        }
    }

    class Restorer
    {
        readonly S3Client s3;
        readonly string output;        // \\?\-prefixed absolute output directory
        readonly SnapshotDoc doc;
        readonly HashSet<string> written = new HashSet<string>(StringComparer.Ordinal);
        readonly HashSet<string> badHashes = new HashSet<string>(StringComparer.Ordinal);
        Dictionary<string, string> deleted;   // lazily loaded records
        public int Restored, SkippedExisting, Deleted, Damaged, Refused, Collisions, InTheWay, TimeNotHeld, TimeRounded, Uncreatable;
        public bool Failed;

        public Restorer(S3Client s3, string output, SnapshotDoc doc) { this.s3 = s3; this.output = output; this.doc = doc; }

        static string LongPath(string p)
        {
            if (p.StartsWith(@"\\?\", StringComparison.Ordinal)) return p;
            if (p.StartsWith(@"\\", StringComparison.Ordinal)) return @"\\?\UNC\" + p.Substring(2);
            return @"\\?\" + p;
        }

        public static string PrepareOutput(string dir)
        {
            string full = Path.GetFullPath(dir);
            full = full.TrimEnd('\\', '/');
            return LongPath(full);
        }

        static string Show(string p) { return p.StartsWith(@"\\?\UNC\", StringComparison.Ordinal) ? @"\\" + p.Substring(8) : p.StartsWith(@"\\?\", StringComparison.Ordinal) ? p.Substring(4) : p; }

        void Report(string what, FileRow fr) { Console.WriteLine(what + "\t" + fr.Path); }

        public void Run()
        {
            foreach (var fr in doc.Files)
            {
                if (fr.Refusal != null) { Refused++; Failed = true; Report("refused (" + fr.Refusal + ")", fr); continue; }
                try { RestoreOne(fr); }
                catch (FatalException) { throw; }
                catch (Exception e)
                {
                    Failed = true; Uncreatable++;
                    Report("failed (" + e.GetType().Name + ": " + e.Message.Replace("\r", " ").Replace("\n", " ") + ")", fr);
                }
            }
        }

        // Where the row lands: <output>\<root folder>\<segments>, joined with '\'.
        List<string> Parts(FileRow fr)
        {
            var parts = new List<string>();
            if (fr.P.Kind == PathKind.Drive) parts.Add(fr.P.Drive);
            else if (fr.P.Kind == PathKind.Share) parts.Add("UNC");
            parts.AddRange(fr.P.Segs);
            return parts;
        }

        void RestoreOne(FileRow fr)
        {
            var parts = Parts(fr);
            // Names Windows would misread: split on '\', or write to a stream after ':'.
            foreach (var s in fr.P.Segs)
            {
                if (s.IndexOf('\\') >= 0 || s.IndexOf('/') >= 0) { Refused++; Failed = true; Report("refused (a name holding a separator the destination would split)", fr); return; }
                if (s.IndexOf(':') >= 0) { Refused++; Failed = true; Report("refused (a name holding ':' the destination would write as a stream)", fr); return; }
            }
            // The folders between <output> and the file: each is either absent or a real directory.
            var sb = new StringBuilder(output);
            var folders = new List<string>();
            for (int i = 0; i < parts.Count - 1; i++)
            {
                sb.Append('\\').Append(parts[i]);
                folders.Add(sb.ToString());
            }
            string dest = sb.Append('\\').Append(parts[parts.Count - 1]).ToString();
            foreach (var f in folders)
            {
                FileAttributes a;
                if (!TryAttributes(f, out a)) continue;
                if ((a & FileAttributes.Directory) == 0) { InTheWay++; Failed = true; Report("in the way (a file where folder " + Show(f) + " should be)", fr); return; }
                if ((a & FileAttributes.ReparsePoint) != 0) { InTheWay++; Failed = true; Report("in the way (a link or junction at folder " + Show(f) + ")", fr); return; }
            }
            {
                FileAttributes a;
                if (TryAttributes(dest, out a))
                {
                    if ((a & FileAttributes.Directory) != 0 && (a & FileAttributes.ReparsePoint) == 0) { InTheWay++; Failed = true; Report("in the way (a folder where the file should land)", fr); return; }
                    if ((a & FileAttributes.ReparsePoint) == 0 && written.Contains(Native.FileId(dest)))
                    { Collisions++; Failed = true; Report("collision (another row of this restore already landed here)", fr); return; }
                    SkippedExisting++; Report("skipped (already there)", fr); return;
                }
            }
            // Fetch and check.
            if (badHashes.Contains(fr.Hash)) { Damaged++; Failed = true; Report("damaged (object didn't hash to its key earlier in this restore)", fr); return; }
            bool missing;
            byte[] bytes = s3.Get("objects/" + fr.Hash, out missing);
            if (missing)
            {
                string when = LookUpDeleted(fr.Hash);
                if (when != null && doc.Start != null && string.CompareOrdinal(when, doc.Start) > 0)
                { Deleted++; Report("deleted (deliberately, " + when + ")", fr); return; }
                Damaged++; Failed = true;
                Report(when != null ? "damaged (object missing; a deletion record names it at " + when + ", not after the snapshot's START " + (doc.Start ?? "(none)") + ")" : "damaged (object missing, no deletion record explains it)", fr);
                return;
            }
            string got = Util.Hex(Util.Sha256(bytes));
            if (!string.Equals(got, fr.Hash, StringComparison.Ordinal))
            {
                badHashes.Add(fr.Hash); Damaged++; Failed = true;
                Report("damaged (download hashes to " + got + ", withheld)", fr); return;
            }
            // Write: folders only now, the file with no overwrite, then its times.
            var made = new List<string>();
            try
            {
                foreach (var f in folders)
                {
                    FileAttributes a;
                    if (TryAttributes(f, out a)) continue;
                    Directory.CreateDirectory(f);
                    made.Add(f);
                }
                using (var fs = new FileStream(dest, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    fs.Write(bytes, 0, bytes.Length);
            }
            catch (Exception e)
            {
                if (e is FatalException) throw;
                for (int i = made.Count - 1; i >= 0; i--) { try { Directory.Delete(made[i]); } catch (Exception) { } }
                Uncreatable++; Failed = true;
                Report("failed (the destination won't create it: " + e.Message.Replace("\r", " ").Replace("\n", " ") + ")", fr);
                return;
            }
            written.Add(Native.FileId(dest));
            Restored++;
            // Modification time, to the millisecond. FILETIME 0 (1601-01-01) means "leave alone".
            long ft = (fr.MtimeMs + 11644473600000L) * 10000L;
            if (ft <= 0)
            {
                TimeNotHeld++; Failed = true;
                Report("restored, but its time " + fr.Mtime + " can't be held here (left at " + Instant.FromMs(ReadBackMs(dest)) + ")", fr);
                return;
            }
            var dt = DateTime.FromFileTimeUtc(ft);
            try
            {
                File.SetLastAccessTimeUtc(dest, dt);
                File.SetLastWriteTimeUtc(dest, dt);
            }
            catch (Exception e)
            {
                TimeNotHeld++; Failed = true;
                Report("restored, but its time " + fr.Mtime + " couldn't be set (" + e.Message + ")", fr);
                return;
            }
            long back = ReadBackMs(dest);
            long diff = Math.Abs(back - fr.MtimeMs);
            if (diff == 0) Report("restored", fr);
            else if (diff < 2000) { TimeRounded++; Report("restored (time rounded by the disk to " + Instant.FromMs(back) + ")", fr); }
            else { TimeNotHeld++; Failed = true; Report("restored, but its time reads back as " + Instant.FromMs(back) + ", not " + fr.Mtime, fr); }
        }

        static long ReadBackMs(string path)
        {
            long ticks = File.GetLastWriteTimeUtc(path).ToFileTimeUtc();
            long ms = ticks / 10000; long rem = ticks % 10000;
            if (rem >= 5000) ms++;
            return ms - 11644473600000L;
        }

        // Absent, or present with its attributes. A name NTFS can't hold makes GetAttributes
        // throw IOException (ERROR_INVALID_NAME, 123) where File.Exists would answer false; treat
        // it as absent, so the creation step reports it.
        static bool TryAttributes(string path, out FileAttributes a)
        {
            a = 0;
            try { a = File.GetAttributes(path); return true; }
            catch (FileNotFoundException) { return false; }
            catch (DirectoryNotFoundException) { return false; }
            catch (IOException e) { if ((e.HResult & 0xFFFF) == 123) return false; throw; }
        }

        string LookUpDeleted(string hash)
        {
            if (deleted == null)
            {
                deleted = new Dictionary<string, string>(StringComparer.Ordinal);
                var keys = s3.ListFolder("objects.deleted-");
                var re = new Regex(@"^objects\.deleted-[1-9][0-9]*\.tsv\z");
                foreach (var k in keys)
                {
                    if (!re.IsMatch(k)) continue;
                    bool missing;
                    byte[] body = s3.Get(k, out missing);
                    if (missing) { Console.Error.WriteLine("  (deletion record " + k + " listed but gone; it explains nothing)"); continue; }
                    Tsv.ReadRecord(body, deleted);
                }
                Console.Error.WriteLine("  (read " + deleted.Count + " deleted hashes from the deletion records)");
            }
            string when;
            return deleted.TryGetValue(hash, out when) ? when : null;
        }
    }

    static class Program
    {
        static readonly Regex SnapshotName = new Regex(@"^[0-9]{8}T[0-9]{4}\.tsv\.gz\z");

        static int Main(string[] args)
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            int code;
            try { code = Run(args); }
            catch (FatalException e) { Console.Error.WriteLine("fatal: " + e.Message); code = 2; }
            catch (RefusedException e) { Console.Error.WriteLine("refused: " + e.Message); code = 2; }
            Console.Error.WriteLine("exit " + code);
            return code;
        }

        static S3Client ClientFromEnv(string bucket)
        {
            string akid = Environment.GetEnvironmentVariable("AWS_ACCESS_KEY_ID");
            string secret = Environment.GetEnvironmentVariable("AWS_SECRET_ACCESS_KEY");
            string token = Environment.GetEnvironmentVariable("AWS_SESSION_TOKEN");
            string region = Environment.GetEnvironmentVariable("AWS_REGION");
            if (string.IsNullOrEmpty(region)) region = Environment.GetEnvironmentVariable("AWS_DEFAULT_REGION");
            if (string.IsNullOrEmpty(akid) || string.IsNullOrEmpty(secret)) throw new FatalException("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set");
            if (string.IsNullOrEmpty(region)) throw new FatalException("AWS_REGION must be set");
            return new S3Client(bucket, region, akid, secret, token);
        }

        static List<string> SnapshotNames(S3Client s3, string set)
        {
            string prefix = "snapshots/" + set + "/";
            var names = new List<string>();
            foreach (var k in s3.ListFolder(prefix))
            {
                if (!k.StartsWith(prefix, StringComparison.Ordinal)) continue;
                string name = k.Substring(prefix.Length);
                if (SnapshotName.IsMatch(name)) names.Add(name.Substring(0, name.Length - 7));
            }
            names.Sort(StringComparer.Ordinal);
            return names;
        }

        static int Run(string[] args)
        {
            if (args.Length == 2 && args[0] == "--check")
            {
                var doc = Tsv.ParseSnapshot(Gzip.DecompressAll(File.ReadAllBytes(args[1])));
                PrintDoc(doc);
                return 0;
            }
            if (args.Length == 3 && args[0] == "--snapshots")
            {
                var s3l = ClientFromEnv(args[1]);
                foreach (var n in SnapshotNames(s3l, args[2])) Console.WriteLine(n);
                return 0;
            }
            // Development aid: --from <file.tsv.gz> restores a local snapshot file, objects from the bucket.
            string fromFile = null;
            if (args.Length >= 2 && args[0] == "--from")
            {
                fromFile = args[1];
                var rest = new string[args.Length - 2]; Array.Copy(args, 2, rest, 0, rest.Length); args = rest;
            }
            if (args.Length < 3 || args.Length > 4)
            {
                Console.Error.WriteLine("usage: s3cab-restore.exe <bucket> <set> <dir> [<snapshot>]");
                return 2;
            }
            string bucket = args[0], set = args[1], dir = args[2];
            if (set.Length == 0 || set.IndexOf('/') >= 0) throw new FatalException("bad set name");
            var s3 = ClientFromEnv(bucket);
            string key;
            byte[] gz;
            if (fromFile != null)
            {
                key = fromFile;
                gz = File.ReadAllBytes(fromFile);
            }
            else
            {
                string name;
                if (args.Length == 4)
                {
                    name = args[3];
                    if (name.EndsWith(".tsv.gz", StringComparison.Ordinal)) name = name.Substring(0, name.Length - 7);
                }
                else
                {
                    var names = SnapshotNames(s3, set);
                    if (names.Count == 0) throw new FatalException("set " + set + " has no snapshot in " + bucket);
                    name = names[names.Count - 1];
                }
                key = "snapshots/" + set + "/" + name + ".tsv.gz";
                bool missing;
                gz = s3.Get(key, out missing);
                if (missing) throw new FatalException("no such snapshot: " + key);
            }
            Console.Error.WriteLine("snapshot: " + key);
            byte[] text;
            try { text = Gzip.DecompressAll(gz); }
            catch (RefusedException e) { throw new RefusedException(key + ": " + e.Message); }
            SnapshotDoc snap;
            try { snap = Tsv.ParseSnapshot(text); }
            catch (RefusedException e) { throw new RefusedException(key + ": " + e.Message); }
            Console.Error.WriteLine("rows: " + snap.Files.Count + " file rows, " + snap.Dirs.Count + " @SET DIR rows, START " + (snap.Start ?? "(none)"));
            string output = Restorer.PrepareOutput(dir);
            var r = new Restorer(s3, output, snap);
            r.Run();
            Console.Error.WriteLine("done: restored " + r.Restored + ", skipped " + r.SkippedExisting + " already there, deleted " + r.Deleted
                + ", damaged " + r.Damaged + ", refused " + r.Refused + ", collisions " + r.Collisions + ", in the way " + r.InTheWay
                + ", uncreatable " + r.Uncreatable + ", time not held " + r.TimeNotHeld + ", time rounded " + r.TimeRounded
                + "; " + s3.Requests + " requests");
            return r.Failed ? 1 : 0;
        }

        static void PrintDoc(SnapshotDoc doc)
        {
            foreach (var d in doc.DirTexts) Console.WriteLine("DIR\t" + d);
            Console.WriteLine("START\t" + (doc.Start ?? "(none)"));
            foreach (var fr in doc.Files)
                Console.WriteLine((fr.Refusal == null ? "ok" : "refused (" + fr.Refusal + ")") + "\t" + fr.Hash + "\t" + fr.Mtime + "\t" + fr.Path);
        }
    }
}
