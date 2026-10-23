// s3cab-restore.cs
//
// A clean-room restorer for the s3cab repository format, written from format.md alone.
// No AWS SDK, no S3 client library: plain HTTPS through HttpWebRequest, SigV4 signed by hand,
// SHA-256 from System.Security.Cryptography, and gzip/DEFLATE decoded by the code below so the
// end of each gzip stream is known (format.md says .NET's GZipStream can't report it).
//
// Build:  C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /optimize+ /out:s3cab-restore.exe s3cab-restore.cs
// Usage:  s3cab-restore.exe <bucket> <set> <dir> [<snapshot>] [--verbose] [--save-snapshot <file>]
//
// Credentials and region come from AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN
// and AWS_REGION. Exit 0 when everything restorable was restored (skips of files already there
// and deliberately deleted files included); 1 when anything was damaged, refused, collided or
// the restore stopped; 2 for a usage error.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using Microsoft.Win32.SafeHandles;

// Makes .NET Framework accept \\?\ paths and paths past 260 characters (format.md hint).
[assembly: TargetFramework(".NETFramework,Version=v4.8", FrameworkDisplayName = ".NET Framework 4.8")]

namespace S3cabRestore
{
    // A file (snapshot or record) that is damaged or refused whole.
    sealed class DamagedException : Exception { public DamagedException(string m) : base(m) { } }
    // Something that stops the whole restore (403, NoSuchBucket, transport given up).
    sealed class StopException : Exception { public StopException(string m) : base(m) { } }
    // Something in the way at the destination.
    sealed class InTheWayException : Exception { public InTheWayException(string m) : base(m) { } }

    // ------------------------------------------------------------------ CRC-32 (gzip trailer)
    static class Crc32
    {
        static readonly uint[] Table = MakeTable();
        static uint[] MakeTable()
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
        public static uint Compute(byte[] data, int offset, int count)
        {
            uint c = 0xFFFFFFFFu;
            for (int i = offset; i < offset + count; i++) c = Table[(c ^ data[i]) & 0xFF] ^ (c >> 8);
            return c ^ 0xFFFFFFFFu;
        }
    }

    // ------------------------------------------------------------------ DEFLATE (RFC 1951)
    // A straightforward inflater that reports where the stream ended, which is what the gzip
    // reader needs to find the trailer, a following stream, or stray bytes.
    sealed class Inflater
    {
        const int MaxBits = 15;
        static readonly short[] LenBase = { 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258 };
        static readonly short[] LenExtra = { 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0 };
        static readonly short[] DistBase = { 1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577 };
        static readonly short[] DistExtra = { 0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13 };
        static readonly byte[] ClOrder = { 16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15 };

        sealed class Huffman
        {
            public readonly short[] Count = new short[MaxBits + 1];
            public readonly short[] Symbol;
            public Huffman(int n) { Symbol = new short[n]; }
        }

        static Huffman fixedLen, fixedDist;

        readonly byte[] inp;
        readonly int end;
        int pos;
        int bitbuf, bitcnt;
        byte[] outBuf = new byte[1 << 16];
        int outLen;

        public Inflater(byte[] input, int start, int end) { inp = input; pos = start; this.end = end; }

        // After Run(): the index of the first byte after the DEFLATE stream.
        public int Position { get { return pos; } }

        static Exception Bad(string why) { return new DamagedException("deflate: " + why); }

        int Bits(int need)
        {
            long val = bitbuf;
            while (bitcnt < need)
            {
                if (pos >= end) throw Bad("stream cut short");
                val |= (long)inp[pos++] << bitcnt;
                bitcnt += 8;
            }
            bitbuf = (int)(val >> need);
            bitcnt -= need;
            return (int)(val & ((1L << need) - 1));
        }

        void Put(byte b)
        {
            if (outLen == outBuf.Length) Array.Resize(ref outBuf, outBuf.Length * 2);
            outBuf[outLen++] = b;
        }

        public byte[] Run()
        {
            int last;
            do
            {
                last = Bits(1);
                int type = Bits(2);
                if (type == 0) Stored();
                else if (type == 1) Fixed();
                else if (type == 2) Dynamic();
                else throw Bad("invalid block type");
            } while (last == 0);
            // Bits() loads one byte at a time, so fewer than 8 bits are ever left over: they are
            // the padding of the current byte, and pos already points at the next byte.
            bitbuf = 0; bitcnt = 0;
            var result = new byte[outLen];
            Array.Copy(outBuf, result, outLen);
            return result;
        }

        void Stored()
        {
            bitbuf = 0; bitcnt = 0;
            if (pos + 4 > end) throw Bad("stored block header cut short");
            int len = inp[pos] | (inp[pos + 1] << 8);
            int nlen = inp[pos + 2] | (inp[pos + 3] << 8);
            pos += 4;
            if (len != (~nlen & 0xFFFF)) throw Bad("stored block length check failed");
            if (pos + len > end) throw Bad("stored block cut short");
            for (int i = 0; i < len; i++) Put(inp[pos + i]);
            pos += len;
        }

        static int Construct(Huffman h, short[] length, int offset, int n)
        {
            for (int len = 0; len <= MaxBits; len++) h.Count[len] = 0;
            for (int i = 0; i < n; i++) h.Count[length[offset + i]]++;
            if (h.Count[0] == n) return 0;
            int left = 1;
            for (int len = 1; len <= MaxBits; len++)
            {
                left <<= 1;
                left -= h.Count[len];
                if (left < 0) return left;
            }
            var offs = new short[MaxBits + 1];
            offs[1] = 0;
            for (int len = 1; len < MaxBits; len++) offs[len + 1] = (short)(offs[len] + h.Count[len]);
            for (int i = 0; i < n; i++)
                if (length[offset + i] != 0) h.Symbol[offs[length[offset + i]]++] = (short)i;
            return left;
        }

        int Decode(Huffman h)
        {
            int code = 0, first = 0, index = 0;
            for (int len = 1; len <= MaxBits; len++)
            {
                code |= Bits(1);
                int count = h.Count[len];
                if (code - count < first) return h.Symbol[index + (code - first)];
                index += count;
                first += count;
                first <<= 1;
                code <<= 1;
            }
            throw Bad("invalid Huffman code");
        }

        void Codes(Huffman lencode, Huffman distcode)
        {
            for (; ; )
            {
                int sym = Decode(lencode);
                if (sym < 256) { Put((byte)sym); continue; }
                if (sym == 256) return;
                sym -= 257;
                if (sym >= 29) throw Bad("invalid length symbol");
                int len = LenBase[sym] + Bits(LenExtra[sym]);
                int dsym = Decode(distcode);
                if (dsym >= 30) throw Bad("invalid distance symbol");
                int dist = DistBase[dsym] + Bits(DistExtra[dsym]);
                if (dist > outLen) throw Bad("distance too far back");
                int from = outLen - dist;
                for (int i = 0; i < len; i++) Put(outBuf[from + i]);
            }
        }

        void Fixed()
        {
            if (fixedLen == null)
            {
                var lengths = new short[288];
                int s = 0;
                for (; s < 144; s++) lengths[s] = 8;
                for (; s < 256; s++) lengths[s] = 9;
                for (; s < 280; s++) lengths[s] = 7;
                for (; s < 288; s++) lengths[s] = 8;
                var fl = new Huffman(288);
                Construct(fl, lengths, 0, 288);
                var dl = new short[30];
                for (s = 0; s < 30; s++) dl[s] = 5;
                var fd = new Huffman(30);
                Construct(fd, dl, 0, 30);
                fixedDist = fd;
                fixedLen = fl;
            }
            Codes(fixedLen, fixedDist);
        }

        void Dynamic()
        {
            int nlen = Bits(5) + 257, ndist = Bits(5) + 1, ncode = Bits(4) + 4;
            if (nlen > 286 || ndist > 30) throw Bad("bad code counts");
            var lengths = new short[286 + 30];
            for (int i = 0; i < ncode; i++) lengths[ClOrder[i]] = (short)Bits(3);
            for (int i = ncode; i < 19; i++) lengths[ClOrder[i]] = 0;
            var lencode = new Huffman(286);
            var distcode = new Huffman(30);
            int err = Construct(lencode, lengths, 0, 19);
            if (err != 0) throw Bad("code lengths code is incomplete or over-subscribed");
            int index = 0;
            while (index < nlen + ndist)
            {
                int sym = Decode(lencode);
                if (sym < 16) { lengths[index++] = (short)sym; continue; }
                int len = 0, rep;
                if (sym == 16)
                {
                    if (index == 0) throw Bad("repeat with no first length");
                    len = lengths[index - 1];
                    rep = 3 + Bits(2);
                }
                else if (sym == 17) rep = 3 + Bits(3);
                else rep = 11 + Bits(7);
                if (index + rep > nlen + ndist) throw Bad("repeat past the end of the lengths");
                while (rep-- > 0) lengths[index++] = (short)len;
            }
            if (lengths[256] == 0) throw Bad("no end-of-block code");
            err = Construct(lencode, lengths, 0, nlen);
            if (err < 0 || (err > 0 && nlen - lencode.Count[0] != 1)) throw Bad("bad literal/length code");
            err = Construct(distcode, lengths, nlen, ndist);
            if (err < 0 || (err > 0 && ndist - distcode.Count[0] != 1)) throw Bad("bad distance code");
            Codes(lencode, distcode);
        }
    }

    // ------------------------------------------------------------------ gzip (RFC 1952)
    static class Gzip
    {
        // Every stream in turn, joined; bytes after the last that don't start another stream
        // are damage, except that a zero byte there ends the file, as s3cab's reader does.
        public static byte[] Decompress(byte[] data, List<string> notes)
        {
            int pos = 0, members = 0;
            var outp = new MemoryStream();
            while (pos < data.Length)
            {
                if (pos + 1 < data.Length && data[pos] == 0x1F && data[pos + 1] == 0x8B)
                {
                    pos = Member(data, pos, outp);
                    members++;
                    continue;
                }
                if (members > 0 && data[pos] == 0)
                {
                    notes.Add(string.Format("ignored {0} trailing byte(s) from a zero byte after the last gzip stream, as s3cab does", data.Length - pos));
                    break;
                }
                if (members == 0) throw new DamagedException("not a gzip file (no gzip magic bytes)");
                throw new DamagedException(string.Format("{0} byte(s) after the last gzip stream are not another gzip stream", data.Length - pos));
            }
            if (members == 0) throw new DamagedException("empty file, not gzip");
            if (members > 1) notes.Add(string.Format("{0} gzip streams, decompressed in turn and joined", members));
            return outp.ToArray();
        }

        static int Member(byte[] d, int pos, MemoryStream outp)
        {
            if (pos + 10 > d.Length) throw new DamagedException("gzip header cut short");
            if (d[pos + 2] != 8) throw new DamagedException("gzip: unknown compression method " + d[pos + 2]);
            int flg = d[pos + 3];
            if ((flg & 0xE0) != 0) throw new DamagedException("gzip: reserved header flag set");
            pos += 10;
            if ((flg & 4) != 0)
            {
                if (pos + 2 > d.Length) throw new DamagedException("gzip header cut short");
                int xlen = d[pos] | (d[pos + 1] << 8);
                pos += 2 + xlen;
                if (pos > d.Length) throw new DamagedException("gzip header cut short");
            }
            if ((flg & 8) != 0) pos = SkipZeroTerminated(d, pos);
            if ((flg & 16) != 0) pos = SkipZeroTerminated(d, pos);
            if ((flg & 2) != 0)
            {
                pos += 2;
                if (pos > d.Length) throw new DamagedException("gzip header cut short");
            }
            var inf = new Inflater(d, pos, d.Length);
            byte[] text = inf.Run();
            pos = inf.Position;
            if (pos + 8 > d.Length) throw new DamagedException("gzip trailer cut short");
            uint crc = (uint)(d[pos] | (d[pos + 1] << 8) | (d[pos + 2] << 16) | (d[pos + 3] << 24));
            uint isize = (uint)(d[pos + 4] | (d[pos + 5] << 8) | (d[pos + 6] << 16) | (d[pos + 7] << 24));
            pos += 8;
            if (crc != Crc32.Compute(text, 0, text.Length)) throw new DamagedException("gzip CRC-32 check failed");
            if (isize != (uint)text.Length) throw new DamagedException("gzip length check failed");
            outp.Write(text, 0, text.Length);
            return pos;
        }

        static int SkipZeroTerminated(byte[] d, int pos)
        {
            for (; ; )
            {
                if (pos >= d.Length) throw new DamagedException("gzip header cut short");
                if (d[pos++] == 0) return pos;
            }
        }
    }

    // ------------------------------------------------------------------ S3 over plain HTTPS
    sealed class S3Client
    {
        readonly string bucket, region, akid, secret, token, host;
        readonly Random rnd = new Random();
        public bool Verbose;
        public int Requests;
        const string EmptyPayloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

        public S3Client(string bucket, string region, string akid, string secret, string token)
        {
            this.bucket = bucket; this.region = region; this.akid = akid; this.secret = secret; this.token = token;
            host = bucket + ".s3." + region + ".amazonaws.com";
        }

        public static string UriEncode(string s, bool keepSlash)
        {
            var sb = new StringBuilder();
            foreach (byte b in Encoding.UTF8.GetBytes(s))
            {
                char c = (char)b;
                if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~' || (keepSlash && c == '/'))
                    sb.Append(c);
                else
                    sb.Append('%').Append(((int)b).ToString("X2"));
            }
            return sb.ToString();
        }

        static string Hex(byte[] b)
        {
            var sb = new StringBuilder(b.Length * 2);
            foreach (byte x in b) sb.Append(x.ToString("x2"));
            return sb.ToString();
        }

        static byte[] Hmac(byte[] key, string data)
        {
            using (var h = new HMACSHA256(key)) return h.ComputeHash(Encoding.UTF8.GetBytes(data));
        }

        HttpWebRequest Build(string method, string key, List<KeyValuePair<string, string>> query)
        {
            string canonicalUri = "/" + UriEncode(key, true);
            var parts = new List<string>();
            if (query != null)
            {
                var enc = new List<KeyValuePair<string, string>>();
                foreach (var kv in query) enc.Add(new KeyValuePair<string, string>(UriEncode(kv.Key, false), UriEncode(kv.Value, false)));
                enc.Sort((a, b) =>
                {
                    int c = string.CompareOrdinal(a.Key, b.Key);
                    return c != 0 ? c : string.CompareOrdinal(a.Value, b.Value);
                });
                foreach (var kv in enc) parts.Add(kv.Key + "=" + kv.Value);
            }
            string canonicalQuery = string.Join("&", parts.ToArray());
            string url = "https://" + host + canonicalUri + (canonicalQuery.Length > 0 ? "?" + canonicalQuery : "");
            var uri = new Uri(url, UriKind.Absolute);
            // Guard: what .NET will send must be exactly what is signed.
            if (uri.AbsolutePath != canonicalUri || uri.Query != (canonicalQuery.Length > 0 ? "?" + canonicalQuery : ""))
                throw new StopException("internal: System.Uri rewrote the request URL, so the signature would not match: " + url);

            var req = (HttpWebRequest)WebRequest.Create(uri);
            req.Method = method;
            req.AllowAutoRedirect = false;
            req.AutomaticDecompression = DecompressionMethods.None;   // never honour Content-Encoding
            req.KeepAlive = true;
            req.Timeout = 30000;
            req.ReadWriteTimeout = 30000;
            req.UserAgent = "s3cab-restore/0.1 (clean-room, no SDK)";

            DateTime now = DateTime.UtcNow;
            string amzDate = now.ToString("yyyyMMdd'T'HHmmss'Z'", CultureInfo.InvariantCulture);
            string dateStamp = now.ToString("yyyyMMdd", CultureInfo.InvariantCulture);
            var headers = new SortedDictionary<string, string>(StringComparer.Ordinal);
            headers["host"] = host;
            headers["x-amz-content-sha256"] = EmptyPayloadHash;
            headers["x-amz-date"] = amzDate;
            if (!string.IsNullOrEmpty(token)) headers["x-amz-security-token"] = token;
            var ch = new StringBuilder();
            var sh = new List<string>();
            foreach (var kv in headers) { ch.Append(kv.Key).Append(':').Append(kv.Value).Append('\n'); sh.Add(kv.Key); }
            string signedHeaders = string.Join(";", sh.ToArray());
            string canonicalRequest = method + "\n" + canonicalUri + "\n" + canonicalQuery + "\n" + ch + "\n" + signedHeaders + "\n" + EmptyPayloadHash;
            string scope = dateStamp + "/" + region + "/s3/aws4_request";
            string stringToSign;
            using (var sha = SHA256.Create())
                stringToSign = "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + Hex(sha.ComputeHash(Encoding.UTF8.GetBytes(canonicalRequest)));
            byte[] kDate = Hmac(Encoding.UTF8.GetBytes("AWS4" + secret), dateStamp);
            byte[] kRegion = Hmac(kDate, region);
            byte[] kService = Hmac(kRegion, "s3");
            byte[] kSigning = Hmac(kService, "aws4_request");
            string signature = Hex(Hmac(kSigning, stringToSign));

            req.Headers["x-amz-date"] = amzDate;
            req.Headers["x-amz-content-sha256"] = EmptyPayloadHash;
            if (!string.IsNullOrEmpty(token)) req.Headers["x-amz-security-token"] = token;
            req.Headers["Authorization"] = "AWS4-HMAC-SHA256 Credential=" + akid + "/" + scope + ", SignedHeaders=" + signedHeaders + ", Signature=" + signature;
            return req;
        }

        public static bool IsDropped(WebExceptionStatus s)
        {
            switch (s)
            {
                case WebExceptionStatus.ConnectFailure:
                case WebExceptionStatus.NameResolutionFailure:
                case WebExceptionStatus.ProxyNameResolutionFailure:
                case WebExceptionStatus.ReceiveFailure:
                case WebExceptionStatus.SendFailure:
                case WebExceptionStatus.ConnectionClosed:
                case WebExceptionStatus.KeepAliveFailure:
                case WebExceptionStatus.PipelineFailure:
                case WebExceptionStatus.Timeout:
                    return true;
            }
            return false;
        }

        // Sends a request, retrying 5xx (three attempts in all) and dropped connections (for two
        // minutes). Returns the response whatever its status; the caller closes it.
        public HttpWebResponse Send(string method, string key, List<KeyValuePair<string, string>> query)
        {
            int attempt = 0;
            double ceiling5xx = 0.1, ceilingDrop = 0.5;
            DateTime firstDrop = DateTime.MinValue;
            for (; ; )
            {
                attempt++;
                HttpWebRequest req = Build(method, key, query);
                Requests++;
                try
                {
                    var resp = (HttpWebResponse)req.GetResponse();
                    Log(req, (int)resp.StatusCode);
                    return resp;
                }
                catch (WebException ex)
                {
                    var resp = ex.Response as HttpWebResponse;
                    if (ex.Status == WebExceptionStatus.ProtocolError && resp != null)
                    {
                        int code = (int)resp.StatusCode;
                        Log(req, code);
                        if (code >= 500 && code <= 599 && attempt < 3)
                        {
                            string s3code = ReadErrorCode(resp);
                            resp.Close();
                            if (s3code == "SlowDown" && ceiling5xx < 0.5) ceiling5xx = 0.5;
                            Sleep(ceiling5xx);
                            ceiling5xx = Math.Min(20, ceiling5xx * 2);
                            continue;
                        }
                        return resp;
                    }
                    Log(req, ex.Status.ToString());
                    if (IsDropped(ex.Status))
                    {
                        if (firstDrop == DateTime.MinValue) firstDrop = DateTime.UtcNow;
                        if ((DateTime.UtcNow - firstDrop).TotalSeconds < 120)
                        {
                            Sleep(ceilingDrop);
                            ceilingDrop = Math.Min(2, ceilingDrop * 2);
                            continue;
                        }
                    }
                    throw new StopException("request failed (" + ex.Status + "): " + method + " /" + key + ": " + ex.Message);
                }
            }
        }

        void Sleep(double ceiling)
        {
            System.Threading.Thread.Sleep((int)(rnd.NextDouble() * ceiling * 1000));
        }

        void Log(HttpWebRequest req, object status)
        {
            if (Verbose) Console.Error.WriteLine("  [s3] " + req.Method + " " + req.RequestUri.PathAndQuery + " -> " + status);
        }

        public static string ReadErrorCode(HttpWebResponse resp)
        {
            try
            {
                using (var sr = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                {
                    string body = sr.ReadToEnd();
                    var m = Regex.Match(body, "<Code>([^<]*)</Code>");
                    return m.Success ? m.Groups[1].Value : "";
                }
            }
            catch (Exception) { return ""; }
        }

        // Lists keys under a prefix. With delimiter, only keys directly there (not in folders below).
        public List<string> ListKeys(string prefix, bool delimiter)
        {
            var keys = new List<string>();
            string token = null;
            do
            {
                var q = new List<KeyValuePair<string, string>>();
                q.Add(new KeyValuePair<string, string>("list-type", "2"));
                q.Add(new KeyValuePair<string, string>("prefix", prefix));
                q.Add(new KeyValuePair<string, string>("max-keys", "1000"));
                q.Add(new KeyValuePair<string, string>("encoding-type", "url"));
                if (delimiter) q.Add(new KeyValuePair<string, string>("delimiter", "/"));
                if (token != null) q.Add(new KeyValuePair<string, string>("continuation-token", token));
                using (var resp = Send("GET", "", q))
                {
                    int status = (int)resp.StatusCode;
                    if (status != 200)
                        throw new StopException("listing '" + prefix + "' failed: HTTP " + status + " " + ReadErrorCode(resp));
                    var doc = new XmlDocument();
                    doc.XmlResolver = null;
                    doc.Load(resp.GetResponseStream());
                    token = null;
                    foreach (XmlNode contents in doc.GetElementsByTagName("Contents"))
                        foreach (XmlNode child in contents.ChildNodes)
                            if (child.Name == "Key") keys.Add(UrlDecode(child.InnerText));
                    var trunc = doc.GetElementsByTagName("IsTruncated");
                    if (trunc.Count > 0 && trunc[0].InnerText == "true")
                    {
                        var next = doc.GetElementsByTagName("NextContinuationToken");
                        if (next.Count > 0) token = next[0].InnerText;
                    }
                }
            } while (token != null);
            return keys;
        }

        static string UrlDecode(string s)
        {
            return Uri.UnescapeDataString(s.Replace('+', ' '));
        }

        // GETs a whole object into memory. Returns null when the key is missing (404 NoSuchKey/NotFound).
        public byte[] GetBytes(string key)
        {
            using (var resp = Send("GET", key, null))
            {
                int status = (int)resp.StatusCode;
                if (status == 200)
                {
                    using (var ms = new MemoryStream())
                    {
                        resp.GetResponseStream().CopyTo(ms);
                        return ms.ToArray();
                    }
                }
                string code = ReadErrorCode(resp);
                if (status == 404 && (code == "NoSuchKey" || code == "NotFound")) return null;
                throw new StopException("GET /" + key + " failed: HTTP " + status + " " + code);
            }
        }
    }

    // ------------------------------------------------------------------ the text of a snapshot or record
    sealed class Line
    {
        public int Number;
        public string Text;
        public string[] F = new string[5];   // leading four trimmed; the fifth verbatim
        public int Count;                    // fields present on the line (1..5)
        public bool Blank;
        public bool IsDot;

        public static Line Parse(int number, string text)
        {
            var l = new Line();
            l.Number = number;
            l.Text = text;
            l.Blank = Tsv.IsBlank(text);
            l.IsDot = text == ".";
            int p = 0, i = 0;
            while (i < 4)
            {
                int t = text.IndexOf('\t', p);
                if (t < 0) break;
                l.F[i++] = Tsv.Trim(text.Substring(p, t - p));
                p = t + 1;
            }
            if (i < 4)
            {
                l.F[i++] = Tsv.Trim(text.Substring(p));
                l.Count = i;
                while (i < 5) l.F[i++] = "";
            }
            else
            {
                l.F[4] = text.Substring(p);
                l.Count = 5;
            }
            return l;
        }
    }

    static class Tsv
    {
        // JavaScript's trim() set, as format.md lists it.
        public static bool IsTrim(char c)
        {
            if (c >= '\u0009' && c <= '\u000D') return true;
            if (c >= '\u2000' && c <= '\u200A') return true;
            switch (c)
            {
                case '\u0020': case '\u00A0': case '\u1680': case '\u202F': case '\u205F': case '\u3000':
                case '\u2028': case '\u2029': case '\uFEFF':
                    return true;
            }
            return false;
        }

        public static string Trim(string s)
        {
            int a = 0, b = s.Length;
            while (a < b && IsTrim(s[a])) a++;
            while (b > a && IsTrim(s[b - 1])) b--;
            return s.Substring(a, b - a);
        }

        public static bool IsBlank(string s)
        {
            foreach (char c in s) if (!IsTrim(c)) return false;
            return true;
        }

        // Strict UTF-8 (a leading BOM forgiven), split on LF alone. A non-blank tail with no LF is
        // a cut line: it is not returned as a line, and is reported through `problem`.
        public static List<Line> Lines(byte[] bytes, out string problem)
        {
            problem = null;
            int start = 0;
            if (bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF) start = 3;
            string text;
            try { text = new UTF8Encoding(false, true).GetString(bytes, start, bytes.Length - start); }
            catch (DecoderFallbackException e) { throw new DamagedException("not valid UTF-8: " + e.Message); }
            var lines = new List<Line>();
            int n = 0, p = 0;
            while (p < text.Length)
            {
                int nl = text.IndexOf('\n', p);
                if (nl < 0)
                {
                    if (!IsBlank(text.Substring(p))) problem = "the last line has no LF, so the file was cut there";
                    break;
                }
                lines.Add(Line.Parse(++n, text.Substring(p, nl - p)));
                p = nl + 1;
            }
            return lines;
        }

        public static bool IsHeading(Line l)
        {
            return l.Count == 5 && l.F[0] == "@S3CAB" && l.F[1] == "FORMAT" && l.F[2] == "size" && l.F[3] == "time"
                && l.F[4] == "https://s3cab.plantegral.com/guide/format";
        }

        static readonly Regex HashRe = new Regex("^[0-9a-f]{64}\\z");
        static readonly Regex SizeRe = new Regex("^[0-9]+\\z");
        public static bool IsHash(string s) { return HashRe.IsMatch(s); }
        public static bool IsSize(string s) { return SizeRe.IsMatch(s); }

        // The 24-character instant, checked by hand (DateTime can't hold year 0000). Returns
        // milliseconds since 1970-01-01T00:00:00Z, or null when it isn't a real instant.
        public static long? ParseInstant(string s)
        {
            if (s.Length != 24 || s[4] != '-' || s[7] != '-' || s[10] != 'T' || s[13] != ':' || s[16] != ':' || s[19] != '.' || s[23] != 'Z') return null;
            int[] idx = { 0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22 };
            foreach (int i in idx) if (s[i] < '0' || s[i] > '9') return null;
            int y = Num(s, 0, 4), mo = Num(s, 5, 2), d = Num(s, 8, 2), h = Num(s, 11, 2), mi = Num(s, 14, 2), se = Num(s, 17, 2), ms = Num(s, 20, 3);
            if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || se > 59) return null;
            int[] dim = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
            bool leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
            if (d > dim[mo - 1] + (mo == 2 && leap ? 1 : 0)) return null;
            long days = DaysFromCivil(y, mo, d);
            return ((days * 24 + h) * 60 + mi) * 60000L + se * 1000L + ms;
        }

        static int Num(string s, int at, int len)
        {
            int v = 0;
            for (int i = 0; i < len; i++) v = v * 10 + (s[at + i] - '0');
            return v;
        }

        // Proleptic Gregorian days since 1970-01-01 (works for year 0 and negative years).
        static long DaysFromCivil(long y, int m, int d)
        {
            y -= m <= 2 ? 1 : 0;
            long era = (y >= 0 ? y : y - 399) / 400;
            long yoe = y - era * 400;
            long doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
            long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
            return era * 146097 + doe - 719468;
        }
    }

    // ------------------------------------------------------------------ paths
    sealed class PathInfo
    {
        public bool IsWindows;
        public string Root;        // "C:\", "\\" or "/"
        public string RootKey;     // "drive:c", "share" or "posix" — for matching
        public string[] Segments = new string[0];
        public bool Absolute;
        public string Invalid;     // why this path can't be a file's path, or null

        static bool IsLetter(char c) { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'); }
        public static bool IsWinSep(char c) { return c == '\\' || c == '/'; }
        public bool IsSep(char c) { return IsWindows ? IsWinSep(c) : c == '/'; }

        // Classifies by the first characters alone, as format.md says. For a DIR, trailing
        // separators are ignored; for a file row they leave an empty segment, which is invalid.
        public static PathInfo Parse(string s, bool isDir)
        {
            var p = new PathInfo();
            string rest;
            if (s.Length >= 3 && IsLetter(s[0]) && s[1] == ':' && IsWinSep(s[2]))
            {
                p.IsWindows = true; p.Root = s.Substring(0, 3); p.RootKey = "drive:" + char.ToLowerInvariant(s[0]); rest = s.Substring(3);
            }
            else if (s.Length >= 2 && IsWinSep(s[0]) && IsWinSep(s[1]))
            {
                p.IsWindows = true; p.Root = s.Substring(0, 2); p.RootKey = "share"; rest = s.Substring(2);
            }
            else if (s.Length >= 1 && s[0] == '/')
            {
                p.IsWindows = false; p.Root = "/"; p.RootKey = "posix"; rest = s.Substring(1);
            }
            else
            {
                p.Invalid = "not an absolute path";
                return p;
            }
            p.Absolute = true;
            if (isDir)
            {
                int e = rest.Length;
                while (e > 0 && p.IsSep(rest[e - 1])) e--;
                rest = rest.Substring(0, e);
            }
            if (rest.Length > 0)
                p.Segments = p.IsWindows ? rest.Split('\\', '/') : rest.Split('/');
            foreach (string seg in p.Segments)
            {
                if (seg.Length == 0) { p.Invalid = "empty path segment (a doubled or trailing separator)"; break; }
                if (!isDir && (seg == "." || seg == "..")) { p.Invalid = "a '" + seg + "' segment"; break; }
            }
            return p;
        }

        // Case-insensitive on Windows paths by the lowercase mapping, exact elsewhere.
        public static bool SegmentsEqual(PathInfo kind, string a, string b)
        {
            return kind.IsWindows ? Unicode.JsToLower(a) == Unicode.JsToLower(b) : string.Equals(a, b, StringComparison.Ordinal);
        }
    }

    static class Unicode
    {
        // JavaScript's toLowerCase(): Unicode's full default case mapping, Final_Sigma included.
        // Windows 10 1903+ ships ICU as icu.dll, whose u_strToLower with the root locale is that
        // mapping exactly. Without it, .NET's ToLowerInvariant does the simple mappings and U+0130
        // and Final_Sigma are approximated below.
        [DllImport("icu.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        static extern int u_strToLower(char[] dest, int destCapacity, string src, int srcLength, [MarshalAs(UnmanagedType.LPStr)] string locale, ref int err);

        static bool icuTried, icuWorks;

        public static bool IcuAvailable
        {
            get
            {
                if (!icuTried)
                {
                    icuTried = true;
                    try { icuWorks = IcuLower("ΟΔΟΣ") == "οδος"; }
                    catch (Exception) { icuWorks = false; }
                }
                return icuWorks;
            }
        }

        static string IcuLower(string s)
        {
            var dest = new char[s.Length * 3 + 16];
            int err = 0;
            int n = u_strToLower(dest, dest.Length, s, s.Length, "", ref err);
            if (err > 0 || n > dest.Length) throw new InvalidOperationException("ICU error " + err);
            return new string(dest, 0, n);
        }

        public static string JsToLower(string s)
        {
            if (IcuAvailable)
            {
                try { return IcuLower(s); }
                catch (Exception) { }
            }
            var sb = new StringBuilder(s.Length);
            for (int i = 0; i < s.Length; i++)
            {
                char c = s[i];
                if (c == '\u0130') { sb.Append("i\u0307"); continue; }
                if (c == '\u03A3')
                {
                    sb.Append(IsFinalSigma(s, i) ? '\u03C2' : '\u03C3');
                    continue;
                }
                if (char.IsHighSurrogate(c) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]))
                {
                    sb.Append(s.Substring(i, 2).ToLowerInvariant());
                    i++;
                    continue;
                }
                sb.Append(char.ToLowerInvariant(c));
            }
            return sb.ToString();
        }

        static bool IsFinalSigma(string s, int i)
        {
            // Preceded by a cased letter (skipping case-ignorable characters) and not followed by one.
            bool before = false;
            for (int j = i - 1; j >= 0; j--)
            {
                char c = s[j];
                if (IsCaseIgnorable(c)) continue;
                before = IsCased(c);
                break;
            }
            if (!before) return false;
            for (int j = i + 1; j < s.Length; j++)
            {
                char c = s[j];
                if (IsCaseIgnorable(c)) continue;
                return !IsCased(c);
            }
            return true;
        }

        static bool IsCased(char c)
        {
            var cat = char.GetUnicodeCategory(c);
            return cat == UnicodeCategory.UppercaseLetter || cat == UnicodeCategory.LowercaseLetter || cat == UnicodeCategory.TitlecaseLetter;
        }

        static bool IsCaseIgnorable(char c)
        {
            switch (c)
            {
                case '\u0027': case '\u002E': case '\u003A': case '\u00B7': case '\u0387': case '\u05F4': case '\u2018': case '\u2019':
                case '\u2024': case '\u2027': case '\uFE13': case '\uFE52': case '\uFE55': case '\uFF07': case '\uFF0E': case '\uFF1A':
                    return true;
            }
            var cat = char.GetUnicodeCategory(c);
            return cat == UnicodeCategory.NonSpacingMark || cat == UnicodeCategory.EnclosingMark || cat == UnicodeCategory.Format
                || cat == UnicodeCategory.ModifierLetter || cat == UnicodeCategory.ModifierSymbol;
        }
    }

    // ------------------------------------------------------------------ the snapshot
    sealed class DirRow
    {
        public int Line;
        public string Text;
        public PathInfo Path;
        public string Name;        // the folder it restores into; null for POSIX "/"
        public string NameLower;
        public bool Reached;
        public bool Unusable;      // matches nothing (relative, doubled separator, ...)
    }

    sealed class FileRow
    {
        public int Line;
        public string Hash, SizeText, MtimeText, Path;
        public long MtimeMs;
        public PathInfo P;
        public string Refused;     // why this row is refused, or null
        public DirRow Dir;
        public string[] Rel;       // segments below the DIR
        public string RelPath;     // "<DIR name>\<rest>" with backslashes, for the destination
    }

    sealed class Snapshot
    {
        public List<DirRow> Dirs = new List<DirRow>();
        public List<FileRow> Files = new List<FileRow>();
        public List<string> Notes = new List<string>();
        public string StopReason;  // the whole restore is refused before anything is written
    }

    static class SnapshotReader
    {
        public static Snapshot Read(byte[] text)
        {
            string problem;
            List<Line> lines = Tsv.Lines(text, out problem);
            if (problem != null) throw new DamagedException(problem);
            if (lines.Count == 0 || !Tsv.IsHeading(lines[0]))
                throw new DamagedException("the first line is not the heading row");
            int dot = -1;
            var rows = new List<Line>();
            for (int i = 1; i < lines.Count; i++)
            {
                Line l = lines[i];
                if (l.Blank) continue;
                if (dot >= 0) throw new DamagedException("line " + l.Number + " comes after the `.` on line " + lines[dot].Number);
                if (l.IsDot) { dot = i; continue; }
                rows.Add(l);
            }
            if (dot < 0) throw new DamagedException("the file does not end with the `.` line, so it was cut short");

            var snap = new Snapshot();
            foreach (Line l in rows)
            {
                string type = l.F[0];
                if (type == "-")
                {
                    var f = new FileRow();
                    f.Line = l.Number; f.Hash = l.F[1]; f.SizeText = l.F[2]; f.MtimeText = l.F[3]; f.Path = l.Count == 5 ? l.F[4] : "";
                    snap.Files.Add(f);
                }
                else if (type.StartsWith("@", StringComparison.Ordinal))
                {
                    if (type == "@SET" && l.F[1] == "DIR")
                    {
                        if (l.Count < 5) { snap.Notes.Add("line " + l.Number + ": @SET DIR with no value, so no directory"); continue; }
                        AddDir(snap, l.Number, l.F[4]);
                    }
                }
                else if (type.StartsWith("#", StringComparison.Ordinal))
                {
                    // a path a restore doesn't act on
                }
                else
                    throw new DamagedException("line " + l.Number + ": unknown row type '" + type + "' (neither @ nor #), so the file may be from a newer format");
            }
            Validate(snap);
            return snap;
        }

        static void AddDir(Snapshot snap, int line, string text)
        {
            var d = new DirRow();
            d.Line = line; d.Text = text;
            d.Path = PathInfo.Parse(text, true);
            if (!d.Path.Absolute) { d.Unusable = true; snap.Notes.Add("line " + line + ": @SET DIR '" + text + "' is not an absolute path, so it matches nothing"); }
            else if (d.Path.Invalid != null) { d.Unusable = true; snap.Notes.Add("line " + line + ": @SET DIR '" + text + "' has " + d.Path.Invalid + ", so it matches nothing"); }
            else
            {
                // Two DIRs that match equally are one directory; the first in the file counts.
                foreach (DirRow e in snap.Dirs)
                    if (!e.Unusable && SameDir(e, d)) { snap.Notes.Add("line " + line + ": @SET DIR '" + text + "' repeats the DIR on line " + e.Line + "; the first counts"); return; }
                if (d.Path.Segments.Length > 0) d.Name = d.Path.Segments[d.Path.Segments.Length - 1];
                else if (d.Path.RootKey.StartsWith("drive:", StringComparison.Ordinal)) d.Name = d.Path.Root.Substring(0, 1);
                else if (d.Path.RootKey == "posix") d.Name = null;   // "/" has no folder of its own
                else { d.Unusable = true; snap.Notes.Add("line " + line + ": @SET DIR '" + text + "' is a bare share root with no name, so it matches nothing"); }
                if (d.Name != null) d.NameLower = Unicode.JsToLower(d.Name);
            }
            snap.Dirs.Add(d);
        }

        static bool SameDir(DirRow a, DirRow b)
        {
            if (a.Path.IsWindows != b.Path.IsWindows || a.Path.RootKey != b.Path.RootKey) return false;
            if (a.Path.Segments.Length != b.Path.Segments.Length) return false;
            for (int i = 0; i < a.Path.Segments.Length; i++)
                if (!PathInfo.SegmentsEqual(a.Path, a.Path.Segments[i], b.Path.Segments[i])) return false;
            return true;
        }

        static void Validate(Snapshot snap)
        {
            // 1. Each file row on its own.
            foreach (FileRow f in snap.Files)
            {
                var why = new List<string>();
                if (!Tsv.IsHash(f.Hash)) why.Add("hash is not 64 lowercase hex characters");
                if (!Tsv.IsSize(f.SizeText)) why.Add("size is not decimal digits");
                long? ms = Tsv.ParseInstant(f.MtimeText);
                if (ms == null) why.Add("time is not a real instant in the 24-character form");
                else f.MtimeMs = ms.Value;
                if (f.Path.Length == 0) why.Add("no path");
                else
                {
                    if (f.Path.IndexOf('\t') >= 0) why.Add("path holds a tab (a fifth tab on the line)");
                    if (f.Path.IndexOf('\r') >= 0 || f.Path.IndexOf('\n') >= 0) why.Add("path holds a CR or LF");
                    if (f.Path.IndexOf('\0') >= 0) why.Add("path holds a NUL");
                    f.P = PathInfo.Parse(f.Path, false);
                    if (!f.P.Absolute) why.Add("path is not absolute");
                    else if (f.P.Invalid != null) why.Add("path has " + f.P.Invalid);
                    else if (f.P.Segments.Length == 0) why.Add("path is a root, not a file");
                }
                if (why.Count > 0) f.Refused = "malformed row: " + string.Join("; ", why.ToArray());
            }

            // 2. One path in at most one file row, every file row taking part, compared exactly.
            var byPath = new Dictionary<string, List<FileRow>>(StringComparer.Ordinal);
            foreach (FileRow f in snap.Files)
            {
                List<FileRow> list;
                if (!byPath.TryGetValue(f.Path, out list)) byPath[f.Path] = list = new List<FileRow>();
                list.Add(f);
            }
            foreach (var kv in byPath)
                if (kv.Value.Count > 1)
                {
                    var ln = new List<string>();
                    foreach (FileRow f in kv.Value) ln.Add(f.Line.ToString());
                    string why = "the same path is in " + kv.Value.Count + " file rows (lines " + string.Join(", ", ln.ToArray()) + ")";
                    foreach (FileRow f in kv.Value) f.Refused = f.Refused == null ? why : f.Refused + "; " + why;
                }

            // 3. Under which DIR, by whole segments, the longest winning, the first of equals.
            foreach (FileRow f in snap.Files)
            {
                if (f.Refused != null) continue;
                DirRow best = null;
                bool isDir = false;
                foreach (DirRow d in snap.Dirs)
                {
                    if (d.Unusable) continue;
                    if (d.Path.IsWindows != f.P.IsWindows || d.Path.RootKey != f.P.RootKey) continue;
                    int n = d.Path.Segments.Length;
                    if (n > f.P.Segments.Length) continue;
                    bool match = true;
                    for (int i = 0; i < n && match; i++)
                        if (!PathInfo.SegmentsEqual(f.P, d.Path.Segments[i], f.P.Segments[i])) match = false;
                    if (!match) continue;
                    if (n == f.P.Segments.Length) { isDir = true; break; }
                    if (best == null || n > best.Path.Segments.Length) best = d;
                }
                if (isDir) { f.Refused = "the path is a @SET DIR itself"; continue; }
                if (best == null) { f.Refused = "the path is under no @SET DIR"; continue; }
                f.Dir = best;
                int skip = best.Path.Segments.Length;
                f.Rel = new string[f.P.Segments.Length - skip];
                Array.Copy(f.P.Segments, skip, f.Rel, 0, f.Rel.Length);
                // Names the destination (Windows) would misread rather than create.
                var names = new List<string>(f.Rel);
                if (best.Name != null) names.Insert(0, best.Name);
                foreach (string name in names)
                {
                    if (name.IndexOf('\\') >= 0 || name.IndexOf('/') >= 0) { f.Refused = "a name holds a '\\', which Windows would split into folders"; break; }
                    if (name.IndexOf(':') >= 0) { f.Refused = "a name holds a ':', which Windows would write as a stream of another file"; break; }
                    if (name == "." || name == "..") { f.Refused = "a name is '" + name + "'"; break; }
                }
                if (f.Refused != null) continue;
                f.RelPath = string.Join("\\", names.ToArray());
            }

            // 4. No surviving path running through another's as a folder, compared exactly.
            var survivors = new Dictionary<string, FileRow>(StringComparer.Ordinal);
            foreach (FileRow f in snap.Files) if (f.Refused == null) survivors[f.Path] = f;
            var through = new List<FileRow>();
            foreach (FileRow f in snap.Files)
            {
                if (f.Refused != null) continue;
                for (int i = f.P.Root.Length + 1; i < f.Path.Length; i++)
                {
                    if (!f.P.IsSep(f.Path[i])) continue;
                    FileRow other;
                    if (survivors.TryGetValue(f.Path.Substring(0, i), out other))
                    {
                        through.Add(f);
                        through.Add(other);
                        snap.Notes.Add("line " + f.Line + " runs through the path of line " + other.Line + " as a folder; both refused");
                    }
                }
            }
            foreach (FileRow f in through) if (f.Refused == null) f.Refused = "its path runs through, or is run through by, another file row's path";

            // 5. Which DIRs the restore reaches, and whether their folders would merge.
            foreach (FileRow f in snap.Files) if (f.Refused == null) f.Dir.Reached = true;
            var byName = new Dictionary<string, DirRow>(StringComparer.Ordinal);
            DirRow slash = null;
            int reached = 0;
            foreach (DirRow d in snap.Dirs)
            {
                if (!d.Reached) continue;
                reached++;
                if (d.Name == null) { slash = d; continue; }
                DirRow other;
                if (byName.TryGetValue(d.NameLower, out other))
                    snap.StopReason = "@SET DIR '" + other.Text + "' (line " + other.Line + ") and '" + d.Text + "' (line " + d.Line + ") both restore into a folder named '" + d.Name + "'; refusing rather than merging them";
                else byName[d.NameLower] = d;
            }
            if (slash != null && reached > 1 && snap.StopReason == null)
                snap.StopReason = "@SET DIR '/' (line " + slash.Line + ") restores straight into the output directory beside another DIR's folder; refusing rather than mixing them";
        }
    }

    // ------------------------------------------------------------------ deletion records
    sealed class Deleted { public string When; public string Who; public string Record; }

    sealed class DeletionRecords
    {
        readonly Dictionary<string, Deleted> byHash = new Dictionary<string, Deleted>(StringComparer.Ordinal);
        static readonly Regex KeyRe = new Regex("^objects\\.deleted-([1-9][0-9]*)\\.tsv\\z");

        public static DeletionRecords Load(S3Client s3, Action<string> log)
        {
            var r = new DeletionRecords();
            List<string> keys = s3.ListKeys("objects.deleted-", true);
            int files = 0;
            foreach (string key in keys)
            {
                if (!KeyRe.IsMatch(key)) continue;
                files++;
                byte[] bytes = s3.GetBytes(key);
                if (bytes == null) { log("deletion record " + key + " vanished between the listing and the fetch (compacted?)"); continue; }
                r.Parse(key, bytes, log);
            }
            log(string.Format("read {0} deletion record(s) listing {1} hash(es)", files, r.byHash.Count));
            return r;
        }

        public void Parse(string key, byte[] bytes, Action<string> log)
        {
            var invalid = new List<string>();
            List<Line> lines;
            string problem;
            try { lines = Tsv.Lines(bytes, out problem); }
            catch (DamagedException e) { log("deletion record " + key + " is distrusted: " + e.Message + "; none of its rows count"); return; }
            if (problem != null) invalid.Add(problem);
            if (lines.Count == 0 || !Tsv.IsHeading(lines[0])) invalid.Add("no heading row");
            int dot = -1, counted = 0;
            for (int i = lines.Count == 0 ? 0 : (Tsv.IsHeading(lines[0]) ? 1 : 0); i < lines.Count; i++)
            {
                Line l = lines[i];
                if (l.Blank) continue;
                if (dot >= 0) { invalid.Add("rows after the `.`"); }
                if (l.IsDot) { dot = i; continue; }
                string type = l.F[0];
                if (type == "#deleted")
                {
                    if (Tsv.IsHash(l.F[1]) && Tsv.IsSize(l.F[2]) && Tsv.ParseInstant(l.F[3]) != null)
                    {
                        Deleted d;
                        if (!byHash.TryGetValue(l.F[1], out d) || string.CompareOrdinal(l.F[3], d.When) > 0)
                            byHash[l.F[1]] = new Deleted { When = l.F[3], Who = l.Count == 5 ? l.F[4] : "", Record = key };
                        counted++;
                    }
                    else invalid.Add("malformed #deleted row on line " + l.Number);
                }
                else if (type.StartsWith("@", StringComparison.Ordinal) || type.StartsWith("#", StringComparison.Ordinal)) { }
                else invalid.Add("row type '" + type + "' on line " + l.Number);
            }
            if (dot < 0) invalid.Add("no `.` line");
            if (invalid.Count > 0)
                log("deletion record " + key + " is invalid (" + string.Join("; ", invalid.ToArray()) + ") and distrusted; its " + counted + " well-formed row(s) still count");
        }

        public Deleted Lookup(string hash)
        {
            Deleted d;
            return byHash.TryGetValue(hash, out d) ? d : null;
        }
    }

    // ------------------------------------------------------------------ the restore itself
    sealed class Restorer
    {
        readonly S3Client s3;
        readonly string outRoot;     // \\?\-prefixed, no trailing separator
        readonly HashSet<string> madeDirs = new HashSet<string>(StringComparer.Ordinal);
        readonly HashSet<string> writtenIds = new HashSet<string>(StringComparer.Ordinal);
        DeletionRecords records;
        public int Restored, Skipped, DeletedCount, Damaged, Refused, Collided, InTheWay, TimeRounded, TimeNotKept, Failed;
        const long EpochTicks = 621355968000000000L;   // 1970-01-01 in DateTime ticks
        const long NtfsMinTicks = 504911232000000000L; // 1601-01-01

        public Restorer(S3Client s3, string outputDir)
        {
            this.s3 = s3;
            string full = Path.GetFullPath(outputDir);
            full = full.TrimEnd('\\', '/');
            if (full.StartsWith("\\\\", StringComparison.Ordinal)) outRoot = "\\\\?\\UNC\\" + full.Substring(2);
            else outRoot = "\\\\?\\" + full;
        }

        public string OutputRoot { get { return outRoot; } }

        public int Run(Snapshot snap)
        {
            foreach (FileRow f in snap.Files)
            {
                if (f.Refused != null)
                {
                    Refused++;
                    Console.WriteLine("REFUSED   line {0}: {1}: {2}", f.Line, f.Refused, f.Path);
                    continue;
                }
                try { RestoreOne(f); }
                catch (InTheWayException e)
                {
                    InTheWay++;
                    Console.WriteLine("IN THE WAY {0}: {1}", f.RelPath, e.Message);
                }
                catch (IOException e)
                {
                    Failed++;
                    Console.WriteLine("FAILED    {0}: {1}", f.RelPath, e.Message);
                }
                catch (UnauthorizedAccessException e)
                {
                    Failed++;
                    Console.WriteLine("FAILED    {0}: {1}", f.RelPath, e.Message);
                }
            }
            return (Damaged + Refused + Collided + InTheWay + TimeNotKept + Failed) == 0 ? 0 : 1;
        }

        void RestoreOne(FileRow f)
        {
            string dest = outRoot + "\\" + f.RelPath;
            if (Directory.Exists(dest)) throw new InTheWayException("a folder is already there");
            if (File.Exists(dest))
            {
                string id = FileId(dest);
                if (writtenIds.Contains(id))
                {
                    Collided++;
                    Console.WriteLine("COLLISION {0}: line {1} lands on a file this restore already wrote: {2}", f.RelPath, f.Line, f.Path);
                }
                else
                {
                    Skipped++;
                    Console.WriteLine("skipped   {0}: already there before the restore", f.RelPath);
                }
                return;
            }

            string key = "objects/" + f.Hash;
            DateTime firstDrop = DateTime.MinValue;
            double ceilingDrop = 0.5;
            for (; ; )
            {
                HttpWebResponse resp = s3.Send("GET", key, null);
                int status = (int)resp.StatusCode;
                if (status != 200)
                {
                    string code = S3Client.ReadErrorCode(resp);
                    resp.Close();
                    if (status == 404 && (code == "NoSuchKey" || code == "NotFound")) { Missing(f); return; }
                    throw new StopException("GET /" + key + " failed: HTTP " + status + " " + code + " (not a missing object; stopping the whole restore)");
                }
                List<string> created = MakeFolders(dest);
                string temp = dest + ".s3cab-restore-" + Guid.NewGuid().ToString("N") + ".tmp";
                FileStream fs;
                try { fs = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1 << 16); }
                catch (Exception e)
                {
                    // A name the destination won't create (NTFS refuses " * < > ? | and control
                    // characters), or no permission: reported, and the rest restore.
                    resp.Close();
                    RemoveFolders(created);
                    if (!(e is IOException || e is UnauthorizedAccessException || e is ArgumentException || e is NotSupportedException)) throw;
                    Failed++;
                    Console.WriteLine("FAILED    {0}: the destination won't create it: {1}", f.RelPath, e.Message.Trim());
                    return;
                }
                string hex = null;
                Exception netError = null;
                using (resp)
                using (fs)
                using (var sha = SHA256.Create())
                {
                    try
                    {
                        using (Stream body = resp.GetResponseStream())
                        {
                            body.ReadTimeout = 30000;
                            var buf = new byte[1 << 16];
                            for (; ; )
                            {
                                int n;
                                try { n = body.Read(buf, 0, buf.Length); }
                                catch (IOException e) { netError = e; break; }
                                catch (WebException e) { netError = e; break; }
                                if (n <= 0) break;
                                sha.TransformBlock(buf, 0, n, null, 0);
                                fs.Write(buf, 0, n);
                            }
                            if (netError == null)
                            {
                                sha.TransformFinalBlock(buf, 0, 0);
                                hex = BitConverter.ToString(sha.Hash).Replace("-", "").ToLowerInvariant();
                            }
                        }
                    }
                    catch (IOException e)
                    {
                        // writing the download to disk failed (disk full, ...)
                        fs.Close();
                        TryDelete(temp);
                        RemoveFolders(created);
                        Failed++;
                        Console.WriteLine("FAILED    {0}: could not write the download: {1}", f.RelPath, e.Message);
                        return;
                    }
                }
                if (netError != null)
                {
                    TryDelete(temp);
                    RemoveFolders(created);
                    var we = netError as WebException;
                    bool dropped = netError is IOException || (we != null && S3Client.IsDropped(we.Status));
                    if (dropped)
                    {
                        if (firstDrop == DateTime.MinValue) firstDrop = DateTime.UtcNow;
                        if ((DateTime.UtcNow - firstDrop).TotalSeconds < 120)
                        {
                            Console.Error.WriteLine("  retrying {0} after a dropped connection: {1}", key, netError.Message);
                            System.Threading.Thread.Sleep((int)(new Random().NextDouble() * ceilingDrop * 1000));
                            ceilingDrop = Math.Min(2, ceilingDrop * 2);
                            continue;
                        }
                    }
                    throw new StopException("downloading " + key + " failed: " + netError.Message);
                }

                if (hex != f.Hash)
                {
                    TryDelete(temp);
                    RemoveFolders(created);
                    Damaged++;
                    Console.WriteLine("DAMAGED   {0}: the download hashes to {1}, not to its key {2}; withheld", f.RelPath, hex, f.Hash);
                    return;
                }
                try { File.Move(temp, dest); }
                catch (IOException e)
                {
                    TryDelete(temp);
                    RemoveFolders(created);
                    throw new InTheWayException("could not move the download into place: " + e.Message);
                }
                writtenIds.Add(FileId(dest));
                Restored++;
                Console.WriteLine("restored  {0}", f.RelPath);
                SetTime(dest, f);
                return;
            }
        }

        void Missing(FileRow f)
        {
            if (records == null)
            {
                try { records = DeletionRecords.Load(s3, delegate(string m) { Console.WriteLine("  note: " + m); }); }
                catch (StopException e)
                {
                    Console.WriteLine("  note: the deletion records could not be read (" + e.Message + "), so every missing object counts as damage");
                    records = new DeletionRecords();
                }
            }
            Deleted d = records.Lookup(f.Hash);
            if (d != null)
            {
                DeletedCount++;
                Console.WriteLine("deleted   {0}: deliberately deleted {1} by {2} ({3}); skipped", f.RelPath, d.When, d.Who, d.Record);
            }
            else
            {
                Damaged++;
                Console.WriteLine("DAMAGED   {0}: objects/{1} is missing and no deletion record explains it", f.RelPath, f.Hash);
            }
        }

        List<string> MakeFolders(string dest)
        {
            var created = new List<string>();
            string rel = dest.Substring(outRoot.Length + 1);
            string[] parts = rel.Split('\\');
            string cur = outRoot;
            for (int i = -1; i < parts.Length - 1; i++)
            {
                if (i >= 0) cur = cur + "\\" + parts[i];
                if (madeDirs.Contains(cur)) continue;
                if (Directory.Exists(cur))
                {
                    if (i >= 0 && (File.GetAttributes(cur) & FileAttributes.ReparsePoint) != 0)
                        throw new InTheWayException("'" + cur.Substring(outRoot.Length + 1) + "' is a link this restore didn't make, and could lead outside the destination");
                    continue;
                }
                if (File.Exists(cur)) throw new InTheWayException("a file is where the folder '" + cur.Substring(Math.Min(cur.Length, outRoot.Length + 1)) + "' should be");
                try { Directory.CreateDirectory(cur); }
                catch (Exception e) { RemoveFolders(created); throw new InTheWayException("could not create folder '" + cur.Substring(Math.Min(cur.Length, outRoot.Length + 1)) + "': " + e.Message); }
                madeDirs.Add(cur);
                created.Add(cur);
            }
            return created;
        }

        void RemoveFolders(List<string> created)
        {
            for (int i = created.Count - 1; i >= 0; i--)
            {
                try { Directory.Delete(created[i]); madeDirs.Remove(created[i]); }
                catch (Exception) { }
            }
        }

        static void TryDelete(string path)
        {
            try { if (File.Exists(path)) File.Delete(path); } catch (Exception) { }
        }

        void SetTime(string dest, FileRow f)
        {
            long ticks = EpochTicks + f.MtimeMs * 10000L;
            if (ticks <= NtfsMinTicks)
            {
                TimeNotKept++;
                Console.WriteLine("TIME NOT KEPT {0}: NTFS can't hold {1}; left at the time of the restore", f.RelPath, f.MtimeText);
                return;
            }
            var dt = new DateTime(ticks, DateTimeKind.Utc);
            try
            {
                File.SetLastWriteTimeUtc(dest, dt);
                File.SetLastAccessTimeUtc(dest, dt);
            }
            catch (ArgumentOutOfRangeException)
            {
                TimeNotKept++;
                Console.WriteLine("TIME NOT KEPT {0}: the destination refused {1}", f.RelPath, f.MtimeText);
                return;
            }
            long backTicks = File.GetLastWriteTimeUtc(dest).Ticks - EpochTicks;
            long backMs = (long)Math.Floor((backTicks + 5000) / 10000.0);
            long diff = Math.Abs(backMs - f.MtimeMs);
            if (diff == 0) return;
            if (diff < 2000)
            {
                TimeRounded++;
                return;
            }
            TimeNotKept++;
            Console.WriteLine("TIME NOT KEPT {0}: wanted {1}, the destination kept {2:yyyy-MM-dd'T'HH:mm:ss.fff'Z'}", f.RelPath, f.MtimeText, File.GetLastWriteTimeUtc(dest));
        }

        // Volume serial and file index: the identity of a file, under any spelling of its path.
        [StructLayout(LayoutKind.Sequential)]
        struct ByHandleFileInformation
        {
            public uint FileAttributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime, LastAccessTime, LastWriteTime;
            public uint VolumeSerialNumber, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetFileInformationByHandle(SafeFileHandle handle, out ByHandleFileInformation info);

        static string FileId(string path)
        {
            using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                ByHandleFileInformation info;
                if (!GetFileInformationByHandle(fs.SafeFileHandle, out info))
                    throw new IOException("GetFileInformationByHandle failed for " + path);
                return info.VolumeSerialNumber.ToString("x8") + ":" + info.FileIndexHigh.ToString("x8") + info.FileIndexLow.ToString("x8");
            }
        }
    }

    // ------------------------------------------------------------------ main
    static class Program
    {
        static readonly Regex SetRe = new Regex("^[a-z0-9-]+\\z");
        static readonly Regex CanonicalSetRe = new Regex("^[a-z0-9]+(-[a-z0-9]+)*\\z");
        static readonly Regex SnapshotNameRe = new Regex("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{4}\\z");

        static int Main(string[] args)
        {
            AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
            AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
            Console.OutputEncoding = new UTF8Encoding(false);
            ServicePointManager.SecurityProtocol = (SecurityProtocolType)(0xC00 | 0x3000);   // TLS 1.2 and 1.3

            var positional = new List<string>();
            bool verbose = false;
            string saveSnapshot = null;
            string snapshotFile = null;   // testing aid: read the snapshot from disk, objects still from the bucket
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--verbose" || args[i] == "-v") verbose = true;
                else if (args[i] == "--save-snapshot" && i + 1 < args.Length) saveSnapshot = args[++i];
                else if (args[i] == "--snapshot-file" && i + 1 < args.Length) snapshotFile = args[++i];
                else if (args[i].StartsWith("--", StringComparison.Ordinal)) { Console.Error.WriteLine("unknown option " + args[i]); return 2; }
                else positional.Add(args[i]);
            }
            if (positional.Count < 3 || positional.Count > 4)
            {
                Console.Error.WriteLine("usage: s3cab-restore.exe <bucket> <set> <dir> [<snapshot>] [--verbose] [--save-snapshot <file>]");
                return 2;
            }
            string bucket = positional[0], set = positional[1], dir = positional[2];
            string snapshotName = positional.Count == 4 ? positional[3] : null;

            string akid = Environment.GetEnvironmentVariable("AWS_ACCESS_KEY_ID");
            string secret = Environment.GetEnvironmentVariable("AWS_SECRET_ACCESS_KEY");
            string token = Environment.GetEnvironmentVariable("AWS_SESSION_TOKEN");
            string region = Environment.GetEnvironmentVariable("AWS_REGION");
            if (string.IsNullOrEmpty(region)) region = Environment.GetEnvironmentVariable("AWS_DEFAULT_REGION");
            if (string.IsNullOrEmpty(akid) || string.IsNullOrEmpty(secret) || string.IsNullOrEmpty(region))
            {
                Console.Error.WriteLine("AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_REGION must be set (AWS_SESSION_TOKEN too for session credentials)");
                return 2;
            }
            if (!SetRe.IsMatch(set))
            {
                Console.Error.WriteLine("'" + set + "' is not a set name: a to z, digits and hyphens only");
                return 2;
            }
            if (!CanonicalSetRe.IsMatch(set))
                Console.WriteLine("note: '" + set + "' is not a name s3cab would give a set (single hyphens between letters and digits), but a folder of that name is listed as one");
            if (snapshotName != null)
            {
                if (snapshotName.EndsWith(".tsv.gz", StringComparison.Ordinal)) snapshotName = snapshotName.Substring(0, snapshotName.Length - 7);
                if (!SnapshotNameRe.IsMatch(snapshotName))
                {
                    Console.Error.WriteLine("'" + snapshotName + "' is not a snapshot name (YYYY-MM-DDTHHMM)");
                    return 2;
                }
            }

            var s3 = new S3Client(bucket, region, akid, secret, token);
            s3.Verbose = verbose;
            try
            {
                string prefix = "snapshots/" + set + "/";
                if (snapshotFile != null && snapshotName == null) snapshotName = "(local file)";
                if (snapshotName == null)
                {
                    var names = new List<string>();
                    foreach (string key in s3.ListKeys(prefix, true))
                    {
                        string name = key.Substring(prefix.Length);
                        if (name.EndsWith(".tsv.gz", StringComparison.Ordinal) && SnapshotNameRe.IsMatch(name.Substring(0, name.Length - 7)))
                            names.Add(name.Substring(0, name.Length - 7));
                    }
                    if (names.Count == 0)
                    {
                        Console.Error.WriteLine("set '" + set + "' has no snapshot in s3://" + bucket + "/" + prefix);
                        return 1;
                    }
                    names.Sort(StringComparer.Ordinal);
                    snapshotName = names[names.Count - 1];
                    Console.WriteLine("latest of {0} snapshot(s): {1}", names.Count, snapshotName);
                }
                string snapshotKey = prefix + snapshotName + ".tsv.gz";
                byte[] gz;
                if (snapshotFile != null)
                {
                    Console.WriteLine("snapshot  {0} (local file; objects from s3://{1})", snapshotFile, bucket);
                    gz = File.ReadAllBytes(snapshotFile);
                }
                else
                {
                    Console.WriteLine("snapshot  s3://{0}/{1}", bucket, snapshotKey);
                    gz = s3.GetBytes(snapshotKey);
                }
                if (gz == null)
                {
                    Console.Error.WriteLine("no such snapshot: s3://" + bucket + "/" + snapshotKey);
                    return 1;
                }
                if (saveSnapshot != null)
                {
                    string saveDir = Path.GetDirectoryName(Path.GetFullPath(saveSnapshot));
                    if (!string.IsNullOrEmpty(saveDir)) Directory.CreateDirectory(saveDir);
                    File.WriteAllBytes(saveSnapshot, gz);
                }

                Snapshot snap;
                try
                {
                    var notes = new List<string>();
                    byte[] text = Gzip.Decompress(gz, notes);
                    foreach (string n in notes) Console.WriteLine("  note: " + n);
                    snap = SnapshotReader.Read(text);
                }
                catch (DamagedException e)
                {
                    Console.WriteLine("REFUSED snapshot {0}: {1}. Nothing restored: it may be cut short, so restoring its rows could pass for a full restore.", snapshotName, e.Message);
                    return 1;
                }
                foreach (string n in snap.Notes) Console.WriteLine("  note: " + n);
                Console.WriteLine("rows      {0} file row(s), {1} @SET DIR row(s)", snap.Files.Count, snap.Dirs.Count);
                if (snap.StopReason != null)
                {
                    Console.WriteLine("REFUSED restore: " + snap.StopReason);
                    return 1;
                }

                var r = new Restorer(s3, dir);
                Console.WriteLine("output    {0}", r.OutputRoot);
                int exit = r.Run(snap);
                Console.WriteLine("summary   restored {0}, skipped {1} (already there), deleted {2} (deliberately), damaged {3}, refused {4}, collided {5}, in the way {6}, failed {7}, time rounded {8}, time not kept {9}; {10} S3 request(s)",
                    r.Restored, r.Skipped, r.DeletedCount, r.Damaged, r.Refused, r.Collided, r.InTheWay, r.Failed, r.TimeRounded, r.TimeNotKept, s3.Requests);
                Console.WriteLine(exit == 0 ? "result    complete" : "result    INCOMPLETE (exit 1)");
                return exit;
            }
            catch (StopException e)
            {
                Console.WriteLine("STOPPED   " + e.Message);
                return 1;
            }
        }
    }
}
