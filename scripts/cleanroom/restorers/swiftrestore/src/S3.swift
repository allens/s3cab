import Foundation
import CryptoKit

struct Credentials {
    let accessKey: String
    let secretKey: String
    let sessionToken: String?
    let region: String
}

struct HTTPResponse {
    let status: Int
    let body: Bytes
    let headers: String
    /// The <Code> of an S3 error body, if the body holds one.
    var s3ErrorCode: String? {
        let s = String(decoding: body, as: UTF8.self)
        guard let r = s.range(of: "<Code>"), let e = s.range(of: "</Code>", range: r.upperBound..<s.endIndex) else { return nil }
        return String(s[r.upperBound..<e.lowerBound])
    }
    var requestId: String {
        for raw in headers.utf8.split(separator: 0x0A) { let line = String(decoding: raw, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines); guard line.lowercased().hasPrefix("x-amz-request-id:") else { continue }
            return line.dropFirst("x-amz-request-id:".count).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return "?"
    }
    /// A short description of an error response for messages: status, code, request id, and the body's <Message>.
    var errorSummary: String {
        let s = String(decoding: body, as: UTF8.self)
        var msg = ""
        if let r = s.range(of: "<Message>"), let e = s.range(of: "</Message>", range: r.upperBound..<s.endIndex) { msg = String(s[r.upperBound..<e.lowerBound]) }
        return "HTTP \(status) \(s3ErrorCode ?? "(no S3 code)") (request id \(requestId))\(msg.isEmpty ? "" : ": \(msg)")"
    }
}

enum TransportError: Error, CustomStringConvertible {
    case curl(code: Int32, message: String)
    case gaveUp(String)
    case fatal(String)
    var description: String {
        switch self {
        case .curl(let c, let m): return "libcurl error \(c): \(m)"
        case .gaveUp(let m): return m
        case .fatal(let m): return m
        }
    }
}

final class ResponseSink {
    var body = Bytes()
    var headers = Bytes()
}

let bodyCallback: s3r_write_cb = { ptr, size, nmemb, userdata in
    let n = size * nmemb
    guard let ud = userdata, let p = ptr else { return 0 }
    let sink = Unmanaged<ResponseSink>.fromOpaque(ud).takeUnretainedValue()
    sink.body.append(contentsOf: UnsafeRawBufferPointer(start: p, count: n))
    return n
}
let headerCallback: s3r_write_cb = { ptr, size, nmemb, userdata in
    let n = size * nmemb
    guard let ud = userdata, let p = ptr else { return 0 }
    let sink = Unmanaged<ResponseSink>.fromOpaque(ud).takeUnretainedValue()
    sink.headers.append(contentsOf: UnsafeRawBufferPointer(start: p, count: n))
    return n
}

/// RFC 3986 encoding as SigV4 wants it: unreserved characters bare, everything else %XX, upper-case hex.
func uriEncode(_ s: String, encodeSlash: Bool) -> String {
    var out = ""
    for b in s.utf8 {
        if (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) || (b >= 0x30 && b <= 0x39) || b == 0x2D || b == 0x5F || b == 0x2E || b == 0x7E {
            out.unicodeScalars.append(Unicode.Scalar(b))
        } else if b == 0x2F && !encodeSlash {
            out.append("/")
        } else {
            out += String(format: "%%%02X", b)
        }
    }
    return out
}

func sha256Hex(_ data: Bytes) -> String {
    return hex(SHA256.hash(data: data))
}

func hmacSHA256(key: Bytes, data: String) -> Bytes {
    let mac = HMAC<SHA256>.authenticationCode(for: Array(data.utf8), using: SymmetricKey(data: key))
    return Array(mac)
}

let emptyPayloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

enum GetResult {
    case found(Bytes)
    case missing(code: String)
}

final class S3Client {
    let creds: Credentials
    let bucket: String
    let host: String
    let verbose: Bool
    var requestCount = 0

    init(creds: Credentials, bucket: String, verbose: Bool) {
        self.creds = creds
        self.bucket = bucket
        self.host = "\(bucket).s3.\(creds.region).amazonaws.com"
        self.verbose = verbose
        // Must come before any other libcurl call, so the LibreSSL backend (which reads /etc/ssl/cert.pem) is used.
        let rc = curl_global_sslset(CURLSSLBACKEND_OPENSSL, nil, nil)
        if rc != CURLSSLSET_OK { eprint("warning: curl_global_sslset returned \(rc.rawValue)") }
        _ = s3r_global_init()
    }

    // MARK: signing

    private func amzDate() -> (amz: String, stamp: String) {
        var t = time(nil)
        var tmv = tm()
        gmtime_r(&t, &tmv)
        let amz = String(format: "%04d%02d%02dT%02d%02d%02dZ", tmv.tm_year + 1900, tmv.tm_mon + 1, tmv.tm_mday, tmv.tm_hour, tmv.tm_min, tmv.tm_sec)
        return (amz, String(amz.prefix(8)))
    }

    /// Returns the signed headers for a GET of `/key?query` on this bucket's virtual-hosted host.
    private func signedHeaders(canonicalPath: String, canonicalQuery: String) -> [String] {
        let (amz, stamp) = amzDate()
        var headers: [(String, String)] = [
            ("host", host),
            ("x-amz-content-sha256", emptyPayloadHash),
            ("x-amz-date", amz),
        ]
        if let tok = creds.sessionToken, !tok.isEmpty { headers.append(("x-amz-security-token", tok)) }
        headers.sort { $0.0 < $1.0 }
        let canonicalHeaders = headers.map { "\($0.0):\($0.1)\n" }.joined()
        let signedList = headers.map { $0.0 }.joined(separator: ";")
        let canonicalRequest = ["GET", canonicalPath, canonicalQuery, canonicalHeaders, signedList, emptyPayloadHash].joined(separator: "\n")
        let scope = "\(stamp)/\(creds.region)/s3/aws4_request"
        let stringToSign = ["AWS4-HMAC-SHA256", amz, scope, sha256Hex(Array(canonicalRequest.utf8))].joined(separator: "\n")
        let kDate = hmacSHA256(key: Array(("AWS4" + creds.secretKey).utf8), data: stamp)
        let kRegion = hmacSHA256(key: kDate, data: creds.region)
        let kService = hmacSHA256(key: kRegion, data: "s3")
        let kSigning = hmacSHA256(key: kService, data: "aws4_request")
        let signature = hex(hmacSHA256(key: kSigning, data: stringToSign))
        let auth = "AWS4-HMAC-SHA256 Credential=\(creds.accessKey)/\(scope), SignedHeaders=\(signedList), Signature=\(signature)"
        var out = headers.filter { $0.0 != "host" }.map { "\($0.0): \($0.1)" }
        out.append("Authorization: \(auth)")
        return out
    }

    // MARK: transport

    private func performOnce(canonicalPath: String, query: [(String, String)]) throws -> HTTPResponse {
        let canonicalQuery = query
            .map { (uriEncode($0.0, encodeSlash: true), uriEncode($0.1, encodeSlash: true)) }
            .sorted { $0.0 < $1.0 }
            .map { "\($0.0)=\($0.1)" }
            .joined(separator: "&")
        let url = "https://\(host)\(canonicalPath)" + (canonicalQuery.isEmpty ? "" : "?" + canonicalQuery)
        let headers = signedHeaders(canonicalPath: canonicalPath, canonicalQuery: canonicalQuery)

        guard let h = curl_easy_init() else { throw TransportError.fatal("curl_easy_init failed") }
        defer { curl_easy_cleanup(h) }
        var list: UnsafeMutablePointer<curl_slist>? = nil
        for hdr in headers { list = curl_slist_append(list, hdr) }
        defer { curl_slist_free_all(list) }
        let sink = ResponseSink()
        let sinkPtr = Unmanaged.passUnretained(sink).toOpaque()
        _ = s3r_setopt_str(h, CURLOPT_URL, url)
        _ = s3r_setopt_slist(h, CURLOPT_HTTPHEADER, list)
        _ = s3r_setopt_writecb(h, CURLOPT_WRITEFUNCTION, bodyCallback)
        _ = s3r_setopt_ptr(h, CURLOPT_WRITEDATA, sinkPtr)
        _ = s3r_setopt_writecb(h, CURLOPT_HEADERFUNCTION, headerCallback)
        _ = s3r_setopt_ptr(h, CURLOPT_HEADERDATA, sinkPtr)
        _ = s3r_setopt_long(h, CURLOPT_HTTP_CONTENT_DECODING, 0)   // never let libcurl decode a Content-Encoding
        _ = s3r_setopt_long(h, CURLOPT_CONNECTTIMEOUT, 10)
        _ = s3r_setopt_long(h, CURLOPT_LOW_SPEED_LIMIT, 1)
        _ = s3r_setopt_long(h, CURLOPT_LOW_SPEED_TIME, 30)
        _ = s3r_setopt_long(h, CURLOPT_NOSIGNAL, 1)
        _ = s3r_setopt_long(h, CURLOPT_FOLLOWLOCATION, 0)
        _ = s3r_setopt_str(h, CURLOPT_CAINFO, "/etc/ssl/cert.pem")
        if verbose { _ = s3r_setopt_long(h, CURLOPT_VERBOSE, 1) }
        requestCount += 1
        let rc = curl_easy_perform(h)
        if rc != CURLE_OK {
            throw TransportError.curl(code: Int32(rc.rawValue), message: String(cString: curl_easy_strerror(rc)))
        }
        var status: Int = 0
        _ = s3r_getinfo_long(h, CURLINFO_RESPONSE_CODE, &status)
        return HTTPResponse(status: status, body: sink.body, headers: String(decoding: sink.headers, as: UTF8.self))
    }

    private func isDroppedConnection(_ code: Int32) -> Bool {
        switch code {
        case 5, 6, 7, 16, 18, 28, 35, 52, 55, 56: return true   // resolve, connect, http2, partial, timeout, ssl connect, got nothing, send, recv
        default: return false
        }
    }

    private func randomWait(_ ceiling: Double) {
        let w = Double.random(in: 0...ceiling)
        usleep(UInt32(w * 1_000_000))
    }

    /// Performs a signed GET with the spec's retry policy: dropped connections for two minutes, 5xx three attempts.
    func get(canonicalPath: String, query: [(String, String)] = []) throws -> HTTPResponse {
        let started = Date()
        var connCeiling = 0.5
        var serverAttempts = 0
        var serverCeiling = 0.1
        while true {
            do {
                let r = try performOnce(canonicalPath: canonicalPath, query: query)
                if r.status >= 500 {
                    serverAttempts += 1
                    if serverAttempts >= 3 { return r }
                    if r.status == 503 { serverCeiling = max(serverCeiling, 0.5) }
                    eprint("note: HTTP \(r.status) \(r.s3ErrorCode ?? "") on \(canonicalPath); retrying")
                    randomWait(serverCeiling)
                    serverCeiling = min(serverCeiling * 2, 20)
                    continue
                }
                return r
            } catch TransportError.curl(let code, let message) where isDroppedConnection(code) {
                if Date().timeIntervalSince(started) > 120 {
                    throw TransportError.gaveUp("connection kept failing for two minutes on \(canonicalPath): \(message)")
                }
                eprint("note: connection failed on \(canonicalPath) (\(message)); retrying")
                randomWait(connCeiling)
                connCeiling = min(connCeiling * 2, 2)
                continue
            }
        }
    }

    // MARK: S3 operations

    /// Keys directly under `prefix` (ListObjectsV2 with delimiter "/"). CommonPrefixes are ignored.
    func listKeys(prefix: String) throws -> [String] {
        var keys: [String] = []
        var token: String? = nil
        repeat {
            var q: [(String, String)] = [("list-type", "2"), ("prefix", prefix), ("delimiter", "/")]
            if let t = token { q.append(("continuation-token", t)) }
            let r = try get(canonicalPath: "/", query: q)
            guard r.status == 200 else {
                throw TransportError.fatal("listing '\(prefix)' failed: \(r.errorSummary)")
            }
            let p = ListParser()
            let parser = XMLParser(data: Data(r.body))
            parser.delegate = p
            guard parser.parse() else { throw TransportError.fatal("listing '\(prefix)': could not parse the XML response") }
            keys.append(contentsOf: p.keys)
            token = p.isTruncated ? p.nextToken : nil
            if p.isTruncated && token == nil { throw TransportError.fatal("listing '\(prefix)': truncated with no continuation token") }
        } while token != nil
        return keys
    }

    /// Keys and common prefixes directly under `prefix` (first page only; a development listing).
    func listKeysAndPrefixes(prefix: String) throws -> (keys: [String], prefixes: [String]) {
        let r = try get(canonicalPath: "/", query: [("list-type", "2"), ("prefix", prefix), ("delimiter", "/")])
        guard r.status == 200 else { throw TransportError.fatal("listing '\(prefix)' failed: \(r.errorSummary)") }
        let p = ListParser()
        let parser = XMLParser(data: Data(r.body))
        parser.delegate = p
        guard parser.parse() else { throw TransportError.fatal("could not parse the XML response") }
        return (p.keys, p.prefixes)
    }

    func canonicalPath(forKey key: String) -> String {
        return "/" + key.split(separator: "/", omittingEmptySubsequences: false).map { uriEncode(String($0), encodeSlash: true) }.joined(separator: "/")
    }

    /// GET objects/<hash> or any key. A 404 whose code is NoSuchKey or NotFound is a miss; anything else stops the restore.
    func getObject(key: String) throws -> GetResult {
        let r = try get(canonicalPath: canonicalPath(forKey: key))
        if r.status == 200 { return .found(r.body) }
        let code = r.s3ErrorCode ?? ""
        if r.status == 404 && (code == "NoSuchKey" || code == "NotFound") { return .missing(code: code) }
        throw TransportError.fatal("GET \(key) failed: \(r.errorSummary)")
    }
}

final class ListParser: NSObject, XMLParserDelegate {
    var keys: [String] = []
    var prefixes: [String] = []
    var isTruncated = false
    var nextToken: String? = nil
    private var path: [String] = []
    private var text = ""

    func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?, qualifiedName qName: String?, attributes attributeDict: [String: String] = [:]) {
        path.append(elementName)
        text = ""
    }
    func parser(_ parser: XMLParser, foundCharacters string: String) {
        text += string
    }
    func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName qName: String?) {
        if path.count >= 2 && path[path.count - 2] == "Contents" && elementName == "Key" {
            keys.append(text)
        } else if path.count >= 2 && path[path.count - 2] == "CommonPrefixes" && elementName == "Prefix" {
            prefixes.append(text)
        } else if path.count == 2 && elementName == "IsTruncated" {
            isTruncated = (text == "true")
        } else if path.count == 2 && elementName == "NextContinuationToken" {
            nextToken = text
        }
        path.removeLast()
        text = ""
    }
}
