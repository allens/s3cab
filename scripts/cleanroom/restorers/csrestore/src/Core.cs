// Format reading and restore planning for s3cab snapshots and deletion records, from format.md
// (spec of 2026-10-20) alone. No network and no filesystem writes here, so it can be tested
// against files on disk.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Text;

// The whole file is refused: not UTF-8, no heading, no '.', rows after the '.', unknown type.
class RefusedFile : Exception
{
    public RefusedFile(string message) : base(message) { }
}

static class Fmt
{
    public const string HeadingUrl = "https://s3cab.plantegral.com/guide/format";
    static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);

    // ---- the four reading rules ----------------------------------------------------------

    // Leading fields are trimmed of tab, VT, FF, CR, LF, every Zs space, U+2028, U+2029 and a BOM,
    // but not U+0085. (.NET's String.Trim() would also take U+0085 and keep U+FEFF.)
    public static bool IsTrimChar(char c)
    {
        if (c == '\t' || c == '\v' || c == '\f' || c == '\r' || c == '\n') return true;
        if (c == (char)0x2028 || c == (char)0x2029 || c == (char)0xFEFF) return true;
        return CharUnicodeInfo.GetUnicodeCategory(c) == UnicodeCategory.SpaceSeparator;
    }

    public static string Trim(string s)
    {
        int a = 0, b = s.Length;
        while (a < b && IsTrimChar(s[a])) a++;
        while (b > a && IsTrimChar(s[b - 1])) b--;
        return s.Substring(a, b - a);
    }

    // A text line split into its leading fields (trimmed) and its last field (verbatim).
    // Fields.Length is the raw tab-separated count.
    public class Row
    {
        public int LineNo;
        public string Raw;
        public string[] Fields;   // raw, untrimmed
        public string Type;       // first field, trimmed

        // Column n (1-based) of the leading four, trimmed; "" if absent.
        public string Col(int n)
        {
            return Fields.Length >= n ? Trim(Fields[n - 1]) : "";
        }

        // The value column of an '@' row: the rest of the line after the 4th tab, or null when
        // the row has fewer than five fields. (format.md: s3cab "reads the columns it needs by
        // position, and the last as the rest of the line".)
        public string RestAfterFourth()
        {
            if (Fields.Length < 5) return null;
            int tabs = 0;
            for (int i = 0; i < Raw.Length; i++)
                if (Raw[i] == '\t' && ++tabs == 4) return Raw.Substring(i + 1);
            return null;
        }
    }

    // Decode, split on LF exactly, check the heading row and the '.' terminator, refuse unknown
    // non-@/# types. Returns the rows strictly between heading and '.'.
    public static List<Row> ReadRows(byte[] text)
    {
        int start = 0;
        if (text.Length >= 3 && text[0] == 0xEF && text[1] == 0xBB && text[2] == 0xBF) start = 3; // a forgiven BOM
        string s;
        try { s = StrictUtf8.GetString(text, start, text.Length - start); }
        catch (ArgumentException e) { throw new RefusedFile("not valid UTF-8 (" + e.Message.Split('\n')[0].Trim() + ")"); }
        if (s.Length == 0) throw new RefusedFile("empty file");
        if (s[s.Length - 1] != '\n')
            throw new RefusedFile("the last line has no LF, so the file was cut short");
        string[] lines = s.Substring(0, s.Length - 1).Split('\n');

        string[] head = lines[0].Split('\t');
        if (head.Length != 5 || Trim(head[0]) != "@S3CAB" || Trim(head[1]) != "FORMAT" ||
            Trim(head[2]) != "size" || Trim(head[3]) != "time" || head[4] != HeadingUrl)
            throw new RefusedFile("the first line is not the heading row");
        if (lines.Length < 2 || lines[lines.Length - 1] != ".")
            throw new RefusedFile("the last line is not '.', so the file is incomplete (cut short)");
        var rows = new List<Row>();
        for (int i = 1; i < lines.Length - 1; i++)
        {
            if (lines[i] == ".")
                throw new RefusedFile("rows after the '.' terminator (a '.' at line " + (i + 1) + ")");
            var r = new Row();
            r.LineNo = i + 1;
            r.Raw = lines[i];
            r.Fields = lines[i].Split('\t');
            r.Type = Trim(r.Fields[0]);
            bool known = r.Type == "-" || (r.Type.Length > 0 && (r.Type[0] == '@' || r.Type[0] == '#'));
            if (!known)
                throw new RefusedFile("line " + r.LineNo + " has a row type this reader doesn't know: '" +
                    Printable(r.Type) + "'");
            rows.Add(r);
        }
        return rows;
    }

    // ---- gzip ----------------------------------------------------------------------------

    // Feeds a byte array to a decompressor one byte per Read, so that when the decompressor
    // stops we know exactly how much it consumed, and whether it asked past the end.
    class TrickleStream : Stream
    {
        readonly byte[] data;
        int pos;
        public bool AskedPastEnd;
        public TrickleStream(byte[] data, int pos) { this.data = data; this.pos = pos; }
        public int Position_ { get { return pos; } }
        public override int Read(byte[] buffer, int offset, int count)
        {
            if (count == 0) return 0;
            if (pos >= data.Length) { AskedPastEnd = true; return 0; }
            buffer[offset] = data[pos++];
            return 1;
        }
        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return false; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { throw new NotSupportedException(); } }
        public override long Position { get { return pos; } set { throw new NotSupportedException(); } }
        public override void Flush() { }
        public override long Seek(long o, SeekOrigin s) { throw new NotSupportedException(); }
        public override void SetLength(long v) { throw new NotSupportedException(); }
        public override void Write(byte[] b, int o, int c) { throw new NotSupportedException(); }
    }

    // Decompresses gzip as s3cab's reader is described: several members are joined, a member cut
    // short is refused, and bytes after the last member that aren't gzip refuse the file.
    // .NET Framework's GZipStream alone stops after the first member, and says nothing when the
    // input ends early; both are checked here around it.
    public static byte[] Gunzip(byte[] data)
    {
        var output = new MemoryStream();
        int pos = 0, members = 0;
        var buf = new byte[65536];
        while (true)
        {
            if (data.Length - pos < 2 || data[pos] != 0x1f || data[pos + 1] != 0x8b)
            {
                if (members == 0) throw new RefusedFile("not gzip");
                throw new RefusedFile("bytes after the gzip stream that aren't gzip (" + (data.Length - pos) + " bytes)");
            }
            var trickle = new TrickleStream(data, pos);
            try
            {
                using (var gz = new GZipStream(trickle, CompressionMode.Decompress, true))
                {
                    int n;
                    while ((n = gz.Read(buf, 0, buf.Length)) > 0) output.Write(buf, 0, n);
                }
            }
            catch (InvalidDataException e) { throw new RefusedFile("gzip data is damaged: " + e.Message); }
            if (trickle.AskedPastEnd) throw new RefusedFile("the gzip stream is cut short");
            if (trickle.Position_ == pos) throw new RefusedFile("gzip member consumed nothing");
            pos = trickle.Position_;
            members++;
            if (pos == data.Length) break;
        }
        return output.ToArray();
    }

    // ---- field checks --------------------------------------------------------------------

    public static bool IsHash(string s)
    {
        if (s.Length != 64) return false;
        foreach (char c in s) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
        return true;
    }

    public static bool IsDecimal(string s)
    {
        if (s.Length == 0) return false;
        foreach (char c in s) if (c < '0' || c > '9') return false;
        return true;
    }

    // YYYY-MM-DDTHH:MM:SS.sssZ, exactly 24 characters, and a real instant .NET can hold.
    public static bool TryParseTime(string s, out DateTime utc)
    {
        utc = default(DateTime);
        if (s.Length != 24) return false;
        const string shape = "0000-00-00T00:00:00.000Z";
        for (int i = 0; i < 24; i++)
        {
            if (shape[i] == '0') { if (s[i] < '0' || s[i] > '9') return false; }
            else if (s[i] != shape[i]) return false;
        }
        int y = int.Parse(s.Substring(0, 4), CultureInfo.InvariantCulture);
        int mo = int.Parse(s.Substring(5, 2), CultureInfo.InvariantCulture);
        int d = int.Parse(s.Substring(8, 2), CultureInfo.InvariantCulture);
        int h = int.Parse(s.Substring(11, 2), CultureInfo.InvariantCulture);
        int mi = int.Parse(s.Substring(14, 2), CultureInfo.InvariantCulture);
        int se = int.Parse(s.Substring(17, 2), CultureInfo.InvariantCulture);
        int ms = int.Parse(s.Substring(20, 3), CultureInfo.InvariantCulture);
        if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > DateTime.DaysInMonth(y, mo) || h > 23 || mi > 59 || se > 59)
            return false;
        utc = new DateTime(y, mo, d, h, mi, se, ms, DateTimeKind.Utc);
        return true;
    }

    // For messages: control characters shown as \xNN / \uNNNN.
    public static string Printable(string s)
    {
        var sb = new StringBuilder();
        foreach (char c in s)
        {
            if (c < 0x20 || c == 0x7f) sb.Append("\\x").Append(((int)c).ToString("x2", CultureInfo.InvariantCulture));
            else if ((c >= 0x80 && c < 0xa0) || c == (char)0x2028 || c == (char)0x2029 || c == (char)0xFEFF)
                sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
            else sb.Append(c);
        }
        return sb.ToString();
    }
}

// ---- paths -------------------------------------------------------------------------------

class PathInfo
{
    public string Raw;
    public bool Windows;      // drive letter + separator, or a share starting \\ or //
    public string Root;       // "C:" (as written), "\\" (a share), or "/"
    public string[] Segs;     // the names past the root
    public string Error;      // why it isn't a valid path, or null
    public string Key;        // exact identity: root and segments, separators normalised
    public string MatchKey;   // Key, lowercased for a Windows path

    static bool IsSep(char c, bool windows) { return c == '/' || (windows && c == '\\'); }

    // A Windows path splits on / and \, any other on / alone (format.md, Paths).
    public static PathInfo Parse(string p, bool isDir)
    {
        var info = new PathInfo();
        info.Raw = p;
        string rest;
        if (p.Length >= 3 && ((p[0] >= 'A' && p[0] <= 'Z') || (p[0] >= 'a' && p[0] <= 'z')) && p[1] == ':' &&
            (p[2] == '\\' || p[2] == '/'))
        {
            info.Windows = true;
            info.Root = p.Substring(0, 2);
            rest = p.Substring(3);
        }
        // Ordinal: .NET's default StartsWith(string) is culture-sensitive and ignores characters
        // such as U+00AD, so "<SHY>/x" would pass for "/x".
        else if (p.StartsWith("\\\\", StringComparison.Ordinal) || p.StartsWith("//", StringComparison.Ordinal))
        {
            info.Windows = true;
            info.Root = "\\\\";
            rest = p.Substring(2);
        }
        else if (p.StartsWith("/", StringComparison.Ordinal))
        {
            info.Windows = false;
            info.Root = "/";
            rest = p.Substring(1);
        }
        else
        {
            info.Error = "not an absolute path";
            info.Segs = new string[0];
            info.Key = info.MatchKey = "?" + p;
            return info;
        }
        if (isDir)
        {
            // Ignore the separators a DIR ends with.
            int end = rest.Length;
            while (end > 0 && IsSep(rest[end - 1], info.Windows)) end--;
            rest = rest.Substring(0, end);
        }
        var segs = new List<string>();
        if (rest.Length > 0)
        {
            int s0 = 0;
            for (int i = 0; i <= rest.Length; i++)
            {
                if (i == rest.Length || IsSep(rest[i], info.Windows))
                {
                    segs.Add(rest.Substring(s0, i - s0));
                    s0 = i + 1;
                }
            }
        }
        else if (!isDir)
        {
            info.Error = "names a root, not a file";
        }
        info.Segs = segs.ToArray();
        foreach (string seg in info.Segs)
        {
            if (seg.Length == 0) { info.Error = "has an empty segment (a doubled or trailing separator)"; break; }
            if (!isDir && (seg == "." || seg == "..")) { info.Error = "has a '" + seg + "' segment"; break; }
        }
        if (info.Error == null)
        {
            foreach (char c in p)
                if (c == '\t' || c == '\r' || c == '\n') { info.Error = "holds a tab, CR or LF"; break; }
        }
        string sep = info.Windows ? "\\" : "/";
        info.Key = (info.Root == "\\\\" ? "\\\\" : info.Root + sep) + string.Join(sep, info.Segs);
        info.MatchKey = info.Windows ? info.Key.ToLowerInvariant() : info.Key;
        return info;
    }

    // Key of the first n segments.
    public string PrefixKey(int n, bool lower)
    {
        string sep = Windows ? "\\" : "/";
        var parts = new string[n];
        Array.Copy(Segs, parts, n);
        string k = (Root == "\\\\" ? "\\\\" : Root + sep) + string.Join(sep, parts);
        return lower && Windows ? k.ToLowerInvariant() : k;
    }
}

class SetDir
{
    public int LineNo;
    public PathInfo P;
    public string Name;    // the destination folder: last name, a drive's letter, or "" for /
    public bool Reached;

    public bool Matches(PathInfo f, out bool equal)
    {
        equal = false;
        if (P.Error != null || f.Windows != P.Windows) return false;
        if (P.Windows ? !string.Equals(P.Root.ToLowerInvariant(), f.Root.ToLowerInvariant(), StringComparison.Ordinal)
                      : P.Root != f.Root) return false;
        if (f.Segs.Length < P.Segs.Length) return false;
        for (int i = 0; i < P.Segs.Length; i++)
        {
            bool same = P.Windows
                ? string.Equals(P.Segs[i].ToLowerInvariant(), f.Segs[i].ToLowerInvariant(), StringComparison.Ordinal)
                : string.Equals(P.Segs[i], f.Segs[i], StringComparison.Ordinal);
            if (!same) return false;
        }
        if (f.Segs.Length == P.Segs.Length) { equal = true; return false; }
        return true;
    }
}

class FileRow
{
    public int LineNo;
    public string Hash, Path, TimeText;
    public long Size;
    public DateTime Mtime;
    public PathInfo P;
    public SetDir Dir;
    public List<SetDir> Tied = new List<SetDir>(); // other DIRs matching exactly as deep
    public string Refused;       // why this row is refused, or null
    public string[] DestSegs;    // relative destination under <output>
}

class Snapshot
{
    public List<SetDir> Dirs = new List<SetDir>();
    public List<FileRow> Files = new List<FileRow>();
    public string SpecDate, ClientName, ClientVersion, SetName, SnapshotName;
    public List<string> Notes = new List<string>();
    public string RefuseWhole;   // set when the restore as a whole must be refused (DIR collisions)

    public static Snapshot Parse(byte[] text)
    {
        var snap = new Snapshot();
        var rows = Fmt.ReadRows(text);
        foreach (var r in rows)
        {
            if (r.Type == "-")
            {
                var f = new FileRow();
                f.LineNo = r.LineNo;
                snap.Files.Add(f);
                if (r.Fields.Length != 5)
                {
                    f.Refused = "malformed file row: " + r.Fields.Length + " tab-separated fields, not 5";
                    if (r.Fields.Length > 5) f.Path = r.Fields[r.Fields.Length - 1];
                    continue;
                }
                f.Hash = r.Col(2);
                string size = r.Col(3);
                f.TimeText = r.Col(4);
                f.Path = r.Fields[4];
                if (!Fmt.IsHash(f.Hash)) f.Refused = "malformed file row: the hash isn't 64 lowercase hex characters";
                else if (!Fmt.IsDecimal(size) || !long.TryParse(size, NumberStyles.None, CultureInfo.InvariantCulture, out f.Size))
                    f.Refused = "malformed file row: the size isn't a decimal number";
                else if (!Fmt.TryParseTime(f.TimeText, out f.Mtime))
                    f.Refused = "malformed file row: the time isn't a YYYY-MM-DDTHH:MM:SS.sssZ instant";
                continue;
            }
            if (r.Type[0] == '#') continue;
            // An '@' row: only @SET DIR matters to a restore. Others are noted for messages.
            string prop = r.Col(2);
            string value = r.RestAfterFourth();
            if (value == null) continue;
            if (r.Type == "@SET" && prop == "DIR")
            {
                var d = new SetDir();
                d.LineNo = r.LineNo;
                d.P = PathInfo.Parse(value, true);
                snap.Dirs.Add(d);
            }
            else if (r.Type == "@S3CAB" && prop == "SPEC") snap.SpecDate = value;
            else if (r.Type == "@CLIENT" && prop == "NAME") snap.ClientName = value;
            else if (r.Type == "@CLIENT" && prop == "VERSION") snap.ClientVersion = value;
            else if (r.Type == "@SET" && prop == "NAME") snap.SetName = value;
            else if (r.Type == "@SNAPSHOT" && prop == "NAME") snap.SnapshotName = value;
        }
        foreach (var d in snap.Dirs)
        {
            if (d.P.Error != null) continue;
            if (d.P.Segs.Length > 0) d.Name = d.P.Segs[d.P.Segs.Length - 1];
            else if (d.P.Root.Length == 2 && d.P.Root[1] == ':') d.Name = d.P.Root.Substring(0, 1);
            else d.Name = "";
        }
        snap.Validate();
        return snap;
    }

    // The per-path rules of "Valid and invalid files", then the destination layout.
    void Validate()
    {
        // 1. Each row's own path.
        foreach (var f in Files)
        {
            if (f.Path == null) continue;
            f.P = PathInfo.Parse(f.Path, false);
            if (f.Refused != null) continue;
            if (f.P.Error != null) { f.Refused = "the path " + f.P.Error; continue; }
            // Deepest DIR wins; equal depth between differently spelled DIRs is a tie.
            SetDir best = null;
            var tied = new List<SetDir>();
            foreach (var d in Dirs)
            {
                bool equal;
                if (d.Matches(f.P, out equal))
                {
                    if (best == null || d.P.Segs.Length > best.P.Segs.Length) { best = d; tied.Clear(); }
                    else if (d.P.Segs.Length == best.P.Segs.Length && d.P.Key != best.P.Key) tied.Add(d);
                }
                if (equal) { f.Refused = "the path is a @SET DIR itself (line " + d.LineNo + ")"; break; }
            }
            if (f.Refused != null) continue;
            if (best == null) { f.Refused = "the path is under no @SET DIR"; continue; }
            f.Dir = best;
            f.Tied = tied; // a tie collides by name below, if the row survives
        }

        // 2. One path in two file rows: both refused. Every '-' row with a readable path takes part,
        //    malformed or not, so a reader never picks between them.
        var byKey = new Dictionary<string, List<FileRow>>(StringComparer.Ordinal);
        foreach (var f in Files)
        {
            if (f.P == null) continue;
            string k = f.P.Error == null ? f.P.Key : "?" + f.Path;
            List<FileRow> l;
            if (!byKey.TryGetValue(k, out l)) byKey[k] = l = new List<FileRow>();
            l.Add(f);
        }
        foreach (var l in byKey.Values)
        {
            if (l.Count < 2) continue;
            var lines = new List<string>();
            foreach (var f in l) lines.Add(f.LineNo.ToString(CultureInfo.InvariantCulture));
            foreach (var f in l)
                if (f.Refused == null) f.Refused = "the same path is in more than one file row (lines " + string.Join(", ", lines) + ")";
        }

        // 3. Last, among rows every other check let through: one path running through another.
        var live = new Dictionary<string, FileRow>(StringComparer.Ordinal);
        foreach (var f in Files) if (f.Refused == null) live[f.P.Key] = f;
        var through = new List<KeyValuePair<FileRow, FileRow>>();
        foreach (var f in Files)
        {
            if (f.Refused != null) continue;
            for (int n = 1; n < f.P.Segs.Length; n++)
            {
                FileRow other;
                if (live.TryGetValue(f.P.PrefixKey(n, false), out other))
                    through.Add(new KeyValuePair<FileRow, FileRow>(f, other));
            }
        }
        foreach (var kv in through)
        {
            kv.Key.Refused = "the path runs through another file row's path (line " + kv.Value.LineNo + ") as a folder";
            if (kv.Value.Refused == null)
                kv.Value.Refused = "another file row's path (line " + kv.Key.LineNo + ") runs through this one as a folder";
        }

        // 4. Which DIRs the restore reaches, and whether their folders collide.
        foreach (var f in Files)
        {
            if (f.Refused != null) continue;
            f.Dir.Reached = true;
            foreach (var t in f.Tied) t.Reached = true;
        }
        var reached = new List<SetDir>();
        foreach (var d in Dirs) if (d.Reached) reached.Add(d);
        var problems = new List<string>();
        for (int i = 0; i < reached.Count; i++)
        {
            for (int j = i + 1; j < reached.Count; j++)
            {
                var a = reached[i];
                var b = reached[j];
                if (a.P.Key == b.P.Key) continue; // the same DIR written twice
                if (a.Name == "" || b.Name == "")
                    problems.Add("@SET DIR " + Fmt.Printable(a.P.Raw) + " and " + Fmt.Printable(b.P.Raw) +
                        ": files under / land straight in the output, beside another DIR's folder");
                else if (string.Equals(a.Name.ToLowerInvariant(), b.Name.ToLowerInvariant(), StringComparison.Ordinal))
                    problems.Add("@SET DIR " + Fmt.Printable(a.P.Raw) + " and " + Fmt.Printable(b.P.Raw) +
                        " both want the folder '" + Fmt.Printable(a.Name) + "' (names compared ignoring case)");
            }
        }
        if (problems.Count > 0) RefuseWhole = string.Join("; ", problems);

        // 5. Destinations: <output>\<DIR name>\<rest of the path below the DIR>.
        foreach (var f in Files)
        {
            if (f.Refused != null) continue;
            var segs = new List<string>();
            if (f.Dir.Name != "") segs.Add(f.Dir.Name);
            for (int i = f.Dir.P.Segs.Length; i < f.P.Segs.Length; i++) segs.Add(f.P.Segs[i]);
            f.DestSegs = segs.ToArray();
        }
    }

    // Names this Windows destination can't hold, or would misread. Checked before anything is
    // written. `\` and `:` are the dangerous ones: `\` is a separator here (a POSIX name `a\..\x`
    // would climb), and `a:b` is an NTFS alternate data stream of `a`.
    public static string WindowsNameProblem(string name)
    {
        foreach (char c in name)
        {
            if (c == '\\' || c == '/') return "holds '" + c + "', a path separator on Windows";
            if (c == ':') return "holds ':', which NTFS reads as a stream name";
        }
        foreach (char c in name)
        {
            if (c < 0x20) return "holds control character \\x" + ((int)c).ToString("x2", CultureInfo.InvariantCulture) + ", which Windows forbids in a name";
            if ("*?\"<>|".IndexOf(c) >= 0) return "holds '" + c + "', which Windows forbids in a name";
        }
        return null;
    }

    // Plan destinations on a Windows (case-insensitive) filesystem: in row order, a later row whose
    // destination the filesystem would hold as an earlier one's, or that needs a folder where an
    // earlier one is a file (or the reverse), is refused. First row wins.
    public void PlanForWindows()
    {
        var files = new Dictionary<string, FileRow>(StringComparer.OrdinalIgnoreCase);
        var folders = new Dictionary<string, FileRow>(StringComparer.OrdinalIgnoreCase);
        foreach (var f in Files)
        {
            if (f.Refused != null) continue;
            string bad = null;
            foreach (string seg in f.DestSegs)
            {
                string why = WindowsNameProblem(seg);
                if (why != null) { bad = "the name '" + Fmt.Printable(seg) + "' " + why; break; }
            }
            if (bad != null) { f.Refused = bad; continue; }
            string rel = string.Join("\\", f.DestSegs);
            FileRow other;
            if (files.TryGetValue(rel, out other))
            {
                f.Refused = "lands on the same file as line " + other.LineNo + " here (Windows ignores letter case)";
                continue;
            }
            if (folders.TryGetValue(rel, out other))
            {
                f.Refused = "lands where line " + other.LineNo + " needs a folder (Windows ignores letter case)";
                continue;
            }
            for (int n = 1; n < f.DestSegs.Length && bad == null; n++)
            {
                string pre = string.Join("\\", f.DestSegs, 0, n);
                if (files.TryGetValue(pre, out other))
                    bad = "needs a folder where line " + other.LineNo + " lands a file (Windows ignores letter case)";
            }
            if (bad != null) { f.Refused = bad; continue; }
            files[rel] = f;
            for (int n = 1; n < f.DestSegs.Length; n++)
            {
                string pre = string.Join("\\", f.DestSegs, 0, n);
                if (!folders.ContainsKey(pre)) folders[pre] = f;
            }
        }
    }
}

// ---- choosing the latest snapshot -----------------------------------------------------------

static class Latest
{
    // Only keys named YYYY-MM-DDTHHMM.tsv.gz directly under the set's folder count; the name that
    // sorts last (ordinal) wins. `\z`, not `$` (which also matches before a final LF), and
    // [0-9], not \d (which matches any Unicode digit).
    static readonly System.Text.RegularExpressions.Regex Name = new System.Text.RegularExpressions.Regex(
        @"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{4}\.tsv\.gz\z", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    public static string Choose(IEnumerable<string> keys, string prefix, out int ignored)
    {
        string best = null;
        ignored = 0;
        foreach (string k in keys)
        {
            if (!k.StartsWith(prefix, StringComparison.Ordinal)) { ignored++; continue; }
            string leaf = k.Substring(prefix.Length);
            if (!Name.IsMatch(leaf)) { ignored++; continue; }
            string n = leaf.Substring(0, leaf.Length - 7);
            if (best == null || string.CompareOrdinal(n, best) > 0) best = n;
        }
        return best;
    }
}

// ---- deletion records ----------------------------------------------------------------------

class Deletion
{
    public string Hash, TimeText, Who, Record;
    public DateTime Time;
}

static class DeletionRecord
{
    // Reads one record. Malformed #deleted rows are dropped (their objects count as not deleted);
    // the caller reports them.
    public static List<Deletion> Parse(byte[] text, string recordName, List<string> problems)
    {
        var result = new List<Deletion>();
        foreach (var r in Fmt.ReadRows(text))
        {
            if (r.Type != "#deleted") continue;
            if (r.Fields.Length != 5) { problems.Add(recordName + " line " + r.LineNo + ": malformed #deleted row (" + r.Fields.Length + " fields)"); continue; }
            var d = new Deletion();
            d.Hash = r.Col(2);
            string size = r.Col(3);
            d.TimeText = r.Col(4);
            d.Who = r.Fields[4];
            d.Record = recordName;
            if (!Fmt.IsHash(d.Hash) || !Fmt.IsDecimal(size) || !Fmt.TryParseTime(d.TimeText, out d.Time))
            {
                problems.Add(recordName + " line " + r.LineNo + ": malformed #deleted row");
                continue;
            }
            result.Add(d);
        }
        return result;
    }
}
