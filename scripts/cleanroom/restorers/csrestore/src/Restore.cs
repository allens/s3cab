// s3cab-restore: an independent restorer for the s3cab repository format (format.md, 2026-10-20).
//
//   s3cab-restore.exe <bucket> <set> <dir> [<snapshot>]
//
// Credentials from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN, region from
// AWS_REGION (or AWS_DEFAULT_REGION). Files land at <dir>\<name of the matching @SET DIR>\<rest>,
// as format.md describes s3cab's own restore to a chosen directory.
//
// Exit 0: everything restored (deliberate deletions and files already present aside).
// Exit 1: restored what it could; some files weren't (damage, refused rows, names or times
//         this machine can't hold, something in the way). Each is listed.
// Exit 2: nothing restored on purpose: usage, snapshot refused whole, restore refused, or the
//         restore stopped on a storage failure other than a 404.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

// Without this a csc-built exe runs with .NET's legacy path handling (no \\?\, MAX_PATH limits)
// and the 4.0-era TLS defaults. format.md's own hint.
[assembly: TargetFramework(".NETFramework,Version=v4.8")]

enum Outcome { Pending, Restored, Deleted, Missing, Corrupt, Skipped, InTheWay, Collision, WriteFailed, NotAttempted }

// A file's identity on its volume, so "already there" can tell a file that was there before the
// restore from one this restore wrote for another row under a name the filesystem folds together.
static class FileIdentity
{
    [StructLayout(LayoutKind.Sequential)]
    struct Info
    {
        public uint Attributes;
        public uint Created1, Created2, Accessed1, Accessed2, Written1, Written2;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);

    public static string Of(SafeFileHandle h)
    {
        Info i;
        if (!GetFileInformationByHandle(h, out i)) return null;
        return i.Volume.ToString("x8", CultureInfo.InvariantCulture) + ":" +
            i.IndexHigh.ToString("x8", CultureInfo.InvariantCulture) + i.IndexLow.ToString("x8", CultureInfo.InvariantCulture);
    }

    public static string Of(string path)
    {
        try
        {
            using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                return Of(fs.SafeFileHandle);
        }
        catch (Exception) { return null; }
    }
}

class Result
{
    public Outcome Status = Outcome.Pending;
    public string Message;
    public string TimeProblem;   // the stored time wasn't kept (more than 2 s off, or unsettable)
    public bool TimeRounded;     // kept to within 2 s, not exactly
}

// Holds a download: in memory up to a threshold, then in a temporary file inside the output
// directory (never outside it).
class SpillBuffer : IDisposable
{
    const long Threshold = 16L * 1024 * 1024;
    readonly Func<string> spillPathMaker;
    MemoryStream mem = new MemoryStream();
    FileStream file;
    string filePath;

    public SpillBuffer(Func<string> spillPathMaker) { this.spillPathMaker = spillPathMaker; }

    public void Write(byte[] b, int o, int n)
    {
        if (file == null && mem.Length + n > Threshold)
        {
            filePath = spillPathMaker();
            Console.Error.WriteLine("  (over " + (Threshold >> 20) + " MiB: buffering in a temporary file in the output directory)");
            file = new FileStream(filePath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
            mem.Position = 0;
            mem.CopyTo(file);
            mem = null;
        }
        if (file != null) file.Write(b, o, n); else mem.Write(b, o, n);
    }

    // Writes the bytes to a new file. Throws IOException, having created nothing, if something
    // is already there; a write that fails part-way removes its partial file before throwing.
    public void WriteTo(string dest, Action<string> created)
    {
        var outp = new FileStream(dest, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        try
        {
            created(FileIdentity.Of(outp.SafeFileHandle));
            if (file != null)
            {
                file.Flush();
                file.Position = 0;
                file.CopyTo(outp);
            }
            else
            {
                mem.Position = 0;
                mem.CopyTo(outp);
            }
            outp.Dispose();
        }
        catch (Exception)
        {
            outp.Dispose();
            try { File.Delete(dest); } catch (Exception) { }
            throw;
        }
    }

    public void Dispose()
    {
        if (file != null)
        {
            file.Dispose();
            try { File.Delete(filePath); } catch (Exception) { }
            file = null;
        }
        mem = null;
    }
}

static class Program
{
    static readonly Regex DeletionRecordKey =
        new Regex(@"^objects\.deleted-[0-9]+\.tsv\z", RegexOptions.CultureInvariant);
    static readonly Regex SetName = new Regex(@"^[a-z0-9-]+\z", RegexOptions.CultureInvariant);

    static S3Client s3;
    static string outRoot;              // \\?\ form
    static readonly object rootLock = new object();
    static bool rootReady;

    static readonly object deletionLock = new object();
    static Dictionary<string, Deletion> deletions;
    static readonly List<string> recordProblems = new List<string>();

    static volatile bool stopped;
    static string stopReason;

    static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length < 3 || args.Length > 4)
        {
            Console.Error.WriteLine("usage: s3cab-restore.exe <bucket> <set> <dir> [<snapshot>]");
            return 2;
        }
        string bucket = args[0], set = args[1], dir = args[2];
        string snapshotArg = args.Length > 3 ? args[3] : null;
        try
        {
            return Run(bucket, set, dir, snapshotArg);
        }
        catch (S3Exception e)
        {
            Console.WriteLine("STOPPED: " + e.Message);
            if (e.Status == 403)
                Console.WriteLine("  (403: access denied or credentials expired; a restore can't tell a missing key from a permissions fault)");
            return 2;
        }
    }

    static string Env(string name)
    {
        string v = Environment.GetEnvironmentVariable(name);
        return string.IsNullOrEmpty(v) ? null : v;
    }

    // An absolute path in the \\?\ form, so Windows takes every name exactly as written:
    // trailing dots and spaces kept, reserved names like CON allowed, no MAX_PATH.
    static string Extended(string full)
    {
        if (full.StartsWith(@"\\?\", StringComparison.Ordinal)) return full;
        if (full.StartsWith(@"\\", StringComparison.Ordinal)) return @"\\?\UNC\" + full.Substring(2);
        return @"\\?\" + full;
    }

    static int Run(string bucket, string set, string dir, string snapshotArg)
    {
        if (!SetName.IsMatch(set))
        {
            Console.Error.WriteLine("error: '" + set + "' isn't a set name (lowercase letters, digits and hyphens)");
            return 2;
        }
        string ak = Env("AWS_ACCESS_KEY_ID"), sk = Env("AWS_SECRET_ACCESS_KEY");
        if (ak == null || sk == null)
        {
            Console.Error.WriteLine("error: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set");
            return 2;
        }
        string region = Env("AWS_REGION") ?? Env("AWS_DEFAULT_REGION") ?? "us-east-1";
        ServicePointManager.DefaultConnectionLimit = 16;
        s3 = new S3Client(bucket, region, ak, sk, Env("AWS_SESSION_TOKEN"));

        string full = Path.GetFullPath(dir).TrimEnd('\\');
        if (full.EndsWith(":", StringComparison.Ordinal)) full += "\\";
        outRoot = Extended(full).TrimEnd('\\');

        // ---- which snapshot ----
        string prefix = "snapshots/" + set + "/";
        string name;
        if (snapshotArg != null)
        {
            name = snapshotArg.EndsWith(".tsv.gz", StringComparison.Ordinal) ? snapshotArg.Substring(0, snapshotArg.Length - 7) : snapshotArg;
            if (name.Length == 0 || name.IndexOf('/') >= 0 || name.IndexOf('\\') >= 0)
            {
                Console.Error.WriteLine("error: '" + snapshotArg + "' isn't a snapshot name");
                return 2;
            }
        }
        else
        {
            var listing = s3.List(prefix, "/");
            int ignored;
            name = Latest.Choose(listing.Keys, prefix, out ignored);
            if (name == null)
            {
                Console.WriteLine("set '" + set + "' has no snapshots in s3://" + bucket + "/" + prefix +
                    (ignored + listing.Prefixes.Count > 0 ? " (" + (ignored + listing.Prefixes.Count) + " other keys ignored)" : ""));
                return 2;
            }
        }
        string key = prefix + name + ".tsv.gz";
        Console.WriteLine("snapshot  s3://" + bucket + "/" + key);
        Console.WriteLine("output    " + full);

        byte[] gz = null;
        bool found = s3.Get(key, null, delegate(HttpWebResponse resp, Stream body)
        {
            var ms = new MemoryStream();
            body.CopyTo(ms);
            gz = ms.ToArray();
        });
        if (!found)
        {
            Console.WriteLine("no such snapshot: " + key);
            return 2;
        }

        Snapshot snap;
        try
        {
            snap = Snapshot.Parse(Fmt.Gunzip(gz));
        }
        catch (RefusedFile e)
        {
            Console.WriteLine("REFUSED: the snapshot can't be trusted as a whole: " + e.Message);
            Console.WriteLine("nothing restored");
            return 2;
        }
        if (snap.RefuseWhole != null)
        {
            Console.WriteLine("REFUSED: " + snap.RefuseWhole);
            Console.WriteLine("nothing restored");
            return 2;
        }
        snap.PlanForWindows();
        Console.WriteLine("rows      " + snap.Files.Count + " file rows, " + snap.Dirs.Count + " @SET DIR rows" +
            (snap.SpecDate != null ? ", spec " + snap.SpecDate : "") +
            (snap.ClientName != null ? ", written by " + snap.ClientName + " " + snap.ClientVersion : ""));

        // ---- fetch and write, one download per distinct hash ----
        var results = new Dictionary<FileRow, Result>();
        var groups = new Dictionary<string, List<FileRow>>(StringComparer.Ordinal);
        foreach (var f in snap.Files)
        {
            if (f.Refused != null) continue;
            results[f] = new Result();
            List<FileRow> l;
            if (!groups.TryGetValue(f.Hash, out l)) groups[f.Hash] = l = new List<FileRow>();
            l.Add(f);
        }
        bool rootExisted = Directory.Exists(outRoot);
        int done = 0;
        var opts = new ParallelOptions();
        opts.MaxDegreeOfParallelism = 8;
        Parallel.ForEach(groups, opts, delegate(KeyValuePair<string, List<FileRow>> g)
        {
            RestoreGroup(g.Key, g.Value, results);
            int d = Interlocked.Add(ref done, g.Value.Count);
            if (d % 250 < g.Value.Count) Console.Error.WriteLine("  ... " + d + " of " + results.Count);
        });

        // Folders are made only as files land in them: if only a spill file needed the output
        // directory and nothing landed, take it away again.
        if (!rootExisted && Directory.Exists(outRoot) && Directory.GetFileSystemEntries(outRoot).Length == 0)
            Directory.Delete(outRoot);

        return Report(snap, results);
    }

    static void EnsureRoot()
    {
        lock (rootLock)
        {
            if (rootReady) return;
            Directory.CreateDirectory(outRoot);
            rootReady = true;
        }
    }

    static string Hex(byte[] bytes)
    {
        var sb = new StringBuilder(bytes.Length * 2);
        foreach (byte b in bytes) sb.Append(b.ToString("x2", CultureInfo.InvariantCulture));
        return sb.ToString();
    }

    static void RestoreGroup(string hash, List<FileRow> rows, Dictionary<FileRow, Result> results)
    {
        if (stopped)
        {
            foreach (var f in rows) Set(results, f, Outcome.NotAttempted, "the restore stopped before this file");
            return;
        }
        SpillBuffer buf = null;
        string got = null;
        try
        {
            bool found = s3.Get("objects/" + hash, null, delegate(HttpWebResponse resp, Stream body)
            {
                if (buf != null) buf.Dispose();
                buf = new SpillBuffer(delegate
                {
                    EnsureRoot();
                    return outRoot + "\\.s3cab-restore-" + Guid.NewGuid().ToString("N") + ".part";
                });
                using (var sha = SHA256.Create())
                {
                    var b = new byte[81920];
                    int n;
                    while ((n = body.Read(b, 0, b.Length)) > 0)
                    {
                        sha.TransformBlock(b, 0, n, null, 0);
                        buf.Write(b, 0, n);
                    }
                    sha.TransformFinalBlock(b, 0, 0);
                    got = Hex(sha.Hash);
                }
            });
            if (!found)
            {
                // A miss, and only then, is looked up in the deletion records.
                Deletion del = LookUpDeletion(hash);
                foreach (var f in rows)
                {
                    if (del != null)
                        Set(results, f, Outcome.Deleted, "deliberately deleted " + del.TimeText + " by " + del.Who + " (" + del.Record + ")");
                    else
                        Set(results, f, Outcome.Missing, "objects/" + hash + " is missing and no deletion record lists it: damage");
                }
                return;
            }
            if (got != hash)
            {
                foreach (var f in rows)
                    Set(results, f, Outcome.Corrupt, "objects/" + hash + " downloaded as bytes hashing to " + got + ": damage, withheld");
                return;
            }
            foreach (var f in rows) WriteOne(f, buf, results);
        }
        catch (S3Exception e)
        {
            lock (deletionLock)
            {
                if (!stopped) { stopped = true; stopReason = e.Message + (e.Status == 403 ? " (403: access denied, or the credentials expired)" : ""); }
            }
            foreach (var f in rows) if (results[f].Status == Outcome.Pending) Set(results, f, Outcome.NotAttempted, "the restore stopped: " + e.Message);
        }
        catch (Exception e)
        {
            foreach (var f in rows) if (results[f].Status == Outcome.Pending) Set(results, f, Outcome.WriteFailed, e.GetType().Name + ": " + e.Message);
        }
        finally
        {
            if (buf != null) buf.Dispose();
        }
    }

    static void Set(Dictionary<FileRow, Result> results, FileRow f, Outcome o, string message)
    {
        var r = results[f];
        r.Status = o;
        r.Message = message;
    }

    static void WriteOne(FileRow f, SpillBuffer buf, Dictionary<FileRow, Result> results)
    {
        var r = results[f];
        string dest = outRoot + "\\" + string.Join("\\", f.DestSegs);
        if (!dest.StartsWith(outRoot + "\\", StringComparison.Ordinal))
        {
            Set(results, f, Outcome.WriteFailed, "internal: destination outside the output directory");
            return;
        }
        // Folders are made only as files land in them: any this row creates are removed again
        // (when still empty) if its file doesn't land.
        var created = new List<string>();
        for (int attempt = 0; ; attempt++)
        {
            try
            {
                EnsureRoot();
                string cur = outRoot;
                for (int i = 0; i < f.DestSegs.Length - 1; i++)
                {
                    cur += "\\" + f.DestSegs[i];
                    if (File.Exists(cur))
                    {
                        Set(results, f, Outcome.InTheWay, "a file is in the way where a folder should be: " + Shown(cur));
                        break;
                    }
                    if (!Directory.Exists(cur)) { Directory.CreateDirectory(cur); created.Add(cur); }
                }
                if (r.Status != Outcome.Pending) break;
                if (Directory.Exists(dest))
                {
                    Set(results, f, Outcome.InTheWay, "a folder is in the way where the file should land");
                    break;
                }
                if (File.Exists(dest))
                {
                    AlreadyThere(f, dest, results);
                    break;
                }
                try
                {
                    buf.WriteTo(dest, delegate(string id) { if (id != null) lock (writtenLock) written.Add(id); });
                }
                catch (IOException)
                {
                    // CreateNew lost a race to something now at dest; a failure part-way through
                    // the write removed its own partial file, so dest exists only in the race case.
                    if (File.Exists(dest)) { AlreadyThere(f, dest, results); break; }
                    throw;
                }
                Set(results, f, Outcome.Restored, null);
                break;
            }
            catch (DirectoryNotFoundException e)
            {
                // Another row's clean-up removed a folder this one needs: make it again, once.
                if (attempt > 0)
                {
                    Set(results, f, Outcome.WriteFailed, e.GetType().Name + ": " + e.Message);
                    break;
                }
            }
            catch (Exception e)
            {
                Set(results, f, Outcome.WriteFailed, e.GetType().Name + ": " + e.Message);
                break;
            }
        }
        if (r.Status != Outcome.Restored)
        {
            for (int i = created.Count - 1; i >= 0; i--)
            {
                try { Directory.Delete(created[i]); } catch (Exception) { break; }
            }
            return;
        }

        // The stored modification time, to the millisecond; then read it back.
        try
        {
            File.SetLastWriteTimeUtc(dest, f.Mtime);
        }
        catch (Exception e)
        {
            r.TimeProblem = "couldn't set the time " + f.TimeText + ": " + e.Message;
            return;
        }
        DateTime back = File.GetLastWriteTimeUtc(dest);
        long diff = Math.Abs(back.Ticks - f.Mtime.Ticks);
        if (diff == 0) return;
        if (diff < TimeSpan.TicksPerSecond * 2) { r.TimeRounded = true; return; }
        r.TimeProblem = "the time " + f.TimeText + " was kept as " +
            back.ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", CultureInfo.InvariantCulture);
    }

    static readonly object writtenLock = new object();
    static readonly HashSet<string> written = new HashSet<string>(StringComparer.Ordinal);

    // A file at the destination is left alone. If this restore wrote it, for another row whose
    // name the filesystem holds as the same, that's a collision, not a skip.
    static void AlreadyThere(FileRow f, string dest, Dictionary<FileRow, Result> results)
    {
        string id = FileIdentity.Of(dest);
        bool ours;
        lock (writtenLock) ours = id != null && written.Contains(id);
        if (ours)
            Set(results, f, Outcome.Collision, "lands on a file this restore already wrote for another row (this filesystem holds the two names as one)");
        else
            Set(results, f, Outcome.Skipped, "already there, left alone");
    }

    static string Shown(string extended)
    {
        return extended.StartsWith(@"\\?\UNC\", StringComparison.Ordinal) ? @"\\" + extended.Substring(8)
             : extended.StartsWith(@"\\?\", StringComparison.Ordinal) ? extended.Substring(4) : extended;
    }

    // ---- deletion records ----

    static Deletion LookUpDeletion(string hash)
    {
        lock (deletionLock)
        {
            if (deletions == null) LoadDeletions();
            Deletion d;
            return deletions.TryGetValue(hash, out d) ? d : null;
        }
    }

    static void LoadDeletions()
    {
        var all = new Dictionary<string, Deletion>(StringComparer.Ordinal);
        var read = new HashSet<string>(StringComparer.Ordinal);
        for (int pass = 0; pass < 3; pass++)
        {
            bool vanished = false;
            var listing = s3.List("objects.deleted-", "/");
            foreach (string k in listing.Keys)
            {
                if (!DeletionRecordKey.IsMatch(k) || read.Contains(k)) continue;
                byte[] text = null;
                bool found = s3.Get(k, null, delegate(HttpWebResponse resp, Stream body)
                {
                    var ms = new MemoryStream();
                    body.CopyTo(ms);
                    text = ms.ToArray();
                });
                if (!found) { vanished = true; continue; }
                read.Add(k);
                List<Deletion> rows;
                try
                {
                    rows = DeletionRecord.Parse(text, k, recordProblems);
                }
                catch (RefusedFile e)
                {
                    recordProblems.Add(k + " refused, none of its rows trusted: " + e.Message);
                    continue;
                }
                foreach (var d in rows)
                {
                    Deletion prev;
                    if (!all.TryGetValue(d.Hash, out prev) || d.Time > prev.Time) all[d.Hash] = d;
                }
            }
            // A record listed but gone by its GET was compacted: the merged record that absorbed
            // it was written first, after our listing, so list again to find it.
            if (!vanished) break;
        }
        deletions = all;
    }

    // ---- report ----

    static int Report(Snapshot snap, Dictionary<FileRow, Result> results)
    {
        int restored = 0, deleted = 0, skipped = 0, rounded = 0, bad = 0;
        var lines = new List<string>();
        foreach (var f in snap.Files)
        {
            string path = Fmt.Printable(f.Path ?? "(no path field)");
            if (f.Refused != null)
            {
                bad++;
                lines.Add("REFUSED   line " + f.LineNo + "  " + path + "\n          " + f.Refused);
                continue;
            }
            var r = results[f];
            string dest = Fmt.Printable(string.Join("\\", f.DestSegs));
            switch (r.Status)
            {
                case Outcome.Restored:
                    restored++;
                    if (r.TimeRounded) rounded++;
                    if (r.TimeProblem != null)
                    {
                        bad++;
                        lines.Add("TIME      line " + f.LineNo + "  " + dest + "\n          " + r.TimeProblem + " (file kept)");
                    }
                    break;
                case Outcome.Deleted:
                    deleted++;
                    lines.Add("DELETED   line " + f.LineNo + "  " + path + "\n          " + r.Message);
                    break;
                case Outcome.Skipped:
                    skipped++;
                    lines.Add("SKIPPED   line " + f.LineNo + "  " + dest + "\n          " + r.Message);
                    break;
                default:
                    bad++;
                    lines.Add(r.Status.ToString().ToUpperInvariant().PadRight(9) + " line " + f.LineNo + "  " + path +
                        "\n          " + r.Message);
                    break;
            }
        }
        foreach (string l in lines) Console.WriteLine(l);
        foreach (string p in recordProblems) Console.WriteLine("RECORD    " + p);
        Console.WriteLine("restored  " + restored + " of " + snap.Files.Count + " file rows" +
            (rounded > 0 ? " (" + rounded + " with the time rounded by the disk)" : ""));
        if (deleted > 0) Console.WriteLine("deleted   " + deleted + " deliberately deleted, skipped");
        if (skipped > 0) Console.WriteLine("skipped   " + skipped + " already at their destination");
        if (bad > 0) Console.WriteLine("problems  " + bad + " files not restored as stored (listed above)");
        if (stopped)
        {
            Console.WriteLine("STOPPED: " + stopReason);
            return 2;
        }
        return bad > 0 ? 1 : 0;
    }
}
