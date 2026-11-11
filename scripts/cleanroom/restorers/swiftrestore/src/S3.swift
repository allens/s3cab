import Foundation

enum S3Error: Error, CustomStringConvertible {
    case transport(String)
    case http(status: Int, code: String, message: String)
    case setup(String)
    var description: String {
        switch self {
        case .transport(let s): return "transport failure: \(s)"
        case .http(let st, let c, let m): return "HTTP \(st) \(c): \(m)"
        case .setup(let s): return s
        }
    }
}

protocol BodySink: AnyObject {
    func begin() throws              // start (or restart) of an attempt
    func write(_ p: UnsafeRawBufferPointer) -> Bool
}

final class MemorySink: BodySink {
    var data = Bytes()
    func begin() { data.removeAll(keepingCapacity: true) }
    func write(_ p: UnsafeRawBufferPointer) -> Bool { data.append(contentsOf: p); return true }
}

final class CurlContext {
    let handle: UnsafeMutableRawPointer
    var sink: BodySink?
    var status: Int = 0
    var errorBody = Bytes()
    var sinkFailed = false
    init(handle: UnsafeMutableRawPointer) { self.handle = handle }
    func reset(sink: BodySink?) { self.sink = sink; status = 0; errorBody.removeAll(); sinkFailed = false }
}

let curlWriteCallback: curl_write_callback = { ptr, size, nmemb, userdata in
    let n = size * nmemb
    guard let ud = userdata, let ptr = ptr else { return 0 }
    let ctx = Unmanaged<CurlContext>.fromOpaque(ud).takeUnretainedValue()
    if ctx.status == 0 { var code = 0; _ = s3cab_getinfo_long(ctx.handle, CURLINFO_RESPONSE_CODE, &code); ctx.status = code }
    let buf = UnsafeRawBufferPointer(start: ptr, count: n)
    if ctx.status >= 200 && ctx.status < 300, let sink = ctx.sink {
        if !sink.write(buf) { ctx.sinkFailed = true; return 0 }
    } else {
        ctx.errorBody.append(contentsOf: buf)
    }
    return n
}

// Minimal XML reader: every (element path, text) pair, for S3's small XML bodies.
final class XMLCollector: NSObject, XMLParserDelegate {
    var stack: [String] = []
    var text = ""
    var items: [(path: String, text: String)] = []
    func parser(_ p: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String]) {
        stack.append(name); text = ""
    }
    func parser(_ p: XMLParser, foundCharacters s: String) { text += s }
    func parser(_ p: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
        items.append((stack.joined(separator: "/"), text)); text = ""; stack.removeLast()
    }
    static func parse(_ data: Bytes) -> [(path: String, text: String)] {
        let c = XMLCollector()
        let p = XMLParser(data: Data(data)); p.delegate = c; p.shouldProcessNamespaces = false
        _ = p.parse()
        return c.items
    }
}

enum FetchOutcome { case ok; case miss(code: String) }

final class S3Client {
    let bucket: String, region: String, accessKey: String, secretKey: String, token: String?
    let host: String
    let handle: UnsafeMutableRawPointer
    let ctx: CurlContext
    var requests = 0
    static let emptySHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

    init(bucket: String, region: String, accessKey: String, secretKey: String, token: String?) throws {
        self.bucket = bucket; self.region = region; self.accessKey = accessKey; self.secretKey = secretKey; self.token = token
        host = "\(bucket).s3.\(region).amazonaws.com"
        // Select the LibreSSL backend before any other libcurl call (see ENVIRONMENT.md).
        let ss = curl_global_sslset(CURLSSLBACKEND_OPENSSL, nil, nil)
        guard ss == CURLSSLSET_OK else { throw S3Error.setup("curl_global_sslset failed: \(ss.rawValue)") }
        curl_global_init(Int(CURL_GLOBAL_ALL))
        guard let h = curl_easy_init() else { throw S3Error.setup("curl_easy_init failed") }
        handle = h
        ctx = CurlContext(handle: h)
        _ = s3cab_setopt_wcb(h, CURLOPT_WRITEFUNCTION, curlWriteCallback)
        _ = s3cab_setopt_ptr(h, CURLOPT_WRITEDATA, Unmanaged.passUnretained(ctx).toOpaque())
        _ = s3cab_setopt_long(h, CURLOPT_HTTP_CONTENT_DECODING, 0)   // never let libcurl decode a body
        _ = s3cab_setopt_long(h, CURLOPT_CONNECTTIMEOUT, 10)
        _ = s3cab_setopt_long(h, CURLOPT_LOW_SPEED_LIMIT, 1)
        _ = s3cab_setopt_long(h, CURLOPT_LOW_SPEED_TIME, 30)
        _ = s3cab_setopt_long(h, CURLOPT_NOSIGNAL, 1)
        _ = s3cab_setopt_long(h, CURLOPT_FOLLOWLOCATION, 0)
        _ = s3cab_setopt_str(h, CURLOPT_CAINFO, "/etc/ssl/cert.pem")
    }

    // --- SigV4 ---
    static func uriEncode(_ s: String, encodeSlash: Bool) -> String {
        var out = ""
        for b in s.utf8 {
            let c = UInt8(b)
            let unreserved = (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39)
                || c == 0x2D || c == 0x5F || c == 0x2E || c == 0x7E
            if unreserved || (c == 0x2F && !encodeSlash) { out.unicodeScalars.append(Unicode.Scalar(c)) }
            else { out += String(format: "%%%02X", c) }
        }
        return out
    }

    private func signedHeaders(method: String, key: String, query: [(String, String)]) -> (url: String, headers: [String]) {
        var t = time(nil); var tm = tm(); gmtime_r(&t, &tm)
        let amzDate = String(format: "%04d%02d%02dT%02d%02d%02dZ", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec)
        let dateStamp = String(amzDate.prefix(8))
        let canonicalURI = "/" + S3Client.uriEncode(key, encodeSlash: false)
        var encodedQuery: [(String, String)] = []
        for (k, v) in query { encodedQuery.append((S3Client.uriEncode(k, encodeSlash: true), S3Client.uriEncode(v, encodeSlash: true))) }
        encodedQuery.sort { (a: (String, String), b: (String, String)) -> Bool in a.0 == b.0 ? a.1 < b.1 : a.0 < b.0 }
        var queryParts: [String] = []
        for (k, v) in encodedQuery { queryParts.append(k + "=" + v) }
        let canonicalQuery = queryParts.joined(separator: "&")
        var headers: [(String, String)] = [
            ("host", host), ("x-amz-content-sha256", S3Client.emptySHA), ("x-amz-date", amzDate)]
        if let token = token { headers.append(("x-amz-security-token", token)) }
        headers.sort { $0.0 < $1.0 }
        let canonicalHeaders = headers.map { "\($0.0):\($0.1)\n" }.joined()
        let signedList = headers.map { $0.0 }.joined(separator: ";")
        let canonicalRequest = "\(method)\n\(canonicalURI)\n\(canonicalQuery)\n\(canonicalHeaders)\n\(signedList)\n\(S3Client.emptySHA)"
        let scope = "\(dateStamp)/\(region)/s3/aws4_request"
        let stringToSign = "AWS4-HMAC-SHA256\n\(amzDate)\n\(scope)\n\(hexEncode(sha256(bytes(canonicalRequest))))"
        let kDate = hmacSHA256(key: bytes("AWS4" + secretKey), data: bytes(dateStamp))
        let kRegion = hmacSHA256(key: kDate, data: bytes(region))
        let kService = hmacSHA256(key: kRegion, data: bytes("s3"))
        let kSigning = hmacSHA256(key: kService, data: bytes("aws4_request"))
        let signature = hexEncode(hmacSHA256(key: kSigning, data: bytes(stringToSign)))
        let auth = "AWS4-HMAC-SHA256 Credential=\(accessKey)/\(scope), SignedHeaders=\(signedList), Signature=\(signature)"
        let url = "https://\(host)\(canonicalURI)" + (canonicalQuery.isEmpty ? "" : "?\(canonicalQuery)")
        var lines = headers.map { "\($0.0): \($0.1)" }
        lines.append("Authorization: \(auth)")
        return (url, lines)
    }

    private struct Attempt { let curlCode: CURLcode; let status: Int; let errorBody: Bytes }

    private func attempt(key: String, query: [(String, String)], sink: BodySink) throws -> Attempt {
        let (url, headerLines) = signedHeaders(method: "GET", key: key, query: query)
        var list: UnsafeMutablePointer<curl_slist>? = nil
        for l in headerLines { list = curl_slist_append(list, l) }
        list = curl_slist_append(list, "Accept:")             // no default Accept, and no Accept-Encoding ever
        defer { curl_slist_free_all(list) }
        _ = s3cab_setopt_str(handle, CURLOPT_URL, url)
        _ = s3cab_setopt_slist(handle, CURLOPT_HTTPHEADER, list)
        _ = s3cab_setopt_long(handle, CURLOPT_HTTPGET, 1)
        try sink.begin()
        ctx.reset(sink: sink)
        requests += 1
        let rc = curl_easy_perform(handle)
        var status = 0
        _ = s3cab_getinfo_long(handle, CURLINFO_RESPONSE_CODE, &status)
        if ctx.sinkFailed { throw S3Error.setup("writing the downloaded bytes failed: \(errnoText())") }
        return Attempt(curlCode: rc, status: status, errorBody: ctx.errorBody)
    }

    private static let droppedConnection: Set<UInt32> = [
        CURLE_COULDNT_RESOLVE_HOST.rawValue, CURLE_COULDNT_RESOLVE_PROXY.rawValue, CURLE_COULDNT_CONNECT.rawValue,
        CURLE_OPERATION_TIMEDOUT.rawValue, CURLE_SEND_ERROR.rawValue, CURLE_RECV_ERROR.rawValue,
        CURLE_PARTIAL_FILE.rawValue, CURLE_GOT_NOTHING.rawValue, CURLE_SSL_CONNECT_ERROR.rawValue,
        CURLE_HTTP2.rawValue, CURLE_HTTP2_STREAM.rawValue]

    private func sleepRandom(ceiling: Double) {
        let s = Double.random(in: 0...ceiling)
        usleep(UInt32(s * 1_000_000))
    }

    // GET with the spec's retry policy. `.miss` is a 404 NoSuchKey / NotFound; any other failure throws.
    func get(key: String, query: [(String, String)] = [], sink: BodySink) throws -> FetchOutcome {
        let connectDeadline = Date().addingTimeInterval(120)
        var connectCeiling = 0.5
        var serverAttempts = 0
        var serverCeiling = 0.1
        while true {
            let a = try attempt(key: key, query: query, sink: sink)
            if a.curlCode != CURLE_OK {
                let msg = String(cString: curl_easy_strerror(a.curlCode))
                if S3Client.droppedConnection.contains(a.curlCode.rawValue), Date() < connectDeadline {
                    fputs("retrying after a dropped connection (\(msg))\n", stderr)
                    sleepRandom(ceiling: connectCeiling); connectCeiling = min(2, connectCeiling * 2); continue
                }
                throw S3Error.transport(msg)
            }
            if a.status >= 200 && a.status < 300 { return .ok }
            var code = "", message = ""
            for it in XMLCollector.parse(a.errorBody) {
                if it.path == "Error/Code" { code = it.text } else if it.path == "Error/Message" { message = it.text }
            }
            if a.status >= 500 {
                serverAttempts += 1
                if serverAttempts < 3 {
                    if a.status == 503 { serverCeiling = max(serverCeiling, 0.5) }
                    fputs("retrying after HTTP \(a.status) \(code)\n", stderr)
                    sleepRandom(ceiling: serverCeiling); serverCeiling = min(20, serverCeiling * 2); continue
                }
            }
            if a.status == 404, code == "NoSuchKey" || code == "NotFound" { return .miss(code: code) }
            throw S3Error.http(status: a.status, code: code, message: message)
        }
    }

    // ListObjectsV2 with a delimiter: the keys directly under `prefix` (and the common prefixes below it).
    func list(prefix: String, delimiter: String = "/") throws -> (keys: [String], prefixes: [String]) {
        var keys: [String] = [], prefixes: [String] = []
        var token: String? = nil
        repeat {
            var q = [("list-type", "2"), ("prefix", prefix), ("delimiter", delimiter)]
            if let t = token { q.append(("continuation-token", t)) }
            let sink = MemorySink()
            switch try get(key: "", query: q, sink: sink) {
            case .miss(let c): throw S3Error.http(status: 404, code: c, message: "listing \(prefix)")
            case .ok: break
            }
            var truncated = false; token = nil
            for it in XMLCollector.parse(sink.data) {
                switch it.path {
                case "ListBucketResult/Contents/Key": keys.append(it.text)
                case "ListBucketResult/CommonPrefixes/Prefix": prefixes.append(it.text)
                case "ListBucketResult/IsTruncated": truncated = (it.text == "true")
                case "ListBucketResult/NextContinuationToken": token = it.text
                default: break
                }
            }
            if !truncated { token = nil }
        } while token != nil
        return (keys, prefixes)
    }
}
