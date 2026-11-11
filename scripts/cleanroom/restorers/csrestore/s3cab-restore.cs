// s3cab-restore: an independent restorer for the s3cab repository format, written from
// format.md alone. .NET Framework 4.8, C# 5, standard library only; no AWS SDK, no S3 client.
//
//   s3cab-restore.exe <bucket> <set> <dir> [<snapshot>]
//   s3cab-restore.exe --parse <file.tsv.gz|file.tsv>      (parser check on a local file)
//
// Credentials and region come from AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
// AWS_SESSION_TOKEN and AWS_REGION.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Xml;
using Microsoft.Win32.SafeHandles;

// Turns on the post-4.6.2 path handling so \\?\ paths and long paths work (spec hint).
[assembly: TargetFramework(".NETFramework,Version=v4.8", FrameworkDisplayName = ".NET Framework 4.8")]

namespace S3cabRestore
{
    // ----------------------------------------------------------------------------------
    // Exceptions
    // ----------------------------------------------------------------------------------

    /// Stops the whole restore (403, NoSuchBucket, retries exhausted, listing failure...).
    class StopException : Exception { public StopException(string m) : base(m) { } }

    /// A connection that was reset, refused, timed out, or dropped mid-body.
    class DroppedException : Exception { public DroppedException(string m, Exception inner) : base(m, inner) { } }

    /// A 5xx answer.
    class ServerErrorException : Exception
    {
        public int Status; public string Code;
        public ServerErrorException(int s, string c) : base("HTTP " + s + " " + c) { Status = s; Code = c; }
    }

    /// The snapshot is refused whole.
    class RefusedFileException : Exception { public RefusedFileException(string m) : base(m) { } }

    // ----------------------------------------------------------------------------------
    // Text rules: trim set, field split, instants, display
    // ----------------------------------------------------------------------------------

    static class Text
    {
        public static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);
        public static readonly UTF8Encoding Utf8NoBom = new UTF8Encoding(false, false);

        // JavaScript's trim() set, exactly, written with escapes (the spec's hint about csc).
        public static bool IsTrim(char c)
        {
            if (c >= '\u0009' && c <= '\u000D') return true;
            if (c == '\u0020' || c == '\u00A0' || c == '\u1680') return true;
            if (c >= '\u2000' && c <= '\u200A') return true;
            if (c == '\u202F' || c == '\u205F' || c == '\u3000') return true;
            if (c == '\u2028' || c == '\u2029' || c == '\uFEFF') return true;
            return false;
        }

        public static string Trim(string s)
        {
            int a = 0, b = s.Length;
            while (a < b && IsTrim(s[a])) a++;
            while (b > a && IsTrim(s[b - 1])) b--;
            return s.Substring(a, b - a);
        }

        /// Five fields split at the first four tabs; missing ones read as empty; the last is
        /// everything after the fourth tab, verbatim.
        public static string[] Fields(string line)
        {
            string[] f = new string[5];
            int start = 0, n = 0;
            for (int i = 0; i < line.Length && n < 4; i++)
            {
                if (line[i] == '\t') { f[n++] = line.Substring(start, i - start); start = i + 1; }
            }
            f[n++] = line.Substring(start);
            for (; n < 5; n++) f[n] = "";
            return f;
        }

        public static bool IsHex64(string s)
        {
            if (s.Length != 64) return false;
            foreach (char c in s) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
            return true;
        }

        public static bool IsDigits(string s)
        {
            if (s.Length == 0) return false;
            foreach (char c in s) if (c < '0' || c > '9') return false;
            return true;
        }

        static bool IsLeap(long y) { return (y % 4 == 0 && y % 100 != 0) || y % 400 == 0; }

        static int DaysInMonth(long y, int m)
        {
            switch (m)
            {
                case 1: case 3: case 5: case 7: case 8: case 10: case 12: return 31;
                case 4: case 6: case 9: case 11: return 30;
                default: return IsLeap(y) ? 29 : 28;
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

        static int Num(string s, int at, int len)
        {
            return int.Parse(s.Substring(at, len), NumberStyles.None, CultureInfo.InvariantCulture);
        }

        /// The 24-character form YYYY-MM-DDTHH:MM:SS.sssZ, and a real instant. Milliseconds since
        /// 1970 out (may be negative).
        public static bool IsInstant(string s, out long ms)
        {
            ms = 0;
            if (s == null || s.Length != 24) return false;
            int[] digits = { 0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22 };
            foreach (int p in digits) if (s[p] < '0' || s[p] > '9') return false;
            if (s[4] != '-' || s[7] != '-' || s[10] != 'T' || s[13] != ':' || s[16] != ':' || s[19] != '.' || s[23] != 'Z') return false;
            int y = Num(s, 0, 4), mo = Num(s, 5, 2), d = Num(s, 8, 2), h = Num(s, 11, 2), mi = Num(s, 14, 2), se = Num(s, 17, 2), f = Num(s, 20, 3);
            if (mo < 1 || mo > 12) return false;
            if (d < 1 || d > DaysInMonth(y, mo)) return false;
            if (h > 23 || mi > 59 || se > 59) return false;
            long days = DaysFromCivil(y, mo, d);
            ms = (days * 86400L + h * 3600L + mi * 60L + se) * 1000L + f;
            return true;
        }

        /// Milliseconds since 1970 back to the 24-character form (for messages).
        public static string FormatInstant(long ms)
        {
            long days = FloorDiv(ms, 86400000L);
            long rem = ms - days * 86400000L;
            // civil from days (Hinnant)
            long z = days + 719468;
            long era = (z >= 0 ? z : z - 146096) / 146097;
            long doe = z - era * 146097;
            long yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
            long y = yoe + era * 400;
            long doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
            long mp = (5 * doy + 2) / 153;
            long d = doy - (153 * mp + 2) / 5 + 1;
            long m = mp < 10 ? mp + 3 : mp - 9;
            if (m <= 2) y++;
            long h = rem / 3600000; rem -= h * 3600000;
            long mi = rem / 60000; rem -= mi * 60000;
            long se = rem / 1000; rem -= se * 1000;
            return string.Format(CultureInfo.InvariantCulture, "{0:D4}-{1:D2}-{2:D2}T{3:D2}:{4:D2}:{5:D2}.{6:D3}Z", y, m, d, h, mi, se, rem);
        }

        public static long FloorDiv(long a, long b)
        {
            long q = a / b;
            if ((a % b != 0) && ((a < 0) != (b < 0))) q--;
            return q;
        }

        /// A path for printing: control characters spelled out so a terminal can't be fooled.
        public static string Show(string s)
        {
            if (s == null) return "(null)";
            StringBuilder sb = null;
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                bool bad = c < 0x20 || (c >= 0x7F && c <= 0x9F) || c == '\u2028' || c == '\u2029' || char.IsSurrogate(c) && !IsPairAt(s, i);
                if (bad)
                {
                    if (sb == null) { sb = new StringBuilder(); sb.Append(s, 0, i); }
                    sb.Append("<U+").Append(((int)c).ToString("X4")).Append('>');
                }
                else if (sb != null) sb.Append(c);
            }
            return sb == null ? s : sb.ToString();
        }

        static bool IsPairAt(string s, int i)
        {
            if (char.IsHighSurrogate(s[i])) return i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]);
            if (char.IsLowSurrogate(s[i])) return i > 0 && char.IsHighSurrogate(s[i - 1]);
            return false;
        }

        public static string Hex(byte[] b)
        {
            StringBuilder sb = new StringBuilder(b.Length * 2);
            foreach (byte x in b) sb.Append(x.ToString("x2"));
            return sb.ToString();
        }
    }

    // ----------------------------------------------------------------------------------
    // Unicode lowercase as JavaScript's toLowerCase(): ICU's root-locale u_strToLower when
    // Windows' icu.dll is there, else a per-character fallback with Final_Sigma and U+0130.
    // ----------------------------------------------------------------------------------

    static class Casing
    {
        [DllImport("icu.dll", ExactSpelling = true, CallingConvention = CallingConvention.Cdecl, CharSet = CharSet.Unicode)]
        static extern int u_strToLower([Out] char[] dest, int destCapacity,
            [MarshalAs(UnmanagedType.LPWStr)] string src, int srcLength,
            [MarshalAs(UnmanagedType.LPStr)] string locale, ref int pErrorCode);

        static bool tried, icuOk;
        public static bool UsingIcu { get { Lower("A"); return icuOk; } }

        public static string Lower(string s)
        {
            if (s.Length == 0) return s;
            if (!tried)
            {
                tried = true;
                try
                {
                    string probe = Icu("ΟΔΟΣ İ");
                    icuOk = probe == "οδος i̇";
                    if (!icuOk) Console.Error.WriteLine("icu: u_strToLower gave '" + probe + "', using the fallback");
                }
                catch (Exception e) { icuOk = false; Console.Error.WriteLine("icu: unavailable (" + e.GetType().Name + ": " + e.Message + "), using the fallback"); }
                if (icuOk) try { icuOk = Icu("ΟΔΟΣ İ") == "οδος i\u0307"; } catch (Exception) { icuOk = false; }
            }
            if (icuOk)
            {
                try { return Icu(s); } catch (Exception) { }
            }
            return Fallback(s);
        }

        static string Icu(string s)
        {
            int cap = s.Length * 3 + 16;
            char[] buf = new char[cap];
            int err = 0;
            int n = u_strToLower(buf, cap, s, s.Length, "", ref err);
            if (err > 0 || n < 0 || n > cap) throw new InvalidOperationException("icu error " + err);
            return new string(buf, 0, n);
        }

        static bool IsCased(char c)
        {
            UnicodeCategory cat = char.GetUnicodeCategory(c);
            return cat == UnicodeCategory.UppercaseLetter || cat == UnicodeCategory.LowercaseLetter || cat == UnicodeCategory.TitlecaseLetter;
        }

        static bool IsCaseIgnorable(char c)
        {
            UnicodeCategory cat = char.GetUnicodeCategory(c);
            if (cat == UnicodeCategory.NonSpacingMark || cat == UnicodeCategory.EnclosingMark || cat == UnicodeCategory.Format
                || cat == UnicodeCategory.ModifierLetter || cat == UnicodeCategory.ModifierSymbol) return true;
            return "'.:\u2018\u2019\u2024\u00B7\u0387\u05F4\u2027\uFE13\uFE52\uFE55\uFF07\uFF0E\uFF1A".IndexOf(c) >= 0;
        }

        static bool FinalSigma(string s, int i)
        {
            int j = i - 1;
            while (j >= 0 && IsCaseIgnorable(s[j])) j--;
            if (j < 0 || !IsCased(s[j])) return false;
            j = i + 1;
            while (j < s.Length && IsCaseIgnorable(s[j])) j++;
            return j >= s.Length || !IsCased(s[j]);
        }

        static string Fallback(string s)
        {
            StringBuilder sb = new StringBuilder(s.Length + 4);
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                if (c == '\u0130') sb.Append("i\u0307");
                else if (c == '\u03A3') sb.Append(FinalSigma(s, i) ? '\u03C2' : '\u03C3');
                else sb.Append(char.ToLowerInvariant(c));
            }
            return sb.ToString();
        }
    }

    // ----------------------------------------------------------------------------------
    // CRC-32 (gzip's), since the standard library has none.
    // ----------------------------------------------------------------------------------

    static class Crc32
    {
        static readonly uint[] T = Make();
        static uint[] Make()
        {
            uint[] t = new uint[256];
            for (uint i = 0; i < 256; i++)
            {
                uint c = i;
                for (int k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
                t[i] = c;
            }
            return t;
        }
        public static uint Update(uint crc, byte[] buf, int off, int len)
        {
            uint c = crc ^ 0xFFFFFFFFu;
            for (int i = off; i < off + len; i++) c = T[(c ^ buf[i]) & 0xFF] ^ (c >> 8);
            return c ^ 0xFFFFFFFFu;
        }
    }

    // ----------------------------------------------------------------------------------
    // gzip: every member in turn, header fields and CRC checked, trailer checked, a zero byte
    // after a member ends the file, anything else there is damage. DeflateStream does the
    // inflating, fed one byte per Read so it stops exactly where the deflate data ends.
    // ----------------------------------------------------------------------------------

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

    static class Gzip
    {
        public static byte[] Decompress(byte[] data, out int members)
        {
            members = 0;
            MemoryStream outp = new MemoryStream();
            int pos = 0;
            while (true)
            {
                if (pos >= data.Length)
                {
                    if (members == 0) throw new RefusedFileException("gzip: empty file");
                    break;
                }
                if (members > 0 && data[pos] == 0) break; // a zero byte after a stream ends the file
                if (data[pos] != 0x1F || (pos + 1 < data.Length && data[pos + 1] != 0x8B))
                    throw new RefusedFileException(members == 0 ? "gzip: not a gzip file (bad magic)" : "gzip: bytes after a stream that don't start another, at byte " + pos);
                if (pos + 10 > data.Length) throw new RefusedFileException("gzip: header cut short at byte " + pos);
                if (data[pos + 2] != 8) throw new RefusedFileException("gzip: compression method isn't deflate");
                int flg = data[pos + 3];
                if ((flg & 0xE0) != 0) throw new RefusedFileException("gzip: reserved flag bit set");
                int hstart = pos;
                pos += 10;
                if ((flg & 4) != 0)
                {
                    if (pos + 2 > data.Length) throw new RefusedFileException("gzip: extra field cut short");
                    int xlen = data[pos] | (data[pos + 1] << 8);
                    pos += 2 + xlen;
                    if (pos > data.Length) throw new RefusedFileException("gzip: extra field cut short");
                }
                if ((flg & 8) != 0) pos = SkipZ(data, pos, "name");
                if ((flg & 16) != 0) pos = SkipZ(data, pos, "comment");
                if ((flg & 2) != 0)
                {
                    if (pos + 2 > data.Length) throw new RefusedFileException("gzip: header CRC cut short");
                    uint want = (uint)(data[pos] | (data[pos + 1] << 8));
                    uint have = Crc32.Update(0, data, hstart, pos - hstart) & 0xFFFF;
                    if (want != have) throw new RefusedFileException("gzip: header CRC mismatch");
                    pos += 2;
                }
                OneByteStream one = new OneByteStream(data, pos);
                uint crc = 0; long len = 0;
                byte[] buf = new byte[65536];
                try
                {
                    using (DeflateStream ds = new DeflateStream(one, CompressionMode.Decompress, true))
                    {
                        int n;
                        while ((n = ds.Read(buf, 0, buf.Length)) > 0)
                        {
                            outp.Write(buf, 0, n);
                            crc = Crc32.Update(crc, buf, 0, n);
                            len += n;
                        }
                    }
                }
                catch (InvalidDataException e) { throw new RefusedFileException("gzip: deflate data is damaged: " + e.Message); }
                pos = one.Pos;
                if (pos + 8 > data.Length) throw new RefusedFileException("gzip: stream cut short (no trailer)");
                uint wantCrc = (uint)(data[pos] | (data[pos + 1] << 8) | (data[pos + 2] << 16) | (data[pos + 3] << 24));
                uint wantLen = (uint)(data[pos + 4] | (data[pos + 5] << 8) | (data[pos + 6] << 16) | (data[pos + 7] << 24));
                if (wantCrc != crc) throw new RefusedFileException("gzip: CRC-32 mismatch");
                if (wantLen != (uint)(len & 0xFFFFFFFF)) throw new RefusedFileException("gzip: length mismatch");
                pos += 8;
                members++;
            }
            return outp.ToArray();
        }

        static int SkipZ(byte[] d, int pos, string what)
        {
            while (pos < d.Length && d[pos] != 0) pos++;
            if (pos >= d.Length) throw new RefusedFileException("gzip: " + what + " field cut short");
            return pos + 1;
        }
    }

    // ----------------------------------------------------------------------------------
    // Paths: kind, root, segments, @SET DIR matching
    // ----------------------------------------------------------------------------------

    enum PathKind { None, Posix, Drive, Share }

    class PPath
    {
        public PathKind Kind;
        public char Drive;              // lowercase letter for Drive
        public List<string> Segs;       // past the root; for a share, server and share name first
        public List<string> Lower;      // Windows kinds only: each segment lowercased
        public bool IsWindows { get { return Kind == PathKind.Drive || Kind == PathKind.Share; } }

        static bool IsAsciiLetter(char c) { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'); }

        public static PathKind KindOf(string p)
        {
            if (p.Length >= 3 && IsAsciiLetter(p[0]) && p[1] == ':' && (p[2] == '\\' || p[2] == '/')) return PathKind.Drive;
            if (p.Length >= 2 && (p[0] == '\\' || p[0] == '/') && (p[1] == '\\' || p[1] == '/')) return PathKind.Share;
            if (p.Length >= 1 && p[0] == '/') return PathKind.Posix;
            return PathKind.None;
        }

        static List<string> SplitSegs(string rest, bool win)
        {
            if (rest.Length == 0) return new List<string>();
            return new List<string>(win ? rest.Split('\\', '/') : rest.Split('/'));
        }

        static PPath Make(PathKind k, string p, List<string> segs)
        {
            PPath r = new PPath { Kind = k, Segs = segs };
            if (k == PathKind.Drive) r.Drive = char.ToLowerInvariant(p[0]);
            if (r.IsWindows)
            {
                r.Lower = new List<string>(segs.Count);
                foreach (string s in segs) r.Lower.Add(Casing.Lower(s));
            }
            return r;
        }

        /// A file row's path. Null, with a reason, when the row is to be refused.
        public static PPath ParseFile(string p, out string why)
        {
            why = null;
            if (p.IndexOf('\t') >= 0) { why = "path holds a tab"; return null; }
            if (p.IndexOf('\r') >= 0) { why = "path holds a CR"; return null; }
            if (p.IndexOf('\0') >= 0) { why = "path holds a NUL"; return null; }
            PathKind k = KindOf(p);
            if (k == PathKind.None) { why = "path isn't absolute"; return null; }
            bool win = k != PathKind.Posix;
            string rest = p.Substring(k == PathKind.Drive ? 3 : k == PathKind.Share ? 2 : 1);
            List<string> segs = SplitSegs(rest, win);
            if (segs.Count == 0) { why = "path has no name past its root"; return null; }
            foreach (string s in segs)
            {
                if (s.Length == 0) { why = "path has an empty segment (doubled or trailing separator)"; return null; }
                if (s == "." || s == "..") { why = "path has a '.' or '..' segment"; return null; }
            }
            return Make(k, p, segs);
        }

        /// A @SET DIR row's value. Null when it matches nothing.
        public static PPath ParseDir(string p)
        {
            PathKind k = KindOf(p);
            if (k == PathKind.None) return null;
            if (p.IndexOf('\0') >= 0) return null;
            bool win = k != PathKind.Posix;
            string rest = p.Substring(k == PathKind.Drive ? 3 : k == PathKind.Share ? 2 : 1);
            int end = rest.Length;
            while (end > 0 && (rest[end - 1] == '/' || (win && rest[end - 1] == '\\'))) end--;
            rest = rest.Substring(0, end);
            List<string> segs = SplitSegs(rest, win);
            foreach (string s in segs) if (s.Length == 0) return null;
            if (k == PathKind.Share && segs.Count < 2) return null;
            return Make(k, p, segs);
        }

        public static bool SameRoot(PPath a, PPath b)
        {
            if (a.Kind != b.Kind) return false;
            if (a.Kind == PathKind.Drive) return a.Drive == b.Drive;
            return true;
        }

        static bool SegEq(PPath a, int i, PPath b, int j)
        {
            if (a.IsWindows) return string.Equals(a.Lower[i], b.Lower[j], StringComparison.Ordinal);
            return string.Equals(a.Segs[i], b.Segs[j], StringComparison.Ordinal);
        }

        public static bool StrictlyUnder(PPath dir, PPath p)
        {
            if (!SameRoot(dir, p)) return false;
            if (p.Segs.Count <= dir.Segs.Count) return false;
            for (int i = 0; i < dir.Segs.Count; i++) if (!SegEq(dir, i, p, i)) return false;
            return true;
        }

        public static bool SegsEqual(PPath dir, PPath p)
        {
            if (!SameRoot(dir, p)) return false;
            if (p.Segs.Count != dir.Segs.Count) return false;
            for (int i = 0; i < dir.Segs.Count; i++) if (!SegEq(dir, i, p, i)) return false;
            return true;
        }
    }

    // ----------------------------------------------------------------------------------
    // Snapshot parsing and validation
    // ----------------------------------------------------------------------------------

    class FileRow
    {
        public int Line;
        public string Hash, Size, Mtime, Path;
        public long MtimeMs;
        public PPath P;
        public string Refusal;
        public void Refuse(string why) { if (Refusal == null) Refusal = why; }
    }

    class Snapshot
    {
        public List<FileRow> Files = new List<FileRow>();
        public List<string> DirRows = new List<string>();
        public List<PPath> Dirs = new List<PPath>();
        public string Start;          // null when none, or not a real instant
        public string StartRaw;       // what the last START row held, for messages
        public int Lines;

        public const string HeadingUrl = "https://s3cab.plantegral.com/guide/format";

        static bool IsHeading(string line)
        {
            string[] f = Text.Fields(line);
            return Text.Trim(f[0]) == "@S3CAB" && Text.Trim(f[1]) == "FORMAT" && Text.Trim(f[2]) == "size"
                && Text.Trim(f[3]) == "time" && f[4] == HeadingUrl;
        }

        public static Snapshot Parse(byte[] bytes)
        {
            string text;
            try { text = Text.StrictUtf8.GetString(bytes); }
            catch (DecoderFallbackException) { throw new RefusedFileException("not valid UTF-8"); }
            if (text.Length > 0 && text[0] == '\uFEFF') text = text.Substring(1);
            if (text.Length == 0) throw new RefusedFileException("empty file");
            if (text[text.Length - 1] != '\n') throw new RefusedFileException("last line has no LF: the file was cut short");
            string[] lines = text.Substring(0, text.Length - 1).Split('\n');
            if (!IsHeading(lines[0])) throw new RefusedFileException("first line isn't the heading row");
            if (lines.Length < 2 || lines[lines.Length - 1] != ".") throw new RefusedFileException("last line isn't '.': the file was cut short or damaged");
            Snapshot sn = new Snapshot();
            sn.Lines = lines.Length;
            string lastStart = null; bool sawStart = false;
            for (int i = 1; i < lines.Length - 1; i++)
            {
                string line = lines[i];
                if (Text.Trim(line).Length == 0) throw new RefusedFileException("blank line " + (i + 1));
                string[] f = Text.Fields(line);
                string type = Text.Trim(f[0]);
                if (type == "-")
                {
                    sn.Files.Add(new FileRow { Line = i + 1, Hash = Text.Trim(f[1]), Size = Text.Trim(f[2]), Mtime = Text.Trim(f[3]), Path = f[4] });
                }
                else if (type.Length > 0 && type[0] == '@')
                {
                    string prop = Text.Trim(f[1]);
                    if (type == "@SET" && prop == "DIR") { if (f[4].Length > 0) sn.DirRows.Add(f[4]); }
                    else if (type == "@SNAPSHOT" && prop == "START") { sawStart = true; lastStart = Text.Trim(f[3]); }
                }
                else if (type.Length > 0 && type[0] == '#') { }
                else throw new RefusedFileException("unknown row type '" + Text.Show(type) + "' on line " + (i + 1));
            }
            long dummy;
            sn.StartRaw = lastStart;
            sn.Start = (sawStart && Text.IsInstant(lastStart, out dummy)) ? lastStart : null;
            sn.Validate();
            return sn;
        }

        void Validate()
        {
            foreach (FileRow r in Files)
            {
                if (!Text.IsHex64(r.Hash)) r.Refuse("hash isn't 64 lowercase hex characters");
                if (!Text.IsDigits(r.Size)) r.Refuse("size isn't decimal digits");
                if (!Text.IsInstant(r.Mtime, out r.MtimeMs)) r.Refuse("time isn't a real instant in the 24-character form");
                string why;
                r.P = PPath.ParseFile(r.Path, out why);
                if (r.P == null) r.Refuse(why);
            }
            // one path in two rows: every file row takes part, malformed ones included
            Dictionary<string, int> count = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (FileRow r in Files) { int c; count.TryGetValue(r.Path, out c); count[r.Path] = c + 1; }
            foreach (FileRow r in Files) if (count[r.Path] > 1) r.Refuse("path is in more than one file row");
            // @SET DIR
            foreach (string raw in DirRows) { PPath d = PPath.ParseDir(raw); if (d != null) Dirs.Add(d); }
            foreach (FileRow r in Files)
            {
                if (r.Refusal != null) continue;
                bool under = false, equal = false;
                foreach (PPath d in Dirs)
                {
                    if (PPath.SegsEqual(d, r.P)) equal = true;
                    else if (PPath.StrictlyUnder(d, r.P)) under = true;
                }
                if (equal) r.Refuse("path equals a @SET DIR");
                else if (!under) r.Refuse("path is under no @SET DIR");
            }
            // one path running through another as a folder, last, among what's left
            Dictionary<string, FileRow> ok = new Dictionary<string, FileRow>(StringComparer.Ordinal);
            foreach (FileRow r in Files) if (r.Refusal == null) ok[r.Path] = r;
            List<KeyValuePair<FileRow, string>> marks = new List<KeyValuePair<FileRow, string>>();
            foreach (FileRow r in ok.Values)
            {
                string p = r.Path; bool win = r.P.IsWindows;
                for (int i = 1; i < p.Length; i++)
                {
                    if (p[i] == '/' || (win && p[i] == '\\'))
                    {
                        FileRow other;
                        if (ok.TryGetValue(p.Substring(0, i), out other))
                        {
                            marks.Add(new KeyValuePair<FileRow, string>(r, "path runs through another file row's path (line " + other.Line + ")"));
                            marks.Add(new KeyValuePair<FileRow, string>(other, "another file row's path (line " + r.Line + ") runs through this one"));
                        }
                    }
                }
            }
            foreach (KeyValuePair<FileRow, string> m in marks) m.Key.Refuse(m.Value);
        }
    }

    // ----------------------------------------------------------------------------------
    // Deletion records
    // ----------------------------------------------------------------------------------

    static class Records
    {
        /// hash -> newest instant among well-formed #deleted rows, from the bytes of one record.
        public static void Read(byte[] bytes, Dictionary<string, string> into)
        {
            int start = 0;
            while (true)
            {
                int lf = Array.IndexOf(bytes, (byte)'\n', start);
                if (lf < 0) break; // a last row with no LF explains nothing
                string line;
                try { line = Text.StrictUtf8.GetString(bytes, start, lf - start); }
                catch (DecoderFallbackException) { start = lf + 1; continue; }
                start = lf + 1;
                if (line == ".") break;
                string[] f = Text.Fields(line);
                if (Text.Trim(f[0]) != "#deleted") continue;
                string hash = Text.Trim(f[1]), size = Text.Trim(f[2]), when = Text.Trim(f[3]);
                long ms;
                if (!Text.IsHex64(hash) || !Text.IsDigits(size) || !Text.IsInstant(when, out ms)) continue;
                string have;
                if (!into.TryGetValue(hash, out have) || string.CompareOrdinal(when, have) > 0) into[hash] = when;
            }
        }
    }

    // ----------------------------------------------------------------------------------
    // S3 over plain HTTPS with SigV4, no SDK
    // ----------------------------------------------------------------------------------

    class Resp
    {
        public int Status; public string Code; public byte[] Body; public Stream Sink;
    }

    class HashSink : Stream
    {
        readonly Stream inner; readonly SHA256 sha = SHA256.Create(); byte[] hash;
        public long Length2;
        public HashSink(Stream inner) { this.inner = inner; }
        public override void Write(byte[] b, int o, int c) { inner.Write(b, o, c); sha.TransformBlock(b, o, c, null, 0); Length2 += c; }
        public string HexHash { get { if (hash == null) { sha.TransformFinalBlock(new byte[0], 0, 0); hash = sha.Hash; } return Text.Hex(hash); } }
        public override bool CanRead { get { return false; } }
        public override bool CanSeek { get { return false; } }
        public override bool CanWrite { get { return true; } }
        public override long Length { get { throw new NotSupportedException(); } }
        public override long Position { get { throw new NotSupportedException(); } set { throw new NotSupportedException(); } }
        public override void Flush() { inner.Flush(); }
        public override int Read(byte[] b, int o, int c) { throw new NotSupportedException(); }
        public override long Seek(long o, SeekOrigin s) { throw new NotSupportedException(); }
        public override void SetLength(long v) { throw new NotSupportedException(); }
    }

    class S3
    {
        readonly string bucket, region, akid, secret, token, host;
        readonly Random rnd = new Random();
        public int Requests;
        static readonly string EmptySha256 = Text.Hex(SHA256.Create().ComputeHash(new byte[0]));

        public S3(string bucket, string region, string akid, string secret, string token)
        {
            this.bucket = bucket; this.region = region; this.akid = akid; this.secret = secret; this.token = token;
            host = bucket + ".s3." + region + ".amazonaws.com";
            ServicePointManager.Expect100Continue = false;
        }

        // RFC 3986 unreserved characters kept, everything else percent-encoded from UTF-8.
        public static string UriEncode(string s, bool encodeSlash)
        {
            StringBuilder sb = new StringBuilder();
            foreach (byte b in Encoding.UTF8.GetBytes(s))
            {
                char c = (char)b;
                if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') sb.Append(c);
                else if (c == '/' && !encodeSlash) sb.Append(c);
                else sb.Append('%').Append(b.ToString("X2"));
            }
            return sb.ToString();
        }

        static byte[] Hmac(byte[] key, string data)
        {
            using (HMACSHA256 h = new HMACSHA256(key)) return h.ComputeHash(Encoding.UTF8.GetBytes(data));
        }

        HttpWebRequest Build(string method, string key, SortedDictionary<string, string> query)
        {
            string canonicalUri = "/" + UriEncode(key, false);
            StringBuilder q = new StringBuilder();
            if (query != null)
            {
                SortedDictionary<string, string> enc = new SortedDictionary<string, string>(StringComparer.Ordinal);
                foreach (KeyValuePair<string, string> kv in query) enc[UriEncode(kv.Key, true)] = UriEncode(kv.Value, true);
                foreach (KeyValuePair<string, string> kv in enc)
                {
                    if (q.Length > 0) q.Append('&');
                    q.Append(kv.Key).Append('=').Append(kv.Value);
                }
            }
            string canonicalQuery = q.ToString();
            string url = "https://" + host + canonicalUri + (canonicalQuery.Length > 0 ? "?" + canonicalQuery : "");

            DateTime now = DateTime.UtcNow;
            string amzDate = now.ToString("yyyyMMdd'T'HHmmss'Z'", CultureInfo.InvariantCulture);
            string date = now.ToString("yyyyMMdd", CultureInfo.InvariantCulture);

            SortedDictionary<string, string> headers = new SortedDictionary<string, string>(StringComparer.Ordinal);
            headers["host"] = host;
            headers["x-amz-content-sha256"] = EmptySha256;
            headers["x-amz-date"] = amzDate;
            if (!string.IsNullOrEmpty(token)) headers["x-amz-security-token"] = token;

            StringBuilder ch = new StringBuilder(); StringBuilder sh = new StringBuilder();
            foreach (KeyValuePair<string, string> kv in headers)
            {
                ch.Append(kv.Key).Append(':').Append(kv.Value.Trim()).Append('\n');
                if (sh.Length > 0) sh.Append(';');
                sh.Append(kv.Key);
            }
            string signedHeaders = sh.ToString();
            string canonicalRequest = method + "\n" + canonicalUri + "\n" + canonicalQuery + "\n" + ch.ToString() + "\n" + signedHeaders + "\n" + EmptySha256;
            string scope = date + "/" + region + "/s3/aws4_request";
            string stringToSign = "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + Text.Hex(SHA256.Create().ComputeHash(Encoding.UTF8.GetBytes(canonicalRequest)));
            byte[] kDate = Hmac(Encoding.UTF8.GetBytes("AWS4" + secret), date);
            byte[] kRegion = Hmac(kDate, region);
            byte[] kService = Hmac(kRegion, "s3");
            byte[] kSigning = Hmac(kService, "aws4_request");
            string signature = Text.Hex(Hmac(kSigning, stringToSign));

            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(new Uri(url));
            req.Method = method;
            req.AllowAutoRedirect = false;
            req.AutomaticDecompression = DecompressionMethods.None;
            req.KeepAlive = true;
            req.Timeout = 20000;
            req.ReadWriteTimeout = 30000;
            req.UserAgent = "s3cab-restore/0.1 (independent, no SDK)";
            foreach (KeyValuePair<string, string> kv in headers) if (kv.Key != "host") req.Headers[kv.Key] = kv.Value;
            req.Headers["Authorization"] = "AWS4-HMAC-SHA256 Credential=" + akid + "/" + scope + ", SignedHeaders=" + signedHeaders + ", Signature=" + signature;
            return req;
        }

        static bool IsDropped(WebExceptionStatus s)
        {
            switch (s)
            {
                case WebExceptionStatus.ConnectFailure:
                case WebExceptionStatus.NameResolutionFailure:
                case WebExceptionStatus.ProxyNameResolutionFailure:
                case WebExceptionStatus.ReceiveFailure:
                case WebExceptionStatus.SendFailure:
                case WebExceptionStatus.PipelineFailure:
                case WebExceptionStatus.ConnectionClosed:
                case WebExceptionStatus.KeepAliveFailure:
                case WebExceptionStatus.Timeout:
                case WebExceptionStatus.UnknownError:
                    return true;
                default:
                    return false;
            }
        }

        static string ErrorCode(byte[] body)
        {
            if (body == null || body.Length == 0) return "";
            string s; try { s = Encoding.UTF8.GetString(body); } catch (Exception) { return ""; }
            Match m = Regex.Match(s, "<Code>([^<]*)</Code>");
            return m.Success ? m.Groups[1].Value : "";
        }

        static byte[] ReadAll(Stream s)
        {
            using (MemoryStream ms = new MemoryStream()) { if (s != null) s.CopyTo(ms); return ms.ToArray(); }
        }

        /// One request with the spec's retries. For a 2xx the body is streamed into a sink the
        /// factory makes afresh per attempt; otherwise the error body and code come back.
        public Resp Request(string method, string key, SortedDictionary<string, string> query, Func<Stream> sinkFactory)
        {
            DateTime firstDrop = DateTime.MinValue; double dropCeil = 0.5;
            int serverAttempts = 0; double serverCeil = 0;
            while (true)
            {
                try
                {
                    Requests++;
                    HttpWebRequest req = Build(method, key, query);
                    HttpWebResponse resp;
                    try { resp = (HttpWebResponse)req.GetResponse(); }
                    catch (WebException e)
                    {
                        if (e.Response != null) resp = (HttpWebResponse)e.Response;
                        else if (IsDropped(e.Status)) throw new DroppedException(e.Status + ": " + e.Message, e);
                        else throw new StopException("request failed (" + e.Status + "): " + e.Message);
                    }
                    using (resp)
                    {
                        int status = (int)resp.StatusCode;
                        if (status >= 200 && status < 300)
                        {
                            Stream sink = sinkFactory();
                            try { using (Stream s = resp.GetResponseStream()) s.CopyTo(sink, 65536); }
                            catch (IOException e) { throw new DroppedException("connection dropped while reading the body: " + e.Message, e); }
                            catch (WebException e) { throw new DroppedException("connection dropped while reading the body: " + e.Message, e); }
                            sink.Flush();
                            return new Resp { Status = status, Sink = sink };
                        }
                        byte[] body;
                        try { body = ReadAll(resp.GetResponseStream()); } catch (Exception) { body = new byte[0]; }
                        string code = ErrorCode(body);
                        if (status >= 500) throw new ServerErrorException(status, code);
                        return new Resp { Status = status, Code = code, Body = body };
                    }
                }
                catch (DroppedException e)
                {
                    if (firstDrop == DateTime.MinValue) firstDrop = DateTime.UtcNow;
                    if ((DateTime.UtcNow - firstDrop).TotalSeconds >= 120) throw new StopException("the connection kept dropping for two minutes: " + e.Message);
                    Console.Error.WriteLine("retrying after a dropped connection: " + e.Message);
                    Thread.Sleep((int)(rnd.NextDouble() * dropCeil * 1000));
                    dropCeil = Math.Min(2.0, dropCeil * 2);
                }
                catch (ServerErrorException e)
                {
                    serverAttempts++;
                    if (serverAttempts >= 3) throw new StopException("server error after 3 attempts: " + e.Message);
                    serverCeil = serverAttempts == 1 ? (e.Status == 503 ? 0.5 : 0.1) : Math.Min(20.0, serverCeil * 2);
                    Console.Error.WriteLine("retrying after " + e.Message);
                    Thread.Sleep((int)(rnd.NextDouble() * serverCeil * 1000));
                }
            }
        }

        public Resp GetSmall(string key)
        {
            Resp r = Request("GET", key, null, delegate { return new MemoryStream(); });
            if (r.Sink != null) r.Body = ((MemoryStream)r.Sink).ToArray();
            return r;
        }

        /// Keys directly under a prefix (ListObjectsV2 with delimiter "/"), every page.
        public List<string> ListKeys(string prefix)
        {
            List<string> keys = new List<string>();
            string token = null;
            while (true)
            {
                SortedDictionary<string, string> q = new SortedDictionary<string, string>(StringComparer.Ordinal);
                q["list-type"] = "2";
                q["prefix"] = prefix;
                q["delimiter"] = "/";
                if (token != null) q["continuation-token"] = token;
                Resp r = Request("GET", "", q, delegate { return new MemoryStream(); });
                if (r.Status != 200) throw new StopException("listing '" + prefix + "' failed: HTTP " + r.Status + " " + r.Code);
                byte[] body = ((MemoryStream)r.Sink).ToArray();
                XmlDocument d = new XmlDocument();
                d.LoadXml(Encoding.UTF8.GetString(body));
                foreach (XmlNode n in d.GetElementsByTagName("Contents"))
                {
                    foreach (XmlNode c in n.ChildNodes) if (c.Name == "Key") keys.Add(c.InnerText);
                }
                bool truncated = false;
                XmlNodeList t = d.GetElementsByTagName("IsTruncated");
                if (t.Count > 0) truncated = t[0].InnerText == "true";
                if (!truncated) break;
                XmlNodeList nt = d.GetElementsByTagName("NextContinuationToken");
                if (nt.Count == 0) break;
                token = nt[0].InnerText;
            }
            return keys;
        }
    }

    // ----------------------------------------------------------------------------------
    // Win32: attributes without following links, file identity, folders
    // ----------------------------------------------------------------------------------

    static class Native
    {
        public const uint INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF;
        public const uint FILE_ATTRIBUTE_DIRECTORY = 0x10;
        public const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
        public const int ERROR_FILE_NOT_FOUND = 2, ERROR_PATH_NOT_FOUND = 3;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
        public static extern uint GetFileAttributesW(string path);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
        public static extern bool CreateDirectoryW(string path, IntPtr sec);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
        public static extern bool RemoveDirectoryW(string path);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
        public static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetFileInformationByHandle(SafeFileHandle h, out BY_HANDLE_FILE_INFORMATION info);

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

        public struct FileId : IEquatable<FileId>
        {
            public uint Serial, High, Low;
            public bool Equals(FileId o) { return Serial == o.Serial && High == o.High && Low == o.Low; }
            public override bool Equals(object o) { return o is FileId && Equals((FileId)o); }
            public override int GetHashCode() { return (int)(Serial * 31 + High * 17 + Low); }
        }

        public class Stat
        {
            public bool Exists; public int Error; public uint Attrs; public FileId Id;
            public bool IsDir { get { return (Attrs & FILE_ATTRIBUTE_DIRECTORY) != 0; } }
            public bool IsReparse { get { return (Attrs & FILE_ATTRIBUTE_REPARSE_POINT) != 0; } }
        }

        /// Opens the name itself (not a link's target) with no access, and reads its identity.
        public static Stat StatNoFollow(string path)
        {
            const uint FILE_SHARE_ALL = 7, OPEN_EXISTING = 3, FILE_FLAG_BACKUP_SEMANTICS = 0x02000000, FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
            using (SafeFileHandle h = CreateFileW(path, 0, FILE_SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero))
            {
                if (h.IsInvalid)
                {
                    int e = Marshal.GetLastWin32Error();
                    return new Stat { Exists = !(e == ERROR_FILE_NOT_FOUND || e == ERROR_PATH_NOT_FOUND), Error = e };
                }
                BY_HANDLE_FILE_INFORMATION info;
                if (!GetFileInformationByHandle(h, out info)) return new Stat { Exists = true, Error = Marshal.GetLastWin32Error() };
                return new Stat { Exists = true, Attrs = info.FileAttributes, Id = new FileId { Serial = info.VolumeSerialNumber, High = info.FileIndexHigh, Low = info.FileIndexLow } };
            }
        }

        public static string Win32Message(int e)
        {
            return new System.ComponentModel.Win32Exception(e).Message + " (" + e + ")";
        }
    }

    // ----------------------------------------------------------------------------------
    // The restore itself
    // ----------------------------------------------------------------------------------

    class Restorer
    {
        readonly S3 s3; readonly Snapshot sn;
        readonly string outAbs;              // the output directory, absolute, no \\?\
        readonly string outP;                // with \\?\ (or \\?\UNC\), no trailing separator unless a root
        readonly List<string> outChain = new List<string>();   // \\?\ paths of <output> and its parents, shallowest first

        readonly HashSet<Native.FileId> written = new HashSet<Native.FileId>();
        readonly Dictionary<string, string> badHashes = new Dictionary<string, string>(StringComparer.Ordinal);   // hash -> verdict text
        Dictionary<string, string> records;  // hash -> newest deletion instant; loaded on the first miss

        public int Restored, Skipped, Deleted, Collisions, InTheWay, Missing, Withheld, Refused, NotCreatable, TimeRounded, TimeNotKept;
        public bool Failed;

        const long TicksAt1970 = 621355968000000000L;
        const long MsAt1601 = -11644473600000L;

        public Restorer(S3 s3, Snapshot sn, string dir)
        {
            this.s3 = s3; this.sn = sn;
            string a = Path.GetFullPath(dir);
            // strip trailing separators, but keep a root's
            while (a.Length > 0 && (a[a.Length - 1] == '\\' || a[a.Length - 1] == '/') && !(a.Length == 3 && a[1] == ':')) a = a.Substring(0, a.Length - 1);
            outAbs = a;
            string root; string rest;
            if (a.StartsWith("\\\\?\\", StringComparison.Ordinal)) throw new StopException("give the output directory without the \\\\?\\ prefix");
            if (a.StartsWith("\\\\", StringComparison.Ordinal))
            {
                // \\server\share\rest
                int i = a.IndexOf('\\', 2); if (i < 0) throw new StopException("output directory: a share needs a share name");
                int j = a.IndexOf('\\', i + 1);
                root = "\\\\?\\UNC\\" + (j < 0 ? a.Substring(2) : a.Substring(2, j - 2));
                rest = j < 0 ? "" : a.Substring(j + 1);
            }
            else if (a.Length >= 2 && a[1] == ':')
            {
                root = "\\\\?\\" + a.Substring(0, 2);
                rest = a.Length > 3 ? a.Substring(3) : "";
            }
            else throw new StopException("output directory isn't a drive or share path: " + a);
            string cur = root;
            if (rest.Length > 0)
            {
                foreach (string seg in rest.Split('\\')) { cur = cur + "\\" + seg; outChain.Add(cur); }
                outP = cur;
            }
            else outP = root + "\\";
        }

        string Dest(string rel) { return outP.EndsWith("\\", StringComparison.Ordinal) ? outP + rel : outP + "\\" + rel; }

        static string Unprefix(string p)
        {
            if (p.StartsWith("\\\\?\\UNC\\", StringComparison.Ordinal)) return "\\\\" + p.Substring(8);
            if (p.StartsWith("\\\\?\\", StringComparison.Ordinal)) return p.Substring(4);
            return p;
        }

        void Report(string verdict, FileRow r, string detail)
        {
            Console.WriteLine(verdict.PadRight(12) + " " + Text.Show(r.Path) + (detail != null ? "  [" + Text.Show(detail) + "]" : ""));
        }

        public void Run()
        {
            Console.WriteLine("dirs: " + sn.DirRows.Count + " (" + sn.Dirs.Count + " usable), start: " + (sn.Start ?? "(none)") + ", file rows: " + sn.Files.Count);
            foreach (FileRow r in sn.Files) Handle(r);
            Console.WriteLine();
            Console.WriteLine("restored " + Restored + ", skipped (already there) " + Skipped + ", deleted (deliberately) " + Deleted
                + ", collisions " + Collisions + ", in the way " + InTheWay + ", missing (damage) " + Missing + ", withheld (bad hash) " + Withheld
                + ", refused rows " + Refused + ", names not creatable " + NotCreatable + ", times rounded " + TimeRounded + ", times not kept " + TimeNotKept
                + "; requests " + s3.Requests);
        }

        /// For --verify: the destination of a row, or null with a reason when it can't land.
        public string DestinationOf(FileRow r, out string why)
        {
            why = null;
            if (r.Refusal != null) { why = "refused: " + r.Refusal; return null; }
            foreach (string seg in r.P.Segs)
            {
                if (seg.IndexOf('\\') >= 0) { why = "refused: name holds '\\'"; return null; }
                if (seg.IndexOf(':') >= 0) { why = "refused: name holds ':'"; return null; }
                foreach (char c in seg)
                    if (c < 0x20 || c == '"' || c == '*' || c == '<' || c == '>' || c == '?' || c == '|') { why = "not creatable on NTFS"; return null; }
            }
            return Dest(string.Join("\\", DestParts(r.P)));
        }

        /// Where a row's content lands relative to <output>: root folder then the segments.
        public static List<string> DestParts(PPath p)
        {
            List<string> parts = new List<string>();
            if (p.Kind == PathKind.Drive) parts.Add(char.ToUpperInvariant(p.Drive).ToString());
            else if (p.Kind == PathKind.Share) parts.Add("UNC");
            parts.AddRange(p.Segs);
            return parts;
        }

        void Handle(FileRow r)
        {
            if (r.Refusal != null) { Refused++; Failed = true; Report("refused", r, r.Refusal); return; }

            List<string> parts = DestParts(r.P);
            foreach (string seg in r.P.Segs)
            {
                if (seg.IndexOf('\\') >= 0) { Refused++; Failed = true; Report("refused", r, "a name holding '\\' would be split into folders on Windows"); return; }
                if (seg.IndexOf(':') >= 0) { Refused++; Failed = true; Report("refused", r, "a name holding ':' would be written to a hidden stream on Windows"); return; }
                foreach (char c in seg)
                {
                    if (c < 0x20 || c == '"' || c == '*' || c == '<' || c == '>' || c == '?' || c == '|')
                    {
                        NotCreatable++; Failed = true; Report("not creatable", r, "a name holding '" + Text.Show(c.ToString()) + "' can't be created on NTFS"); return;
                    }
                }
            }

            string dest = Dest(string.Join("\\", parts));
            string destShown = Unprefix(dest);

            // the destination first: there before, or written by this restore?
            Native.Stat st = Native.StatNoFollow(dest);
            if (st.Exists)
            {
                if (st.Error != 0) { InTheWay++; Failed = true; Report("in the way", r, "can't examine " + destShown + ": " + Native.Win32Message(st.Error)); return; }
                if (st.IsDir) { InTheWay++; Failed = true; Report("in the way", r, "a folder is where the file should land: " + destShown); return; }
                if (!st.IsReparse && written.Contains(st.Id))
                {
                    string bad;
                    if (badHashes.TryGetValue(r.Hash, out bad)) { ReportBad(r, bad); return; }
                    Collisions++; Failed = true; Report("collision", r, "this restore already wrote " + destShown); return;
                }
                Skipped++; Report("skipped", r, "already there: " + destShown); return;
            }

            string bad2;
            if (badHashes.TryGetValue(r.Hash, out bad2)) { ReportBad(r, bad2); return; }

            // folders: <output> and its parents, then the file's own
            List<string> made = new List<string>();
            List<string> chain = new List<string>(outChain);
            string cur = outP.EndsWith("\\", StringComparison.Ordinal) ? outP.Substring(0, outP.Length - 1) : outP;
            for (int i = 0; i < parts.Count - 1; i++) { cur = cur + "\\" + parts[i]; chain.Add(cur); }
            for (int i = 0; i < chain.Count; i++)
            {
                string folder = chain[i];
                bool insideOutput = i >= outChain.Count;
                uint attrs = Native.GetFileAttributesW(folder);
                if (attrs == Native.INVALID_FILE_ATTRIBUTES)
                {
                    int e = Marshal.GetLastWin32Error();
                    if (e == Native.ERROR_FILE_NOT_FOUND || e == Native.ERROR_PATH_NOT_FOUND)
                    {
                        if (!Native.CreateDirectoryW(folder, IntPtr.Zero))
                        {
                            int e2 = Marshal.GetLastWin32Error();
                            InTheWay++; Failed = true; Report("in the way", r, "can't create folder " + Unprefix(folder) + ": " + Native.Win32Message(e2)); Cleanup(made); return;
                        }
                        made.Add(folder);
                        continue;
                    }
                    InTheWay++; Failed = true; Report("in the way", r, "can't examine folder " + Unprefix(folder) + ": " + Native.Win32Message(e)); Cleanup(made); return;
                }
                if ((attrs & Native.FILE_ATTRIBUTE_DIRECTORY) == 0)
                {
                    InTheWay++; Failed = true; Report("in the way", r, "a file is where a folder should be: " + Unprefix(folder)); Cleanup(made); return;
                }
                if (insideOutput && (attrs & Native.FILE_ATTRIBUTE_REPARSE_POINT) != 0)
                {
                    InTheWay++; Failed = true; Report("in the way", r, "a link or junction is where a folder should be: " + Unprefix(folder)); Cleanup(made); return;
                }
            }

            // fetch beside the destination
            string parent = chain.Count > 0 ? chain[chain.Count - 1] : cur;
            string tmp = parent + "\\.s3cab-restore-" + Guid.NewGuid().ToString("N") + ".tmp";
            FileStream fs = null; HashSink hs = null;
            try
            {
                try { if (Native.GetFileAttributesW(tmp) != Native.INVALID_FILE_ATTRIBUTES) File.Delete(tmp); } catch (Exception) { }
                fs = new FileStream(tmp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536);
                FileStream fsLocal = fs;
                Resp resp = s3.Request("GET", "objects/" + r.Hash, null, delegate
                {
                    fsLocal.SetLength(0); fsLocal.Position = 0;
                    hs = new HashSink(fsLocal);
                    return hs;
                });
                if (resp.Status != 200)
                {
                    fs.Close(); fs = null; TryDelete(tmp); Cleanup(made);
                    if (resp.Status == 404 && (resp.Code == "NoSuchKey" || resp.Code == "NotFound"))
                    {
                        string verdict = JudgeMiss(r.Hash);
                        badHashes[r.Hash] = verdict;
                        ReportBad(r, verdict);
                        return;
                    }
                    if (resp.Status == 404 && resp.Code == "NoSuchBucket") throw new StopException("no such bucket");
                    if (resp.Status == 403) throw new StopException("403 " + resp.Code + " fetching objects/" + r.Hash + ": permissions, or a missing key the caller may not list");
                    throw new StopException("unexpected HTTP " + resp.Status + " " + resp.Code + " fetching objects/" + r.Hash);
                }
                fs.Close(); fs = null;
                string got = hs.HexHash;
                if (!string.Equals(got, r.Hash, StringComparison.Ordinal))
                {
                    TryDelete(tmp); Cleanup(made);
                    string verdict = "withheld: the download hashes to " + got + ", not its key";
                    badHashes[r.Hash] = verdict;
                    ReportBad(r, verdict);
                    return;
                }
                try { File.Move(tmp, dest); }
                catch (Exception e)
                {
                    TryDelete(tmp); Cleanup(made);
                    InTheWay++; Failed = true; Report("in the way", r, "can't move the download to " + destShown + ": " + e.Message); return;
                }
            }
            catch (IOException e)
            {
                if (fs != null) { fs.Close(); fs = null; }
                TryDelete(tmp); Cleanup(made);
                NotCreatable++; Failed = true; Report("not creatable", r, "writing " + destShown + ": " + e.Message); return;
            }
            catch (UnauthorizedAccessException e)
            {
                if (fs != null) { fs.Close(); fs = null; }
                TryDelete(tmp); Cleanup(made);
                NotCreatable++; Failed = true; Report("not creatable", r, "writing " + destShown + ": " + e.Message); return;
            }
            finally { if (fs != null) fs.Close(); }

            // the time
            string timeNote = SetTime(dest, r.MtimeMs);
            Native.Stat st2 = Native.StatNoFollow(dest);
            if (st2.Exists && st2.Error == 0) written.Add(st2.Id);
            Restored++;
            Report("restored", r, timeNote);
        }

        void ReportBad(FileRow r, string verdict)
        {
            if (verdict.StartsWith("deleted", StringComparison.Ordinal)) { Deleted++; Report("deleted", r, verdict); }
            else if (verdict.StartsWith("withheld", StringComparison.Ordinal)) { Withheld++; Failed = true; Report("withheld", r, verdict); }
            else { Missing++; Failed = true; Report("missing", r, verdict); }
        }

        /// A 404 NoSuchKey: deliberately deleted, or damage?
        string JudgeMiss(string hash)
        {
            if (records == null) LoadRecords();
            string when;
            if (records.TryGetValue(hash, out when))
            {
                if (sn.Start == null) return "missing: a record lists it (" + when + ") but the snapshot has no usable START to compare with, so this is damage";
                if (string.CompareOrdinal(when, sn.Start) > 0) return "deleted " + when + " (deliberately, by a deletion record)";
                return "missing: a record lists it at " + when + ", which isn't after the snapshot's START " + sn.Start + ", so this is damage";
            }
            return "missing: objects/" + hash + " isn't in the bucket and no deletion record explains it";
        }

        void LoadRecords()
        {
            records = new Dictionary<string, string>(StringComparer.Ordinal);
            List<string> keys = s3.ListKeys("objects.deleted-");
            Regex re = new Regex("^objects\\.deleted-[1-9][0-9]*\\.tsv\\z");
            int files = 0;
            foreach (string k in keys)
            {
                if (!re.IsMatch(k)) continue;
                Resp r = s3.GetSmall(k);
                if (r.Status == 404) { Console.Error.WriteLine("record " + k + " was listed but is gone; it explains nothing"); continue; }
                if (r.Status != 200) throw new StopException("reading " + k + " failed: HTTP " + r.Status + " " + r.Code);
                Records.Read(r.Body, records);
                files++;
            }
            Console.WriteLine("deletion records: " + files + " read, " + records.Count + " hashes");
        }

        string SetTime(string dest, long ms)
        {
            if (ms < MsAt1601) { TimeNotKept++; Failed = true; return "time not kept: " + Text.FormatInstant(ms) + " is before 1601, which NTFS can't hold; the file has the restore's time"; }
            if (ms == MsAt1601) { TimeNotKept++; Failed = true; return "time not kept: 1601-01-01T00:00:00.000Z is FILETIME 0, which Windows takes as 'leave alone'; the file has the restore's time"; }
            DateTime dt = new DateTime(ms * 10000 + TicksAt1970, DateTimeKind.Utc);
            try
            {
                File.SetLastWriteTimeUtc(dest, dt);
                File.SetLastAccessTimeUtc(dest, dt);
            }
            catch (Exception e) { TimeNotKept++; Failed = true; return "time not kept: " + e.Message; }
            DateTime back = File.GetLastWriteTimeUtc(dest);
            long backMs = Text.FloorDiv(back.Ticks - TicksAt1970 + 5000, 10000);
            long diff = backMs - ms;
            if (diff == 0) return null;
            if (Math.Abs(diff) < 2000) { TimeRounded++; return "time rounded by the disk to " + Text.FormatInstant(backMs); }
            TimeNotKept++; Failed = true;
            return "time not kept: the file has " + Text.FormatInstant(backMs) + ", not " + Text.FormatInstant(ms);
        }

        static void TryDelete(string p) { try { File.Delete(p); } catch (Exception) { } }

        static void Cleanup(List<string> made)
        {
            for (int i = made.Count - 1; i >= 0; i--) Native.RemoveDirectoryW(made[i]);
        }
    }

    // ----------------------------------------------------------------------------------
    // Self-test: synthetic files in memory, checked against the spec's stated rules
    // ----------------------------------------------------------------------------------

    static class SelfTest
    {
        static int pass, fail;
        const string OKH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        const string T = "2026-10-30T17:34:34.874Z";
        const string H = "@S3CAB\tFORMAT                                                          \t        size\ttime                    \thttps://s3cab.plantegral.com/guide/format\n";

        static void Check(string name, bool ok, string detail)
        {
            if (ok) pass++; else fail++;
            Console.WriteLine((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  [" + Text.Show(detail ?? "") + "]"));
        }

        static byte[] Deflate(byte[] text)
        {
            MemoryStream ms = new MemoryStream();
            using (DeflateStream ds = new DeflateStream(ms, CompressionMode.Compress, true)) ds.Write(text, 0, text.Length);
            return ms.ToArray();
        }

        static byte[] Member(byte[] text, int flags, byte[] extra, string name, string comment, bool badHcrc, bool badCrc, bool badLen, byte method)
        {
            MemoryStream h = new MemoryStream();
            h.Write(new byte[] { 0x1F, 0x8B, method, (byte)flags, 0, 0, 0, 0, 0, 255 }, 0, 10);
            if ((flags & 4) != 0) { h.WriteByte((byte)extra.Length); h.WriteByte((byte)(extra.Length >> 8)); h.Write(extra, 0, extra.Length); }
            if ((flags & 8) != 0) { byte[] b = Encoding.UTF8.GetBytes(name); h.Write(b, 0, b.Length); h.WriteByte(0); }
            if ((flags & 16) != 0) { byte[] b = Encoding.UTF8.GetBytes(comment); h.Write(b, 0, b.Length); h.WriteByte(0); }
            if ((flags & 2) != 0)
            {
                byte[] so = h.ToArray();
                uint c = Crc32.Update(0, so, 0, so.Length) & 0xFFFF;
                if (badHcrc) c ^= 1;
                h.WriteByte((byte)c); h.WriteByte((byte)(c >> 8));
            }
            byte[] body = Deflate(text);
            h.Write(body, 0, body.Length);
            uint crc = Crc32.Update(0, text, 0, text.Length);
            if (badCrc) crc ^= 1;
            uint len = (uint)text.Length;
            if (badLen) len += 1;
            h.Write(new byte[] { (byte)crc, (byte)(crc >> 8), (byte)(crc >> 16), (byte)(crc >> 24), (byte)len, (byte)(len >> 8), (byte)(len >> 16), (byte)(len >> 24) }, 0, 8);
            return h.ToArray();
        }

        static byte[] Gz(string text) { return Member(Text.Utf8NoBom.GetBytes(text), 0, null, null, null, false, false, false, 8); }
        static byte[] Cat(params byte[][] parts) { MemoryStream ms = new MemoryStream(); foreach (byte[] p in parts) ms.Write(p, 0, p.Length); return ms.ToArray(); }
        static byte[] Cut(byte[] b, int drop) { byte[] r = new byte[b.Length - drop]; Array.Copy(b, r, r.Length); return r; }

        static string GunzipRefusal(byte[] gz, out string text)
        {
            text = null;
            try { int m; text = Text.Utf8NoBom.GetString(Gzip.Decompress(gz, out m)); return null; }
            catch (RefusedFileException e) { return e.Message; }
        }

        static Snapshot ParseText(string text, out string refusal)
        {
            refusal = null;
            try { return Snapshot.Parse(Text.Utf8NoBom.GetBytes(text)); }
            catch (RefusedFileException e) { refusal = e.Message; return null; }
        }

        static Snapshot ParseBytes(byte[] b, out string refusal)
        {
            refusal = null;
            try { return Snapshot.Parse(b); }
            catch (RefusedFileException e) { refusal = e.Message; return null; }
        }

        static string Dir(string d) { return "@SET\tDIR\t\t\t" + d + "\n"; }
        static string Row(string hash, string size, string time, string path) { return "-\t" + hash + "\t" + size + "\t" + time + "\t" + path + "\n"; }
        static string Row(string path) { return Row(OKH, "0", T, path); }
        static string Snap(string body) { return H + "@S3CAB\tSPEC\t\t\t2026-10-30\n" + body + ".\n"; }
        static string V(Snapshot sn, int i) { return sn == null ? "(refused)" : (sn.Files[i].Refusal ?? "ok"); }
        static string Parts(Snapshot sn, int i) { return sn == null || sn.Files[i].P == null ? "(none)" : string.Join("|", Restorer.DestParts(sn.Files[i].P)); }

        public static int Run()
        {
            string r, t; Snapshot sn;
            string good = Snap(Dir("C:\\P\\") + Row("C:\\P\\a.txt"));

            // ---- gzip framing
            r = GunzipRefusal(Gz(good), out t); Check("gzip: plain member", r == null && t == good, r);
            r = GunzipRefusal(Member(Text.Utf8NoBom.GetBytes(good), 2 | 4 | 8 | 16, new byte[] { 1, 2, 3 }, "name.tsv", "a comment", false, false, false, 8), out t);
            Check("gzip: FEXTRA+FNAME+FCOMMENT+FHCRC header", r == null && t == good, r);
            r = GunzipRefusal(Member(Text.Utf8NoBom.GetBytes(good), 2, null, null, null, true, false, false, 8), out t); Check("gzip: bad header CRC refused", r != null && r.Contains("header CRC"), r);
            r = GunzipRefusal(Member(Text.Utf8NoBom.GetBytes(good), 0x80, null, null, null, false, false, false, 8), out t); Check("gzip: reserved flag refused", r != null && r.Contains("reserved"), r);
            r = GunzipRefusal(Member(Text.Utf8NoBom.GetBytes(good), 0, null, null, null, false, false, false, 9), out t); Check("gzip: method 9 refused", r != null && r.Contains("deflate"), r);
            r = GunzipRefusal(Member(Text.Utf8NoBom.GetBytes(good), 0, null, null, null, false, true, false, 8), out t); Check("gzip: bad CRC-32 refused", r != null && r.Contains("CRC-32"), r);
            r = GunzipRefusal(Member(Text.Utf8NoBom.GetBytes(good), 0, null, null, null, false, false, true, 8), out t); Check("gzip: bad ISIZE refused", r != null && r.Contains("length"), r);
            string half1 = good.Substring(0, 40), half2 = good.Substring(40);
            r = GunzipRefusal(Cat(Gz(half1), Gz(half2)), out t); Check("gzip: two members are one text", r == null && t == good, r);
            r = GunzipRefusal(Cat(Gz(good), new byte[] { 0, 1, 2, 3 }), out t); Check("gzip: zero byte after a member ends the file", r == null && t == good, r);
            r = GunzipRefusal(Cat(Gz(good), new byte[] { 7, 7 }), out t); Check("gzip: other byte after a member is damage", r != null && r.Contains("after a stream"), r);
            r = GunzipRefusal(Cat(Gz(good), new byte[] { 0x1F, 0x8B }), out t); Check("gzip: second header cut short is damage", r != null && r.Contains("cut short"), r);
            r = GunzipRefusal(Cut(Gz(good), 8), out t); Check("gzip: missing trailer is damage", r != null && r.Contains("trailer"), r);
            r = GunzipRefusal(Cut(Gz(good), 30), out t); Check("gzip: cut in the deflate data is damage", r != null, r);
            r = GunzipRefusal(Cat(new byte[] { 0 }, Gz(good)), out t); Check("gzip: zero byte before the first member is damage", r != null, r);
            r = GunzipRefusal(new byte[0], out t); Check("gzip: empty file is damage", r != null, r);
            sn = ParseBytes(Gzip.Decompress(Cat(Gz(good), Gz(good)), out fail_dummy), out r); Check("gzip: two whole snapshots joined are refused (rows after the '.')", sn == null && r != null, r);

            // ---- whole-file text rules
            sn = ParseText(good, out r); Check("text: valid snapshot parses", sn != null && V(sn, 0) == "ok", r);
            sn = ParseText(good.Replace("\n", "\r\n"), out r); Check("text: CRLF file refused whole", sn == null, r);
            sn = ParseText("\uFEFF" + good, out r); Check("text: BOM forgiven", sn != null && V(sn, 0) == "ok", r);
            sn = ParseText(good.Substring(0, good.Length - 1), out r); Check("text: '.' without LF refused", sn == null, r);
            sn = ParseText(good.Substring(0, good.Length - 2), out r); Check("text: no '.' refused", sn == null, r);
            sn = ParseText(good + "\n", out r); Check("text: blank line after '.' refused", sn == null, r);
            sn = ParseText(good + ".\n", out r); Check("text: second '.' refused", sn == null, r);
            sn = ParseText(Snap(Dir("C:\\P\\") + "\n" + Row("C:\\P\\a.txt")), out r); Check("text: blank line refused", sn == null, r);
            sn = ParseText(Snap(Dir("C:\\P\\") + " \t\u00A0\n" + Row("C:\\P\\a.txt")), out r); Check("text: line of only trim characters is blank, refused", sn == null, r);
            sn = ParseText(good.Replace(".\n", ". \n"), out r); Check("text: '. ' isn't the '.'", sn == null, r);
            sn = ParseText(Snap(Dir("C:\\P\\") + "x\tfoo\n" + Row("C:\\P\\a.txt")), out r); Check("text: unknown type 'x' refuses whole file", sn == null, r);
            sn = ParseText(Snap(Dir("C:\\P\\") + "@FOO\tBAR\t\t\tv\n@SET\tdir\t\t\tD:\\\n#whatever\tx\t\t\tC:\\P\\a.txt\n" + Row("C:\\P\\a.txt")), out r);
            Check("text: unknown @ type, unknown property, unknown # type are skipped", sn != null && V(sn, 0) == "ok" && sn.Dirs.Count == 1, r);
            sn = ParseText(good.Replace("format\n", "format \n"), out r); Check("text: heading with trailing space refused", sn == null, r);
            sn = ParseText(good.Replace("format\n", "format\t\n"), out r); Check("text: heading with a fifth tab refused", sn == null, r);
            sn = ParseText("@S3CAB\tFORMAT\tsize\ttime\thttps://s3cab.plantegral.com/guide/format\n" + good.Substring(H.Length), out r); Check("text: unpadded heading accepted", sn != null, r);
            sn = ParseText("@s3cab\tFORMAT\tsize\ttime\thttps://s3cab.plantegral.com/guide/format\n" + good.Substring(H.Length), out r); Check("text: heading compared case-sensitively", sn == null, r);
            sn = ParseBytes(Cat(Text.Utf8NoBom.GetBytes(Snap(Dir("C:\\P\\"))), new byte[] { 0 }), out r); Check("text: trailing NUL byte refused (after '.')", sn == null, r);
            sn = ParseBytes(Cat(Text.Utf8NoBom.GetBytes(H + "@SET\tDIR\t\t\tC:\\P\\\n-\t" + OKH + "\t0\t" + T + "\tC:\\P\\"), new byte[] { 0xFF, 0xFE }, Text.Utf8NoBom.GetBytes("a.txt\n.\n")), out r); Check("text: invalid UTF-8 refused", sn == null, r);
            sn = ParseText(Snap(Row("C:\\P\\a.txt")), out r); Check("text: no @SET DIR -> row refused, file not", sn != null && V(sn, 0).Contains("under no"), r);
            sn = ParseText(Snap("@SET\tDIR\t\t\t\n" + Row("C:\\P\\a.txt")), out r); Check("text: empty @SET DIR is no directory", sn != null && sn.Dirs.Count == 0 && V(sn, 0).Contains("under no"), r);
            sn = ParseText(Snap("@SET\tDIR\n" + Row("C:\\P\\a.txt")), out r); Check("text: @SET DIR with two fields is no directory", sn != null && sn.Dirs.Count == 0, r);
            sn = ParseText(Snap(Row("C:\\P\\a.txt") + Dir("C:\\P\\")), out r); Check("text: @SET DIR after the file row still counts", sn != null && V(sn, 0) == "ok", r);
            sn = ParseText(Snap("@SNAPSHOT\tSTART\t\t" + T + "\tUTC\n@SNAPSHOT\tSTART\t\tnot-a-time\tUTC\n"), out r); Check("text: last START counts, invalid -> none", sn != null && sn.Start == null, r);
            sn = ParseText(Snap("@SNAPSHOT\tSTART\t\tnot-a-time\tUTC\n@SNAPSHOT\tSTART\t\t  " + T + " \tUTC\n"), out r); Check("text: START trimmed, last valid counts", sn != null && sn.Start == T, r);
            sn = ParseText(Snap(" - \t" + OKH + "\t 0 \t " + T + " \tC:\\P\\a.txt\n" + Dir("C:\\P\\")), out r); Check("text: leading fields trimmed, path verbatim", sn != null && V(sn, 0) == "ok", r);
            sn = ParseText(Snap(Dir("C:\\P\\") + Row("C:\\P\\ a.txt ")), out r); Check("text: path keeps leading/trailing spaces", sn != null && V(sn, 0) == "ok" && Parts(sn, 0) == "C|P| a.txt ", Parts(sn, 0));
            sn = ParseText(Snap(Dir("C:\\P\\") + "-\t" + OKH + "\t0\t" + T + "\tC:\\P\\a\tb.txt\n"), out r); Check("text: fifth tab is a tab in the path, refused", sn != null && V(sn, 0).Contains("tab"), V(sn, 0));
            sn = ParseText(Snap(Dir("C:\\P\\") + Row("C:\\P\\a\rb.txt")), out r); Check("text: CR in path refused", sn != null && V(sn, 0).Contains("CR"), V(sn, 0));
            sn = ParseText(Snap(Dir("C:\\P\\") + Row("C:\\P\\a\0b.txt")), out r); Check("text: NUL in path refused", sn != null && V(sn, 0).Contains("NUL"), V(sn, 0));
            sn = ParseText(Snap(Dir("C:\\P\\") + Row("C:\\P\\a\u0085b.txt") + Row("C:\\P\\a\u2028b.txt") + Row("C:\\P\\a\u000Bb.txt")), out r);
            Check("text: NEL, LS, VT in a path are ordinary characters", sn != null && V(sn, 0) == "ok" && V(sn, 1) == "ok" && V(sn, 2) == "ok" && sn.Files.Count == 3, V(sn, 0) + V(sn, 1) + V(sn, 2));

            // ---- file row fields
            sn = ParseText(Snap(Dir("C:\\P\\") + Row(OKH.ToUpperInvariant(), "0", T, "C:\\P\\a.txt")), out r); Check("row: uppercase hash refused", sn != null && V(sn, 0).Contains("hash"), V(sn, 0));
            sn = ParseText(Snap(Dir("C:\\P\\") + Row(OKH.Substring(1), "0", T, "C:\\P\\a.txt")), out r); Check("row: 63-char hash refused", sn != null && V(sn, 0).Contains("hash"), V(sn, 0));
            sn = ParseText(Snap(Dir("C:\\P\\") + Row(OKH, "-1", T, "C:\\P\\a.txt")), out r); Check("row: size -1 refused", sn != null && V(sn, 0).Contains("size"), V(sn, 0));
            sn = ParseText(Snap(Dir("C:\\P\\") + Row(OKH, "007", T, "C:\\P\\a.txt")), out r); Check("row: size with leading zero ok", sn != null && V(sn, 0) == "ok", V(sn, 0));
            sn = ParseText(Snap(Dir("C:\\P\\") + Row(OKH, "", T, "C:\\P\\a.txt")), out r); Check("row: empty size refused", sn != null && V(sn, 0).Contains("size"), V(sn, 0));
            string[] badTimes = { "2026-02-30T00:00:00.000Z", "2026-01-01T24:00:00.000Z", "2026-01-01T00:60:00.000Z", "2026-01-01T00:00:60.000Z", "2026-01-01T00:00:00.000+00:00", "2026-01-01T00:00:00.00Z", "2026-01-01T00:00:00,000Z", "2026-13-01T00:00:00.000Z", "2026-01-01t00:00:00.000z", "2023-02-29T00:00:00.000Z", "2100-02-29T00:00:00.000Z" };
            foreach (string bt in badTimes) { sn = ParseText(Snap(Dir("C:\\P\\") + Row(OKH, "0", bt, "C:\\P\\a.txt")), out r); Check("row: time '" + bt + "' refused", sn != null && V(sn, 0).Contains("instant"), V(sn, 0)); }
            string[] goodTimes = { "0000-02-29T00:00:00.000Z", "1582-10-10T00:00:00.000Z", "2000-02-29T23:59:59.999Z", "9999-12-31T23:59:59.999Z", "1969-12-31T23:59:59.999Z", "2024-02-29T00:00:00.000Z" };
            foreach (string gt in goodTimes) { sn = ParseText(Snap(Dir("C:\\P\\") + Row(OKH, "0", gt, "C:\\P\\a.txt")), out r); Check("row: time '" + gt + "' ok", sn != null && V(sn, 0) == "ok", V(sn, 0)); }
            long ms; Text.IsInstant("1970-01-01T00:00:00.000Z", out ms); Check("time: epoch is 0 ms", ms == 0, ms.ToString());
            Text.IsInstant("1969-12-30T23:59:59.750Z", out ms); Check("time: 1969-12-30T23:59:59.750Z round-trips", Text.FormatInstant(ms) == "1969-12-30T23:59:59.750Z" && ms == -86400250L, Text.FormatInstant(ms));
            Text.IsInstant("0000-01-01T00:00:00.000Z", out ms); Check("time: year 0000 round-trips", Text.FormatInstant(ms) == "0000-01-01T00:00:00.000Z", Text.FormatInstant(ms));
            Text.IsInstant("1601-01-01T00:00:00.000Z", out ms); Check("time: 1601 epoch is -11644473600000 ms", ms == -11644473600000L, ms.ToString());

            // ---- path rules
            sn = ParseText(Snap(Dir("C:\\P\\") + Row("c:/P/a.txt")), out r); Check("path: lowercase drive and forward slashes -> C|P|a.txt", V(sn, 0) == "ok" && Parts(sn, 0) == "C|P|a.txt", Parts(sn, 0));
            sn = ParseText(Snap(Dir("C:\\P\\") + Row("C:\\p\\A.txt")), out r); Check("path: Windows DIR matched case-insensitively", V(sn, 0) == "ok" && Parts(sn, 0) == "C|p|A.txt", V(sn, 0));
            sn = ParseText(Snap(Dir("C:\\\u039F\u0394\u039F\u03A3\\") + Row("C:\\\u03BF\u03B4\u03BF\u03C2\\a.txt")), out r); Check("path: Final_Sigma: DIR 'ΟΔΟΣ' matches 'οδος'", V(sn, 0) == "ok", V(sn, 0));
            sn = ParseText(Snap(Dir("C:\\\u039F\u0394\u039F\u03A3\\") + Row("C:\\\u03BF\u03B4\u03BF\u03C3\\a.txt")), out r); Check("path: Final_Sigma: DIR 'ΟΔΟΣ' doesn't match 'οδοσ' (non-final sigma)", V(sn, 0) != "ok", V(sn, 0));
            sn = ParseText(Snap(Dir("C:\\\u0130\\") + Row("C:\\i\u0307\\a.txt")), out r); Check("path: U+0130 lowercases to i + U+0307", V(sn, 0) == "ok", V(sn, 0));
            sn = ParseText(Snap(Dir("/home/Me/") + Row("/home/me/a.txt")), out r); Check("path: POSIX DIR matched case-sensitively", V(sn, 0).Contains("under no"), V(sn, 0));
            sn = ParseText(Snap(Dir("/home/me/") + Row("/home/me/a.txt")), out r); Check("path: POSIX row -> home|me|a.txt", V(sn, 0) == "ok" && Parts(sn, 0) == "home|me|a.txt", Parts(sn, 0));
            sn = ParseText(Snap(Dir("/") + Row("/a.txt")), out r); Check("path: DIR '/' holds every POSIX path", V(sn, 0) == "ok", V(sn, 0));
            sn = ParseText(Snap(Dir("//") + Row("/a.txt")), out r); Check("path: DIR '//' matches nothing", V(sn, 0) != "ok", V(sn, 0));
            sn = ParseText(Snap(Dir("C:\\") + Row("C:\\a.txt")), out r); Check("path: DIR 'C:\\' holds every path on the drive", V(sn, 0) == "ok", V(sn, 0));
            sn = ParseText(Snap(Dir("C:\\") + Row("D:\\a.txt")), out r); Check("path: other drive not under DIR", V(sn, 0).Contains("under no"), V(sn, 0));
            sn = ParseText(Snap(Dir("C:\\P\\") + Row("C:\\P")), out r); Check("path: path equal to DIR refused", V(sn, 0).Contains("equals"), V(sn, 0));
            sn = ParseText(Snap(Dir("C:\\P\\") + Row("C:\\P\\a\\")), out r); Check("path: trailing separator refused", V(sn, 0).Contains("empty segment"), V(sn, 0));
            sn = ParseText(Snap(Dir("C:\\P\\") + Row("C:\\P\\\\a.txt")), out r); Check("path: doubled separator refused", V(sn, 0).Contains("empty segment"), V(sn, 0));
            sn = ParseText(Snap(Dir("C:\\P\\") + Row("C:\\P\\..\\a.txt")), out r); Check("path: '..' refused", V(sn, 0).Contains("'.'"), V(sn, 0));
            sn = ParseText(Snap(Dir("C:\\P\\") + Row("C:\\P\\.\\a.txt")), out r); Check("path: '.' refused", V(sn, 0).Contains("'.'"), V(sn, 0));
            sn = ParseText(Snap(Dir("C:\\P\\") + Row("P\\a.txt")), out r); Check("path: relative refused", V(sn, 0).Contains("absolute"), V(sn, 0));
            sn = ParseText(Snap(Dir("C:\\P\\") + Row("C:\\PX\\a.txt")), out r); Check("path: DIR matched by whole segments, not prefix", V(sn, 0).Contains("under no"), V(sn, 0));
            sn = ParseText(Snap(Dir("C:\\P\\\\") + Row("C:\\P\\a.txt")), out r); Check("path: DIR with doubled trailing separators still matches", V(sn, 0) == "ok", V(sn, 0));
            sn = ParseText(Snap(Dir("C:\\P\\\\Q\\") + Row("C:\\P\\Q\\a.txt")), out r); Check("path: DIR with doubled separator inside matches nothing", V(sn, 0) != "ok", V(sn, 0));
            sn = ParseText(Snap(Dir("\\\\nas\\photos\\") + Row("//NAS/photos/a.jpg")), out r); Check("path: share DIR matches other spelling -> UNC|NAS|photos|a.jpg", V(sn, 0) == "ok" && Parts(sn, 0) == "UNC|NAS|photos|a.jpg", V(sn, 0) + " " + Parts(sn, 0));
            sn = ParseText(Snap(Dir("\\\\nas\\") + Row("\\\\nas\\x\\a.txt")), out r); Check("path: share DIR without a share name matches nothing", V(sn, 0) != "ok", V(sn, 0));
            sn = ParseText(Snap(Dir("C:\\") + Row("\\\\?\\C:\\a.txt")), out r); Check("path: \\\\?\\C:\\ is a share, not under C:\\", V(sn, 0).Contains("under no"), V(sn, 0));
            sn = ParseText(Snap(Dir("\\\\?\\C:\\") + Row("\\\\?\\C:\\a.txt")), out r); Check("path: under a \\\\?\\C:\\ DIR it lands at UNC|?|C:|a.txt", V(sn, 0) == "ok" && Parts(sn, 0) == "UNC|?|C:|a.txt", Parts(sn, 0));
            sn = ParseText(Snap(Dir("C:\\a\\") + Dir("C:\\a\\b\\") + Row("C:\\a\\b") + Row("C:\\a\\b\\c.txt")), out r); Check("path: nested DIRs: equal to inner refused, under both ok", V(sn, 0).Contains("equals") && V(sn, 1) == "ok", V(sn, 0) + " / " + V(sn, 1));
            sn = ParseText(Snap(Dir("/") + Row("\\\\server\\share\\x")), out r); Check("path: POSIX '/' doesn't hold a share path", V(sn, 0) != "ok", V(sn, 0));
            sn = ParseText(Snap(Dir("/d/") + Row("/d/a\\b.txt")), out r); Check("path: backslash is ordinary in a POSIX name (parser)", V(sn, 0) == "ok" && Parts(sn, 0) == "d|a\\b.txt", Parts(sn, 0));
            sn = ParseText(Snap(Dir("C:\\P\\") + Row("C:\\P\\a.txt") + Row("C:\\P\\a.txt")), out r); Check("path: one path in two rows -> both refused", V(sn, 0).Contains("more than one") && V(sn, 1).Contains("more than one"), V(sn, 0));
            sn = ParseText(Snap(Dir("C:\\P\\") + Row("C:\\P\\a.txt") + Row("XX", "0", T, "C:\\P\\a.txt")), out r); Check("path: malformed twin refuses the well-formed sibling", V(sn, 0).Contains("more than one") && V(sn, 1) != "ok", V(sn, 0));
            sn = ParseText(Snap(Dir("C:\\P\\") + Row("C:\\P\\a.txt") + Row("C:\\p\\A.TXT")), out r); Check("path: two spellings aren't one path to the format", V(sn, 0) == "ok" && V(sn, 1) == "ok", V(sn, 0) + " / " + V(sn, 1));
            sn = ParseText(Snap(Dir("C:\\P\\") + Row("C:\\P\\a") + Row("C:\\P\\a\\b.txt")), out r); Check("path: run-through -> both refused", V(sn, 0).Contains("runs through") && V(sn, 1).Contains("runs through"), V(sn, 0) + " / " + V(sn, 1));
            sn = ParseText(Snap(Dir("C:\\P\\") + Row("C:\\P\\a") + Row("C:\\P\\a/b.txt")), out r); Check("path: run-through with the other separator -> both refused", V(sn, 0).Contains("runs through") && V(sn, 1).Contains("runs through"), V(sn, 0) + " / " + V(sn, 1));
            sn = ParseText(Snap(Dir("C:\\P\\") + Row("C:\\P\\a") + Row("C:/P/a/b.txt")), out r); Check("path: run-through needs an exact prefix (C:\\P\\a vs C:/P/a/b.txt both ok)", V(sn, 0) == "ok" && V(sn, 1) == "ok", V(sn, 0) + " / " + V(sn, 1));
            sn = ParseText(Snap(Dir("C:\\P\\") + Row("XX", "0", T, "C:\\P\\a") + Row("C:\\P\\a\\b.txt")), out r); Check("path: a row refused otherwise blocks nothing", V(sn, 1) == "ok", V(sn, 1));
            sn = ParseText(Snap(Dir("/d/") + Row("/d/a") + Row("/d/a\\b.txt")), out r); Check("path: POSIX run-through only on '/'", V(sn, 0) == "ok" && V(sn, 1) == "ok", V(sn, 0) + " / " + V(sn, 1));
            sn = ParseText(Snap(Dir("C:\\P\\") + Row("C:\\P\\ab") + Row("C:\\P\\abc\\x.txt")), out r); Check("path: 'ab' doesn't run through 'abc\\x.txt'", V(sn, 0) == "ok" && V(sn, 1) == "ok", V(sn, 0) + " / " + V(sn, 1));

            // ---- deletion records
            Dictionary<string, string> rec = new Dictionary<string, string>(StringComparer.Ordinal);
            string h1 = "1111111111111111111111111111111111111111111111111111111111111111", h2 = "2222222222222222222222222222222222222222222222222222222222222222";
            Records.Read(Text.Utf8NoBom.GetBytes(H + "#deleted\t" + h1 + "\t5\t2026-01-01T00:00:00.000Z\tme@x\n#deleted\t" + h2 + "\t5\t2026-01-02T00:00:00.000Z\n.\n"), rec);
            Check("record: two rows read, one without who", rec.Count == 2 && rec[h2] == "2026-01-02T00:00:00.000Z", rec.Count.ToString());
            rec.Clear(); Records.Read(Text.Utf8NoBom.GetBytes(H + ".\n#deleted\t" + h1 + "\t5\t2026-01-01T00:00:00.000Z\tme@x\n"), rec); Check("record: row after '.' explains nothing", rec.Count == 0, rec.Count.ToString());
            rec.Clear(); Records.Read(Text.Utf8NoBom.GetBytes(H + "#deleted\t" + h1 + "\t5\t2026-01-01T00:00:00.000Z\tme@x"), rec); Check("record: last row without LF explains nothing", rec.Count == 0, rec.Count.ToString());
            rec.Clear(); Records.Read(Text.Utf8NoBom.GetBytes(H.Replace("\n", "\r\n") + "#deleted\t" + h1 + "\t5\t2026-01-01T00:00:00.000Z\tme@x\r\n.\r\n"), rec); Check("record: CRLF record's rows still count (CR lands in the who field)", rec.Count == 1, rec.Count.ToString());
            rec.Clear(); Records.Read(Cat(Text.Utf8NoBom.GetBytes("#deleted\t" + h1 + "\t5\t2026-01-01T00:00:00.000Z\t"), new byte[] { 0xFF }, Text.Utf8NoBom.GetBytes("\n#deleted\t" + h2 + "\t5\t2026-01-02T00:00:00.000Z\tme\n.\n")), rec); Check("record: a line that isn't UTF-8 is one wrong line", rec.Count == 1 && rec.ContainsKey(h2), rec.Count.ToString());
            rec.Clear(); Records.Read(Text.Utf8NoBom.GetBytes("#deleted\t" + h1.Replace('1', 'A') + "\t5\t2026-01-01T00:00:00.000Z\tme\n#deleted\t" + h1 + "\tx\t2026-01-01T00:00:00.000Z\tme\n#deleted\t" + h1 + "\t5\t2026-02-30T00:00:00.000Z\tme\n.\n"), rec); Check("record: malformed rows (hash, size, instant) are set aside", rec.Count == 0, rec.Count.ToString());
            rec.Clear(); Records.Read(Text.Utf8NoBom.GetBytes("#deleted\t" + h1 + "\t5\t2026-01-05T00:00:00.000Z\tme\n.\n"), rec); Records.Read(Text.Utf8NoBom.GetBytes("#deleted\t" + h1 + "\t5\t2026-01-03T00:00:00.000Z\tme\n.\n"), rec); Check("record: newest instant wins across files", rec[h1] == "2026-01-05T00:00:00.000Z", rec[h1]);
            rec.Clear(); Records.Read(Text.Utf8NoBom.GetBytes("\uFEFF" + H + "#deleted\t" + h1 + "\t5\t2026-01-01T00:00:00.000Z\n.\n"), rec); Check("record: BOM'd heading read as a row and skipped", rec.Count == 1, rec.Count.ToString());
            rec.Clear(); Records.Read(Text.Utf8NoBom.GetBytes("-\t" + h1 + "\t5\t2026-01-01T00:00:00.000Z\tx\n#deleted\t" + h2 + "\t5\t2026-01-01T00:00:00.000Z\n.\n"), rec); Check("record: a '-' row explains nothing, the well-formed row still counts", rec.Count == 1 && rec.ContainsKey(h2), rec.Count.ToString());

            // ---- trim set
            Check("trim: U+0085 is not trimmed", Text.Trim("\u0085a\u0085") == "\u0085a\u0085", Text.Trim("\u0085a\u0085"));
            Check("trim: U+FEFF, U+3000, U+2028 are trimmed", Text.Trim("\uFEFF\u3000a\u2028\u200A") == "a", Text.Trim("\uFEFF\u3000a\u2028"));
            Check("trim: U+001C..U+001F are not trimmed", Text.Trim("\u001Ca\u001F") == "\u001Ca\u001F", "");

            Console.WriteLine("selftest: " + pass + " passed, " + fail + " failed, icu " + Casing.UsingIcu);
            return fail == 0 ? 0 : 1;
        }
        static int fail_dummy;
    }

    // ----------------------------------------------------------------------------------
    // Entry
    // ----------------------------------------------------------------------------------

    static class Program
    {
        static int Main(string[] args)
        {
            Console.OutputEncoding = Text.Utf8NoBom;
            int code;
            try { code = Run(args); }
            catch (StopException e) { Console.Error.WriteLine("stopped: " + e.Message); code = 2; }
            Console.WriteLine("exit " + code);
            return code;
        }

        static readonly Regex SetName = new Regex("^[a-z0-9]+(-[a-z0-9]+)*\\z");
        static readonly Regex SnapName = new Regex("^[0-9]{8}T[0-9]{4}\\z");

        static int Run(string[] args)
        {
            if (args.Length == 2 && args[0] == "--parse") return ParseMode(args[1]);
            if (args.Length == 2 && args[0] == "--dump")
            {
                byte[] b = File.ReadAllBytes(args[1]);
                int members;
                if (b.Length >= 2 && b[0] == 0x1F && b[1] == 0x8B) b = Gzip.Decompress(b, out members);
                Console.WriteLine(Text.Show(Text.Utf8NoBom.GetString(b)).Replace("<U+000A>", "<U+000A>\n"));
                return 0;
            }
            if (args.Length == 3 && args[0] == "--verify") return VerifyMode(args[1], args[2]);
            if (args.Length == 1 && args[0] == "--selftest") return SelfTest.Run();
            if (args.Length == 3 && args[0] == "--compare") return CompareMode(args[1], args[2]);
            if (args.Length == 2 && args[0] == "--timetest")
            {
                // Audits the spec's hint about File.SetLastWriteTimeUtc at and before 1601.
                string p = "\\\\?\\" + Path.GetFullPath(args[1]);
                File.WriteAllBytes(p, new byte[] { 1 });
                DateTime before = File.GetLastWriteTimeUtc(p);
                File.SetLastWriteTimeUtc(p, new DateTime(1601, 1, 1, 0, 0, 0, DateTimeKind.Utc));
                Console.WriteLine("set 1601-01-01T00:00:00Z, read back: " + File.GetLastWriteTimeUtc(p).ToString("o") + " (was " + before.ToString("o") + ")");
                File.SetLastWriteTimeUtc(p, new DateTime(1601, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(1));
                Console.WriteLine("set 1601-01-01T00:00:00.001Z, read back: " + File.GetLastWriteTimeUtc(p).ToString("o"));
                File.SetLastWriteTimeUtc(p, new DateTime(1969, 12, 30, 23, 59, 59, 750, DateTimeKind.Utc));
                Console.WriteLine("set 1969-12-30T23:59:59.750Z, read back: " + File.GetLastWriteTimeUtc(p).ToString("o"));
                try { File.SetLastWriteTimeUtc(p, new DateTime(1600, 12, 31, 0, 0, 0, DateTimeKind.Utc)); Console.WriteLine("set 1600-12-31: no exception, read back " + File.GetLastWriteTimeUtc(p).ToString("o")); }
                catch (Exception e) { Console.WriteLine("set 1600-12-31: " + e.GetType().Name + ": " + e.Message); }
                File.Delete(p);
                return 0;
            }
            if (args.Length == 2 && args[0] == "--lower")
            {
                try { Console.WriteLine("icu: " + Casing.UsingIcu + ", lower: " + Casing.Lower(args[1])); }
                catch (Exception e) { Console.WriteLine("error: " + e); }
                return 0;
            }
            if (args.Length < 3 || args.Length > 4)
            {
                Console.Error.WriteLine("usage: s3cab-restore.exe <bucket> <set> <dir> [<snapshot>]");
                Console.Error.WriteLine("       s3cab-restore.exe --parse <file.tsv.gz|file.tsv>");
                return 2;
            }
            string bucket = args[0], set = args[1], dir = args[2];
            string snap = args.Length == 4 ? args[3] : null;
            if (!SetName.IsMatch(set)) throw new StopException("'" + set + "' isn't a set name: a-z and digits with single hyphens between");
            string akid = Environment.GetEnvironmentVariable("AWS_ACCESS_KEY_ID");
            string secret = Environment.GetEnvironmentVariable("AWS_SECRET_ACCESS_KEY");
            string token = Environment.GetEnvironmentVariable("AWS_SESSION_TOKEN");
            string region = Environment.GetEnvironmentVariable("AWS_REGION");
            if (string.IsNullOrEmpty(region)) region = Environment.GetEnvironmentVariable("AWS_DEFAULT_REGION");
            if (string.IsNullOrEmpty(region)) region = "us-east-1";
            if (string.IsNullOrEmpty(akid) || string.IsNullOrEmpty(secret)) throw new StopException("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set");

            S3 s3 = new S3(bucket, region, akid, secret, token);

            if (snap == null)
            {
                string prefix = "snapshots/" + set + "/";
                List<string> keys = s3.ListKeys(prefix);
                Regex re = new Regex("^[0-9]{8}T[0-9]{4}\\.tsv\\.gz\\z");
                string best = null;
                foreach (string k in keys)
                {
                    string name = k.Substring(prefix.Length);
                    if (!re.IsMatch(name)) continue;
                    if (best == null || string.CompareOrdinal(name, best) > 0) best = name;
                }
                if (best == null) throw new StopException("set '" + set + "' has no snapshot under " + prefix);
                snap = best.Substring(0, best.Length - 7);
            }
            else
            {
                if (snap.EndsWith(".tsv.gz", StringComparison.Ordinal)) snap = snap.Substring(0, snap.Length - 7);
                if (!SnapName.IsMatch(snap)) throw new StopException("'" + snap + "' isn't a snapshot name (YYYYMMDDTHHMM)");
            }
            string key = "snapshots/" + set + "/" + snap + ".tsv.gz";
            Console.WriteLine("snapshot: " + key);
            Resp r = s3.GetSmall(key);
            if (r.Status == 404) throw new StopException("no such snapshot: " + key + " (" + r.Code + ")");
            if (r.Status != 200) throw new StopException("fetching " + key + " failed: HTTP " + r.Status + " " + r.Code);

            Snapshot sn;
            try
            {
                int members;
                byte[] text = Gzip.Decompress(r.Body, out members);
                if (members > 1) Console.WriteLine("note: " + members + " gzip streams, read as one text");
                sn = Snapshot.Parse(text);
            }
            catch (RefusedFileException e)
            {
                Console.Error.WriteLine("refused whole: " + key + ": " + e.Message);
                return 1;
            }
            Restorer rs = new Restorer(s3, sn, dir);
            rs.Run();
            return rs.Failed ? 1 : 0;
        }

        static int ParseMode(string file)
        {
            byte[] bytes = File.ReadAllBytes(file);
            Snapshot sn;
            try
            {
                if (bytes.Length >= 2 && bytes[0] == 0x1F && bytes[1] == 0x8B)
                {
                    int members;
                    bytes = Gzip.Decompress(bytes, out members);
                    Console.WriteLine("gzip streams: " + members + ", text bytes: " + bytes.Length);
                }
                sn = Snapshot.Parse(bytes);
            }
            catch (RefusedFileException e) { Console.WriteLine("refused whole: " + e.Message); return 1; }
            Console.WriteLine("lines: " + sn.Lines + ", start: " + (sn.Start ?? "(none)") + (sn.StartRaw != null && sn.Start == null ? " raw '" + Text.Show(sn.StartRaw) + "'" : "") + ", icu: " + Casing.UsingIcu);
            foreach (string d in sn.DirRows) Console.WriteLine("dir " + (PPath.ParseDir(d) != null ? "ok     " : "unusable ") + Text.Show(d));
            int bad = 0;
            foreach (FileRow r in sn.Files)
            {
                if (r.Refusal != null) { bad++; Console.WriteLine("refused  line " + r.Line + ": " + Text.Show(r.Path) + "  [" + r.Refusal + "]"); }
                else Console.WriteLine("ok       " + Text.Show(r.Path) + "  -> " + string.Join("\\", Restorer_DestParts(r.P)));
            }
            Console.WriteLine("file rows: " + sn.Files.Count + ", refused: " + bad);
            return 0;
        }

        static List<string> Restorer_DestParts(PPath p) { return Restorer.DestParts(p); }

        class Entry { public bool IsDir; public long Size; public long Mtime; public long Atime; public uint Attrs; public string Full; }

        static Dictionary<string, Entry> Collect(string root)
        {
            Dictionary<string, Entry> d = new Dictionary<string, Entry>(StringComparer.Ordinal);
            if (root == null) return d;
            foreach (string f in Directory.GetFileSystemEntries(root, "*", SearchOption.AllDirectories))
            {
                uint attrs = Native.GetFileAttributesW(f);
                Entry e = new Entry { Full = f, Attrs = attrs, IsDir = (attrs & Native.FILE_ATTRIBUTE_DIRECTORY) != 0 };
                e.Mtime = File.GetLastWriteTimeUtc(f).Ticks;
                e.Atime = File.GetLastAccessTimeUtc(f).Ticks;
                if (!e.IsDir) e.Size = new FileInfo(f).Length;
                d[f.Substring(root.Length + 1)] = e;
            }
            return d;
        }

        static string RootOf(string dir)
        {
            string p = "\\\\?\\" + Path.GetFullPath(dir).TrimEnd('\\');
            return Native.GetFileAttributesW(p) == Native.INVALID_FILE_ATTRIBUTES ? null : p;
        }

        static bool SameBytes(string a, string b)
        {
            using (FileStream fa = new FileStream(a, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (FileStream fb = new FileStream(b, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (fa.Length != fb.Length) return false;
                byte[] x = new byte[65536], y = new byte[65536];
                while (true)
                {
                    int n = fa.Read(x, 0, x.Length), m = fb.Read(y, 0, y.Length);
                    if (n != m) return false;
                    if (n == 0) return true;
                    for (int i = 0; i < n; i++) if (x[i] != y[i]) return false;
                }
            }
        }

        static string Ticks(long t) { return new DateTime(t, DateTimeKind.Utc).ToString("o"); }

        /// Compares two restored trees: every path, file bytes, file mtime to the tick, and reports
        /// atime and attribute differences as information.
        static int CompareMode(string mine, string reference)
        {
            string a = RootOf(mine), b = RootOf(reference);
            Dictionary<string, Entry> da = Collect(a), db = Collect(b);
            SortedSet<string> all = new SortedSet<string>(StringComparer.Ordinal);
            foreach (string k in da.Keys) all.Add(k);
            foreach (string k in db.Keys) all.Add(k);
            int files = 0, dirs = 0, diffs = 0, atimeDiffs = 0, attrDiffs = 0;
            foreach (string rel in all)
            {
                Entry ea, eb;
                bool ina = da.TryGetValue(rel, out ea), inb = db.TryGetValue(rel, out eb);
                if (!inb) { diffs++; Console.WriteLine("only-mine      " + Text.Show(rel) + (ea.IsDir ? "  (folder)" : "")); continue; }
                if (!ina) { diffs++; Console.WriteLine("only-reference " + Text.Show(rel) + (eb.IsDir ? "  (folder)" : "")); continue; }
                if (ea.IsDir != eb.IsDir) { diffs++; Console.WriteLine("kind differs   " + Text.Show(rel)); continue; }
                if (ea.IsDir) { dirs++; continue; }
                files++;
                if (!SameBytes(ea.Full, eb.Full)) { diffs++; Console.WriteLine("bytes differ   " + Text.Show(rel) + "  mine " + ea.Size + " B, reference " + eb.Size + " B"); }
                if (ea.Mtime != eb.Mtime) { diffs++; Console.WriteLine("mtime differs  " + Text.Show(rel) + "  mine " + Ticks(ea.Mtime) + ", reference " + Ticks(eb.Mtime)); }
                if (ea.Atime != eb.Atime) { atimeDiffs++; Console.WriteLine("atime differs  " + Text.Show(rel) + "  mine " + Ticks(ea.Atime) + ", reference " + Ticks(eb.Atime)); }
                uint mask = 0x1 | 0x2 | 0x4 | 0x400; // readonly, hidden, system, reparse
                if ((ea.Attrs & mask) != (eb.Attrs & mask)) { attrDiffs++; Console.WriteLine("attrs differ   " + Text.Show(rel) + "  mine 0x" + ea.Attrs.ToString("X") + ", reference 0x" + eb.Attrs.ToString("X")); }
            }
            Console.WriteLine("compare: mine " + (a == null ? "absent" : "present") + ", reference " + (b == null ? "absent" : "present")
                + "; files " + files + ", folders " + dirs + ", differences " + diffs + ", atime differences " + atimeDiffs + ", attribute differences " + attrDiffs);
            return diffs == 0 ? 0 : 1;
        }

        /// Checks a restored tree against a local copy of the snapshot: every row that should
        /// have landed is there with the right hash and millisecond mtime, and nothing else is.
        static int VerifyMode(string file, string dir)
        {
            byte[] bytes = File.ReadAllBytes(file);
            int members;
            if (bytes.Length >= 2 && bytes[0] == 0x1F && bytes[1] == 0x8B) bytes = Gzip.Decompress(bytes, out members);
            Snapshot sn = Snapshot.Parse(bytes);
            Restorer rs = new Restorer(null, sn, dir);
            HashSet<string> expected = new HashSet<string>(StringComparer.Ordinal);
            int ok = 0, bad = 0, absent = 0, cannot = 0;
            foreach (FileRow r in sn.Files)
            {
                string why; string dest = rs.DestinationOf(r, out why);
                if (dest == null) { cannot++; Console.WriteLine("no-dest   " + Text.Show(r.Path) + "  [" + why + "]"); continue; }
                expected.Add(dest);
                Native.Stat st = Native.StatNoFollow(dest);
                if (!st.Exists) { absent++; Console.WriteLine("absent    " + Text.Show(r.Path)); continue; }
                string got;
                using (FileStream fs = new FileStream(dest, FileMode.Open, FileAccess.Read, FileShare.Read)) got = Text.Hex(SHA256.Create().ComputeHash(fs));
                long backMs = Text.FloorDiv(File.GetLastWriteTimeUtc(dest).Ticks - 621355968000000000L + 5000, 10000);
                string problems = "";
                if (got != r.Hash) problems += " hash=" + got.Substring(0, 12) + " want " + r.Hash.Substring(0, 12);
                if (backMs != r.MtimeMs) problems += " mtime=" + Text.FormatInstant(backMs) + " want " + r.Mtime;
                if (problems.Length > 0) { bad++; Console.WriteLine("MISMATCH  " + Text.Show(r.Path) + " " + problems); }
                else ok++;
            }
            int extra = 0;
            string root = "\\\\?\\" + Path.GetFullPath(dir).TrimEnd('\\');
            if (Native.GetFileAttributesW(root) != Native.INVALID_FILE_ATTRIBUTES)
            {
                foreach (string f in Directory.GetFiles(root, "*", SearchOption.AllDirectories))
                {
                    if (!expected.Contains(f)) { extra++; Console.WriteLine("extra     " + Text.Show(f)); }
                }
            }
            else Console.WriteLine("(output directory doesn't exist)");
            Console.WriteLine("verify: ok " + ok + ", mismatched " + bad + ", absent " + absent + ", rows with no destination " + cannot + ", extra files " + extra);
            return (bad > 0 || extra > 0) ? 1 : 0;
        }
    }
}
