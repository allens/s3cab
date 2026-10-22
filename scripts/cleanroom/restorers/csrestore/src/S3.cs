// Minimal S3 reader: GET and ListObjectsV2 over plain HTTPS, signed with AWS Signature V4.
// No SDK. Written from what I knew of SigV4, not from any AWS library.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Xml;

class S3Exception : Exception
{
    public readonly int Status; // HTTP status, or 0 when no response arrived
    public S3Exception(int status, string message) : base(message) { Status = status; }
}

class S3Listing
{
    public List<string> Keys = new List<string>();
    public List<string> Prefixes = new List<string>();
}

class S3Client
{
    const string EmptySha256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    readonly string bucket, region, accessKey, secretKey, sessionToken;
    readonly string host, pathPrefix;
    readonly Random random = new Random();

    public TextWriter Log = Console.Error;

    public S3Client(string bucket, string region, string accessKey, string secretKey, string sessionToken)
    {
        this.bucket = bucket;
        this.region = region;
        this.accessKey = accessKey;
        this.secretKey = secretKey;
        this.sessionToken = sessionToken;
        // Virtual-hosted style unless the name can't be a DNS label inside a TLS wildcard.
        if (bucket.IndexOf('.') < 0)
        {
            host = bucket + ".s3." + region + ".amazonaws.com";
            pathPrefix = "/";
        }
        else
        {
            host = "s3." + region + ".amazonaws.com";
            pathPrefix = "/" + UriEncode(bucket, true) + "/";
        }
    }

    // ---- signing -------------------------------------------------------------------------

    static string UriEncode(string s, bool encodeSlash)
    {
        var sb = new StringBuilder();
        foreach (byte b in Encoding.UTF8.GetBytes(s))
        {
            char c = (char)b;
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
                c == '-' || c == '_' || c == '.' || c == '~')
                sb.Append(c);
            else if (c == '/' && !encodeSlash)
                sb.Append(c);
            else
                sb.Append('%').Append(((int)b).ToString("X2", CultureInfo.InvariantCulture));
        }
        return sb.ToString();
    }

    static string Hex(byte[] bytes)
    {
        var sb = new StringBuilder(bytes.Length * 2);
        foreach (byte b in bytes) sb.Append(b.ToString("x2", CultureInfo.InvariantCulture));
        return sb.ToString();
    }

    static byte[] Hmac(byte[] key, string data)
    {
        using (var h = new HMACSHA256(key)) return h.ComputeHash(Encoding.UTF8.GetBytes(data));
    }

    static string Sha256Hex(string data)
    {
        using (var h = SHA256.Create()) return Hex(h.ComputeHash(Encoding.UTF8.GetBytes(data)));
    }

    HttpWebRequest BuildRequest(string key, SortedDictionary<string, string> query)
    {
        DateTime now = DateTime.UtcNow;
        string amzDate = now.ToString("yyyyMMdd'T'HHmmss'Z'", CultureInfo.InvariantCulture);
        string day = now.ToString("yyyyMMdd", CultureInfo.InvariantCulture);

        string canonicalUri = pathPrefix + UriEncode(key, false);
        var q = new StringBuilder();
        if (query != null)
        {
            // Sorted by encoded name; all names used here are plain ASCII so ordinal order holds.
            foreach (var kv in query)
            {
                if (q.Length > 0) q.Append('&');
                q.Append(UriEncode(kv.Key, true)).Append('=').Append(UriEncode(kv.Value, true));
            }
        }
        string canonicalQuery = q.ToString();

        var headers = new SortedDictionary<string, string>(StringComparer.Ordinal);
        headers["host"] = host;
        headers["x-amz-content-sha256"] = EmptySha256;
        headers["x-amz-date"] = amzDate;
        if (!string.IsNullOrEmpty(sessionToken)) headers["x-amz-security-token"] = sessionToken;

        var canonicalHeaders = new StringBuilder();
        var signedHeaders = new StringBuilder();
        foreach (var kv in headers)
        {
            canonicalHeaders.Append(kv.Key).Append(':').Append(kv.Value.Trim()).Append('\n');
            if (signedHeaders.Length > 0) signedHeaders.Append(';');
            signedHeaders.Append(kv.Key);
        }

        string canonicalRequest = "GET\n" + canonicalUri + "\n" + canonicalQuery + "\n" +
            canonicalHeaders + "\n" + signedHeaders + "\n" + EmptySha256;
        string scope = day + "/" + region + "/s3/aws4_request";
        string stringToSign = "AWS4-HMAC-SHA256\n" + amzDate + "\n" + scope + "\n" + Sha256Hex(canonicalRequest);

        byte[] k = Hmac(Encoding.UTF8.GetBytes("AWS4" + secretKey), day);
        k = Hmac(k, region);
        k = Hmac(k, "s3");
        k = Hmac(k, "aws4_request");
        string signature;
        using (var h = new HMACSHA256(k)) signature = Hex(h.ComputeHash(Encoding.UTF8.GetBytes(stringToSign)));

        string url = "https://" + host + canonicalUri + (canonicalQuery.Length > 0 ? "?" + canonicalQuery : "");
        var req = (HttpWebRequest)WebRequest.Create(new Uri(url));
        req.Method = "GET";
        req.AutomaticDecompression = DecompressionMethods.None; // a stored file is bytes, never decoded
        req.AllowAutoRedirect = false;
        req.Timeout = 60000;
        req.ReadWriteTimeout = 120000;
        req.Headers["x-amz-date"] = amzDate;
        req.Headers["x-amz-content-sha256"] = EmptySha256;
        if (!string.IsNullOrEmpty(sessionToken)) req.Headers["x-amz-security-token"] = sessionToken;
        req.Headers["Authorization"] = "AWS4-HMAC-SHA256 Credential=" + accessKey + "/" + scope +
            ", SignedHeaders=" + signedHeaders + ", Signature=" + signature;
        return req;
    }

    // ---- transport with retry ------------------------------------------------------------

    static bool IsDroppedConnection(WebExceptionStatus s)
    {
        switch (s)
        {
            case WebExceptionStatus.ConnectFailure:
            case WebExceptionStatus.ConnectionClosed:
            case WebExceptionStatus.KeepAliveFailure:
            case WebExceptionStatus.ReceiveFailure:
            case WebExceptionStatus.SendFailure:
            case WebExceptionStatus.PipelineFailure:
            case WebExceptionStatus.Timeout:
            case WebExceptionStatus.NameResolutionFailure:
                return true;
        }
        return false;
    }

    static string ReadErrorBody(HttpWebResponse resp)
    {
        try
        {
            using (var s = resp.GetResponseStream())
            using (var r = new StreamReader(s, Encoding.UTF8))
            {
                string body = r.ReadToEnd();
                return body.Length > 600 ? body.Substring(0, 600) : body;
            }
        }
        catch (Exception) { return ""; }
    }

    // Performs a GET and hands the open response body to `consume`. Returns false on 404.
    // A dropped connection (including one that drops mid-body) is retried for two minutes from
    // the first failure; a 5xx up to three attempts in all; anything else throws.
    public bool Get(string key, SortedDictionary<string, string> query, Action<HttpWebResponse, Stream> consume)
    {
        string what = key.Length > 0 ? key : "listing" + (query != null && query.ContainsKey("prefix") ? " of " + query["prefix"] : "");
        return Get(key, query, consume, what);
    }

    bool Get(string key, SortedDictionary<string, string> query, Action<HttpWebResponse, Stream> consume, string what)
    {
        key = key ?? "";
        DateTime? firstDrop = null;
        int serverErrors = 0;
        int ceilingMs = 500;
        while (true)
        {
            HttpWebResponse resp = null;
            try
            {
                var req = BuildRequest(key, query);
                try
                {
                    resp = (HttpWebResponse)req.GetResponse();
                }
                catch (WebException we)
                {
                    resp = we.Response as HttpWebResponse;
                    if (resp == null) throw;
                }
                int status = (int)resp.StatusCode;
                if (status == 404) { resp.Close(); return false; }
                if (status >= 500)
                {
                    string body = ReadErrorBody(resp);
                    resp.Close();
                    serverErrors++;
                    if (serverErrors >= 3)
                        throw new S3Exception(status, "GET " + what + ": HTTP " + status + " after 3 attempts: " + body);
                    Log.WriteLine("  retrying " + what + " after HTTP " + status);
                    Sleep(ref ceilingMs);
                    continue;
                }
                if (status != 200)
                {
                    string body = ReadErrorBody(resp);
                    resp.Close();
                    throw new S3Exception(status, "GET " + what + ": HTTP " + status + ": " + body);
                }
                using (resp)
                using (var stream = resp.GetResponseStream())
                    consume(resp, stream);
                return true;
            }
            catch (WebException we)
            {
                if (resp != null) resp.Close();
                if (!IsDroppedConnection(we.Status) && !(we.InnerException is IOException))
                    throw new S3Exception(0, "GET " + what + ": " + we.Status + ": " + we.Message);
                if (firstDrop == null) firstDrop = DateTime.UtcNow;
                if ((DateTime.UtcNow - firstDrop.Value).TotalSeconds > 120)
                    throw new S3Exception(0, "GET " + what + ": connection kept failing for two minutes: " + we.Message);
                Log.WriteLine("  retrying " + what + " after " + we.Status);
                Sleep(ref ceilingMs);
            }
            catch (IOException ioe)
            {
                // The body stream broke part-way: the consumer must be restartable.
                if (resp != null) resp.Close();
                if (firstDrop == null) firstDrop = DateTime.UtcNow;
                if ((DateTime.UtcNow - firstDrop.Value).TotalSeconds > 120)
                    throw new S3Exception(0, "GET " + what + ": connection kept failing for two minutes: " + ioe.Message);
                Log.WriteLine("  retrying " + what + " after " + ioe.Message);
                Sleep(ref ceilingMs);
            }
        }
    }

    void Sleep(ref int ceilingMs)
    {
        int ms;
        lock (random) ms = random.Next(ceilingMs);
        Thread.Sleep(ms);
        ceilingMs = Math.Min(ceilingMs * 2, 20000);
    }

    // ---- ListObjectsV2 -------------------------------------------------------------------

    // S3 percent-encodes names in the listing when asked (encoding-type=url), which is the only
    // way a key holding a character XML 1.0 can't carry comes back intact.
    static string UrlDecodeKey(string s)
    {
        var bytes = new List<byte>();
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            if (c == '%' && i + 2 < s.Length)
            {
                bytes.Add(byte.Parse(s.Substring(i + 1, 2), NumberStyles.HexNumber, CultureInfo.InvariantCulture));
                i += 2;
            }
            else if (c == '+') bytes.Add((byte)' ');
            else foreach (byte b in Encoding.UTF8.GetBytes(c.ToString())) bytes.Add(b);
        }
        return new UTF8Encoding(false, true).GetString(bytes.ToArray());
    }

    public S3Listing List(string prefix, string delimiter)
    {
        var result = new S3Listing();
        string token = null;
        while (true)
        {
            var query = new SortedDictionary<string, string>(StringComparer.Ordinal);
            query["list-type"] = "2";
            query["encoding-type"] = "url";
            if (!string.IsNullOrEmpty(prefix)) query["prefix"] = prefix;
            if (!string.IsNullOrEmpty(delimiter)) query["delimiter"] = delimiter;
            if (token != null) query["continuation-token"] = token;
            var doc = new XmlDocument();
            Get("", query, delegate(HttpWebResponse resp, Stream body)
            {
                var ms = new MemoryStream();
                body.CopyTo(ms);
                ms.Position = 0;
                doc = new XmlDocument();
                doc.Load(ms);
            });
            var ns = new XmlNamespaceManager(doc.NameTable);
            ns.AddNamespace("s", "http://s3.amazonaws.com/doc/2006-03-01/");
            foreach (XmlNode n in doc.SelectNodes("/s:ListBucketResult/s:Contents/s:Key", ns))
                result.Keys.Add(UrlDecodeKey(n.InnerText));
            foreach (XmlNode n in doc.SelectNodes("/s:ListBucketResult/s:CommonPrefixes/s:Prefix", ns))
                result.Prefixes.Add(UrlDecodeKey(n.InnerText));
            var trunc = doc.SelectSingleNode("/s:ListBucketResult/s:IsTruncated", ns);
            var next = doc.SelectSingleNode("/s:ListBucketResult/s:NextContinuationToken", ns);
            if (trunc != null && trunc.InnerText == "true" && next != null) token = next.InnerText;
            else break;
        }
        return result;
    }
}
