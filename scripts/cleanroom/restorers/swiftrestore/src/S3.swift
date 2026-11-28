import Foundation

// S3 over plain HTTPS: libcurl carries the request, and the signing (AWS Signature Version 4)
// is done here with CommonCrypto. No AWS SDK and no S3 client library.

struct Credentials {
    let accessKey: String
    let secretKey: String
    let sessionToken: String?
}

// MARK: Signature Version 4

/// RFC 3986 unreserved characters stay; everything else becomes %XX, upper-case hex.
func uriEncode(_ s: String, keepSlash: Bool) -> String {
    let hex = Array("0123456789ABCDEF".utf8)
    var o = [UInt8]()
    for b in s.utf8 {
        let unreserved = (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) || (b >= 0x30 && b <= 0x39)
            || b == 0x2D || b == 0x2E || b == 0x5F || b == 0x7E
        if unreserved || (keepSlash && b == 0x2F) {
            o.append(b)
        } else {
            o.append(0x25)
            o.append(hex[Int(b >> 4)])
            o.append(hex[Int(b & 15)])
        }
    }
    return String(decoding: o, as: UTF8.self)
}

private let emptyPayloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

/// The headers to send with a bodiless request, `Authorization` included (`Host` is left to
/// the HTTP client, which derives the same value from the URL).
func sigV4Headers(method: String, host: String, canonicalURI: String, canonicalQuery: String,
                  region: String, creds: Credentials, at now: time_t) -> [(String, String)] {
    var t = now
    var g = tm()
    gmtime_r(&t, &g)
    func two(_ v: Int32) -> String { v < 10 ? "0\(v)" : "\(v)" }
    let date = "\(g.tm_year + 1900)" + two(g.tm_mon + 1) + two(g.tm_mday)
    let amzDate = date + "T" + two(g.tm_hour) + two(g.tm_min) + two(g.tm_sec) + "Z"

    var headers: [(String, String)] = [
        ("host", host),
        ("x-amz-content-sha256", emptyPayloadHash),
        ("x-amz-date", amzDate),
    ]
    if let token = creds.sessionToken { headers.append(("x-amz-security-token", token)) }
    headers.sort { $0.0 < $1.0 }

    let canonicalHeaders = headers.map { "\($0.0):\($0.1)\n" }.joined()
    let signedHeaders = headers.map { $0.0 }.joined(separator: ";")
    let canonicalRequest = [method, canonicalURI, canonicalQuery, canonicalHeaders, signedHeaders, emptyPayloadHash]
        .joined(separator: "\n")

    let scope = "\(date)/\(region)/s3/aws4_request"
    let stringToSign = "AWS4-HMAC-SHA256\n\(amzDate)\n\(scope)\n" + hexString(sha256(Array(canonicalRequest.utf8)))

    var key = hmacSHA256(key: Array("AWS4\(creds.secretKey)".utf8), Array(date.utf8))
    key = hmacSHA256(key: key, Array(region.utf8))
    key = hmacSHA256(key: key, Array("s3".utf8))
    key = hmacSHA256(key: key, Array("aws4_request".utf8))
    let signature = hexString(hmacSHA256(key: key, Array(stringToSign.utf8)))

    let authorization = "AWS4-HMAC-SHA256 Credential=\(creds.accessKey)/\(scope), SignedHeaders=\(signedHeaders), Signature=\(signature)"
    return headers.filter { $0.0 != "host" } + [("Authorization", authorization)]
}

// MARK: XML, as far as S3's answers need it

private final class LeafCollector: NSObject, XMLParserDelegate {
    var stack = [String]()
    var text = ""
    var leaves = [(path: String, text: String)]()

    func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?,
                qualifiedName qName: String?, attributes attributeDict: [String: String] = [:]) {
        stack.append(elementName)
        text = ""
    }
    func parser(_ parser: XMLParser, foundCharacters string: String) {
        text += string
    }
    func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName qName: String?) {
        leaves.append((stack.joined(separator: "/"), text))
        stack.removeLast()
        text = ""
    }
}

/// Every element's path and text, in document order; nil when the body is not well-formed XML.
func xmlLeaves(_ body: [UInt8]) -> [(path: String, text: String)]? {
    let parser = XMLParser(data: Data(body))
    let collector = LeafCollector()
    parser.delegate = collector
    parser.shouldResolveExternalEntities = false
    return parser.parse() ? collector.leaves : nil
}

/// Undoes `encoding-type=url` on a listed key.
func percentDecoded(_ s: String) -> [UInt8] {
    let b = Array(s.utf8)
    func nibble(_ c: UInt8) -> UInt8? {
        switch c {
        case 0x30...0x39: return c - 0x30
        case 0x41...0x46: return c - 0x41 + 10
        case 0x61...0x66: return c - 0x61 + 10
        default: return nil
        }
    }
    var o = [UInt8]()
    var i = 0
    while i < b.count {
        if b[i] == 0x25, i + 2 < b.count, let h = nibble(b[i + 1]), let l = nibble(b[i + 2]) {
            o.append(h << 4 | l)
            i += 3
        } else {
            o.append(b[i] == 0x2B ? 0x20 : b[i])
            i += 1
        }
    }
    return o
}

// MARK: the HTTP transfer (libcurl)

/// Where a 200's body goes. `reset` is called before every attempt, so a retried request
/// starts from nothing.
protocol BodySink: AnyObject {
    func reset() -> Bool
    func write(_ bytes: UnsafeRawBufferPointer) -> Bool
}

final class MemorySink: BodySink {
    var bytes = [UInt8]()
    func reset() -> Bool {
        bytes.removeAll(keepingCapacity: true)
        return true
    }
    func write(_ b: UnsafeRawBufferPointer) -> Bool {
        bytes.append(contentsOf: b)
        return true
    }
}

private final class Transfer {
    let handle: UnsafeMutableRawPointer
    let sink: BodySink
    var headers = [String: String]()
    var otherBody = [UInt8]()       // the body of anything but a 200
    var sinkFailed = false

    init(handle: UnsafeMutableRawPointer, sink: BodySink) {
        self.handle = handle
        self.sink = sink
    }
}

private func onBody(_ ptr: UnsafeMutablePointer<CChar>?, _ size: Int, _ nmemb: Int, _ userdata: UnsafeMutableRawPointer?) -> Int {
    let t = Unmanaged<Transfer>.fromOpaque(userdata!).takeUnretainedValue()
    let n = size * nmemb
    var status = 0
    _ = s3r_getinfo_long(t.handle, CURLINFO_RESPONSE_CODE, &status)
    let bytes = UnsafeRawBufferPointer(start: ptr, count: n)
    if status == 200 {
        if !t.sink.write(bytes) {
            t.sinkFailed = true
            return 0        // makes libcurl stop with CURLE_WRITE_ERROR
        }
    } else if t.otherBody.count + n <= 1 << 20 {
        t.otherBody.append(contentsOf: bytes)
    }
    return n
}

private func onHeader(_ ptr: UnsafeMutablePointer<CChar>?, _ size: Int, _ nmemb: Int, _ userdata: UnsafeMutableRawPointer?) -> Int {
    let t = Unmanaged<Transfer>.fromOpaque(userdata!).takeUnretainedValue()
    let n = size * nmemb
    let line = Array(UnsafeRawBufferPointer(start: ptr, count: n))
    if line.starts(with: Array("HTTP/".utf8)) {
        t.headers.removeAll()       // a new response begins
    } else if let colon = line.firstIndex(of: 0x3A) {
        let name = String(decoding: line[0..<colon], as: UTF8.self).lowercased()
        let value = String(decoding: line[(colon + 1)...], as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        t.headers[name] = value
    }
    return n
}

struct HTTPResponse {
    let status: Int
    let headers: [String: String]
    /// The body, unless the status was 200: that one went to the sink.
    let body: [UInt8]

    /// S3's error code, when the body is its XML error document.
    var errorCode: String? {
        xmlLeaves(body)?.first(where: { $0.path == "Error/Code" })?.text
    }
}

final class S3Client {
    let bucket: String
    private(set) var region: String
    private let creds: Credentials
    private let handle: UnsafeMutableRawPointer
    private let pathStyle: Bool
    private(set) var requestsSent = 0

    init(bucket: String, region: String, creds: Credentials) throws {
        guard let h = curl_easy_init() else { throw Fatal("libcurl would not start") }
        self.handle = h
        self.bucket = bucket
        self.region = region
        self.creds = creds
        // A dot in the name breaks the wildcard certificate of <bucket>.s3.<region>.amazonaws.com.
        self.pathStyle = bucket.contains(".")
    }

    deinit {
        curl_easy_cleanup(handle)
    }

    /// One attempt. Signed afresh each time, since the signature carries the clock.
    private func attempt(key: String, query: [(String, String)], transfer: Transfer) -> CURLcode {
        let host = pathStyle ? "s3.\(region).amazonaws.com" : "\(bucket).s3.\(region).amazonaws.com"
        let path = pathStyle ? "/\(bucket)/\(key)" : "/\(key)"
        let canonicalURI = uriEncode(path, keepSlash: true)
        var pairs = [String]()
        for (name, value) in query {
            pairs.append(uriEncode(name, keepSlash: false) + "=" + uriEncode(value, keepSlash: false))
        }
        // Sorted by name, as bytes. No name here is a prefix of another, so sorting the whole
        // pair gives the same order.
        pairs.sort { $0.utf8.lexicographicallyPrecedes($1.utf8) }
        let canonicalQuery = pairs.joined(separator: "&")
        let headers = sigV4Headers(method: "GET", host: host, canonicalURI: canonicalURI, canonicalQuery: canonicalQuery,
                                   region: region, creds: creds, at: time(nil))
        var list: UnsafeMutablePointer<curl_slist>? = nil
        for (name, value) in headers { list = curl_slist_append(list, "\(name): \(value)") }
        defer { curl_slist_free_all(list) }

        let url = "https://\(host)\(canonicalURI)" + (canonicalQuery.isEmpty ? "" : "?\(canonicalQuery)")
        let me = Unmanaged.passUnretained(transfer).toOpaque()
        curl_easy_reset(handle)     // options only: the connection stays open for the next request
        _ = s3r_setopt_str(handle, CURLOPT_URL, url)
        _ = s3r_setopt_long(handle, CURLOPT_HTTPGET, 1)
        _ = s3r_setopt_slist(handle, CURLOPT_HTTPHEADER, list)
        _ = s3r_setopt_long(handle, CURLOPT_NOSIGNAL, 1)
        _ = s3r_setopt_long(handle, CURLOPT_FOLLOWLOCATION, 0)          // a redirect needs a new signature
        _ = s3r_setopt_long(handle, CURLOPT_HTTP_CONTENT_DECODING, 0)   // the stored bytes, never decoded
        _ = s3r_setopt_long(handle, CURLOPT_SUPPRESS_CONNECT_HEADERS, 1)
        _ = s3r_setopt_long(handle, CURLOPT_CONNECTTIMEOUT, 10)
        _ = s3r_setopt_long(handle, CURLOPT_LOW_SPEED_LIMIT, 1)         // 30 seconds without a byte
        _ = s3r_setopt_long(handle, CURLOPT_LOW_SPEED_TIME, 30)
        _ = s3r_setopt_cb(handle, CURLOPT_WRITEFUNCTION, onBody)
        _ = s3r_setopt_ptr(handle, CURLOPT_WRITEDATA, me)
        _ = s3r_setopt_cb(handle, CURLOPT_HEADERFUNCTION, onHeader)
        _ = s3r_setopt_ptr(handle, CURLOPT_HEADERDATA, me)
        requestsSent += 1
        return curl_easy_perform(handle)
    }

    private func isDroppedConnection(_ code: CURLcode) -> Bool {
        switch code {
        case CURLE_COULDNT_RESOLVE_PROXY, CURLE_COULDNT_RESOLVE_HOST, CURLE_COULDNT_CONNECT,
             CURLE_OPERATION_TIMEDOUT, CURLE_PARTIAL_FILE, CURLE_GOT_NOTHING, CURLE_SEND_ERROR,
             CURLE_RECV_ERROR, CURLE_SSL_CONNECT_ERROR, CURLE_HTTP2, CURLE_HTTP2_STREAM:
            return true
        default:
            return false
        }
    }

    /// A GET, retried on a dropped connection and on a 5xx, and followed to the bucket's own
    /// region on a 301. Throws when the request can't be completed; any status that comes back
    /// is the caller's to judge.
    func get(key: String, query: [(String, String)] = [], into sink: BodySink) throws -> HTTPResponse {
        var firstDrop: Double? = nil
        var dropCeiling = 0.5
        var serverErrors = 0
        var serverCeiling = 0.0
        var redirects = 0
        let what = key.isEmpty ? "listing" : key

        while true {
            guard sink.reset() else { throw Fatal("\(what): could not start the download over") }
            let transfer = Transfer(handle: handle, sink: sink)
            let code = attempt(key: key, query: query, transfer: transfer)

            if code != CURLE_OK {
                let why = String(cString: curl_easy_strerror(code))
                if transfer.sinkFailed { throw Fatal("\(what): writing the download failed") }
                var proxyAnswer = 0
                _ = s3r_getinfo_long(handle, CURLINFO_HTTP_CONNECTCODE, &proxyAnswer)
                if proxyAnswer >= 400 && proxyAnswer < 500 {
                    throw Fatal("\(what): the proxy refused the connection (\(proxyAnswer))")
                }
                if isDroppedConnection(code) {
                    let now = monotonicSeconds()
                    let since = firstDrop ?? now
                    firstDrop = since
                    if now - since < 120 {
                        sleepSeconds(Double.random(in: 0..<dropCeiling))
                        dropCeiling = min(dropCeiling * 2, 2)
                        continue
                    }
                }
                throw Fatal("\(what): the request failed: \(why) (libcurl \(code.rawValue))")
            }

            var status = 0
            _ = s3r_getinfo_long(handle, CURLINFO_RESPONSE_CODE, &status)
            let response = HTTPResponse(status: status, headers: transfer.headers, body: transfer.otherBody)

            if status >= 500 {
                serverErrors += 1
                if serverErrors < 3 {
                    if serverCeiling == 0 {
                        let throttled = status == 503 || ["SlowDown", "Throttling", "RequestLimitExceeded"].contains(response.errorCode ?? "")
                        serverCeiling = throttled ? 0.5 : 0.1
                    }
                    sleepSeconds(Double.random(in: 0..<serverCeiling))
                    serverCeiling = min(serverCeiling * 2, 20)
                    continue
                }
                throw Fatal("\(what): still failing after 3 attempts: HTTP \(status) \(response.errorCode ?? "")")
            }

            // The bucket lives in another region: S3 names it, and the request is signed again for it.
            if status == 301, redirects < 2, let there = response.headers["x-amz-bucket-region"], there != region,
               there.utf8.allSatisfy({ ($0 >= 0x61 && $0 <= 0x7A) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2D }) {
                redirects += 1
                complain("note: \(bucket) is in \(there), not \(region): following it there")
                region = there
                continue
            }
            return response
        }
    }

    private func describe(_ r: HTTPResponse) -> String {
        "HTTP \(r.status)" + (r.errorCode.map { " \($0)" } ?? "")
    }

    /// ListObjectsV2, every page. With a delimiter, `keys` are exactly the keys directly under
    /// the prefix and `prefixes` the folders below it.
    func list(prefix: String, delimiter: String?) throws -> (keys: [[UInt8]], prefixes: [[UInt8]]) {
        var keys = [[UInt8]]()
        var prefixes = [[UInt8]]()
        var token: String? = nil
        while true {
            var query = [("list-type", "2"), ("encoding-type", "url"), ("prefix", prefix)]
            if let delimiter { query.append(("delimiter", delimiter)) }
            if let token { query.append(("continuation-token", token)) }
            let sink = MemorySink()
            let r = try get(key: "", query: query, into: sink)
            guard r.status == 200 else { throw Fatal("listing `\(prefix)` in \(bucket) failed: \(describe(r))") }
            guard let leaves = xmlLeaves(sink.bytes) else { throw Fatal("listing `\(prefix)`: the answer is not XML") }
            var truncated = false
            var next: String? = nil
            for leaf in leaves {
                switch leaf.path {
                case "ListBucketResult/Contents/Key": keys.append(percentDecoded(leaf.text))
                case "ListBucketResult/CommonPrefixes/Prefix": prefixes.append(percentDecoded(leaf.text))
                case "ListBucketResult/IsTruncated": truncated = leaf.text == "true"
                case "ListBucketResult/NextContinuationToken": next = leaf.text
                default: break
                }
            }
            guard truncated else { break }
            guard let next, !next.isEmpty else { throw Fatal("listing `\(prefix)`: truncated, with no token to continue from") }
            token = next
        }
        return (keys, prefixes)
    }

    enum Fetched {
        case found
        case missing
    }

    /// One object. `.missing` is a 404 whose code is NoSuchKey or NotFound, or that has no code
    /// in a body that is empty or well-formed XML. Every other failure stops the restore.
    func fetch(key: String, into sink: BodySink) throws -> Fetched {
        let r = try get(key: key, into: sink)
        if r.status == 200 { return .found }
        if r.status == 404 {
            if r.body.isEmpty { return .missing }
            guard let leaves = xmlLeaves(r.body) else {
                throw Fatal("\(key): HTTP 404 with a body that is not XML, so it says nothing about the key")
            }
            let code = leaves.first(where: { $0.path == "Error/Code" })?.text
            if code == nil || code == "NoSuchKey" || code == "NotFound" { return .missing }
        }
        throw Fatal("\(key): \(describe(r))")
    }
}
