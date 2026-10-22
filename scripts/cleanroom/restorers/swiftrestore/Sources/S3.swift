// Minimal S3 reader: SigV4-signed GET and ListObjectsV2 over libcurl. No SDK.
import CCurl
import CryptoKit
import Foundation

struct Credentials {
    let accessKey: String
    let secretKey: String
    let sessionToken: String?
    let region: String

    static func fromEnvironment() throws -> Credentials {
        let env = ProcessInfo.processInfo.environment
        guard let ak = env["AWS_ACCESS_KEY_ID"], !ak.isEmpty,
              let sk = env["AWS_SECRET_ACCESS_KEY"], !sk.isEmpty
        else { throw Fatal("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set") }
        let token = env["AWS_SESSION_TOKEN"].flatMap { $0.isEmpty ? nil : $0 }
        let region = env["AWS_REGION"] ?? env["AWS_DEFAULT_REGION"] ?? "us-east-1"
        return Credentials(accessKey: ak, secretKey: sk, sessionToken: token, region: region)
    }
}

struct Fatal: Error, CustomStringConvertible {
    let description: String
    init(_ d: String) { description = d }
}

let emptySHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

func hex(_ bytes: some Sequence<UInt8>) -> String {
    let digits = Array("0123456789abcdef".utf8)
    var out = [UInt8]()
    for b in bytes { out.append(digits[Int(b >> 4)]); out.append(digits[Int(b & 15)]) }
    return String(decoding: out, as: UTF8.self)
}

/// RFC 3986 percent-encoding as SigV4 wants it: unreserved bytes kept, everything else %XX.
func uriEncode(_ s: String, keepSlash: Bool) -> String {
    var out = ""
    for b in s.utf8 {
        switch b {
        case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"),
             UInt8(ascii: "0")...UInt8(ascii: "9"), UInt8(ascii: "-"), UInt8(ascii: "_"),
             UInt8(ascii: "."), UInt8(ascii: "~"):
            out.unicodeScalars.append(Unicode.Scalar(b))
        case UInt8(ascii: "/") where keepSlash:
            out.append("/")
        default:
            out += String(format: "%%%02X", b)
        }
    }
    return out
}

func percentDecode(_ s: String) -> String? {
    var bytes = [UInt8]()
    var it = Array(s.utf8)[...]
    while let b = it.popFirst() {
        if b == UInt8(ascii: "%") {
            guard it.count >= 2, let v = UInt8(String(decoding: it.prefix(2), as: UTF8.self), radix: 16)
            else { return nil }
            bytes.append(v); it = it.dropFirst(2)
        } else if b == UInt8(ascii: "+") {
            bytes.append(UInt8(ascii: " "))  // encoding-type=url uses form encoding for spaces
        } else {
            bytes.append(b)
        }
    }
    return String(validating: bytes, as: UTF8.self)
}

// MARK: - Response sinks

/// Collects the body of one HTTP exchange. While the status is 2xx the body goes to the
/// caller's target (memory, or a file while hashing); otherwise it is kept as the error text.
final class Sink {
    enum Target { case memory, file(Int32) }
    let target: Target
    var status = 0
    var body = [UInt8]()
    var errorBody = [UInt8]()
    var hasher = SHA256()
    var bytesWritten = 0
    var writeFailed: Int32 = 0

    init(_ target: Target) { self.target = target }

    func header(_ line: UnsafeRawBufferPointer) {
        // A new status line starts a new response (proxy CONNECT replies are suppressed).
        if line.starts(with: "HTTP/".utf8) {
            let text = String(decoding: line, as: UTF8.self)
            let parts = text.split(separator: " ", maxSplits: 2)
            if parts.count >= 2, let code = Int(parts[1]) { status = code }
        }
    }

    func data(_ chunk: UnsafeRawBufferPointer) -> Bool {
        guard (200..<300).contains(status) else { errorBody.append(contentsOf: chunk); return true }
        switch target {
        case .memory:
            body.append(contentsOf: chunk)
        case .file(let fd):
            hasher.update(bufferPointer: chunk)
            var off = 0
            while off < chunk.count {
                let n = Darwin.write(fd, chunk.baseAddress! + off, chunk.count - off)
                if n < 0 {
                    if errno == EINTR { continue }
                    writeFailed = errno; return false
                }
                off += n
            }
            bytesWritten += chunk.count
        }
        return true
    }
}

private let headerCallback: s3c_data_cb = { ptr, size, nmemb, ud in
    let n = size * nmemb
    let sink = Unmanaged<Sink>.fromOpaque(ud!).takeUnretainedValue()
    sink.header(UnsafeRawBufferPointer(start: ptr, count: n))
    return n
}

private let dataCallback: s3c_data_cb = { ptr, size, nmemb, ud in
    let n = size * nmemb
    let sink = Unmanaged<Sink>.fromOpaque(ud!).takeUnretainedValue()
    return sink.data(UnsafeRawBufferPointer(start: ptr, count: n)) ? n : 0
}

// MARK: - Transport

final class Transport {
    private let handle: UnsafeMutableRawPointer

    init() throws {
        let sel = s3c_select_openssl()
        // 0 = CURLSSLSET_OK. Anything else leaves the backend that needs trustd.
        guard sel == 0 else { throw Fatal("curl_global_sslset(OPENSSL) returned \(sel)") }
        guard curl_global_init(Int(CURL_GLOBAL_DEFAULT)) == CURLE_OK, let h = curl_easy_init()
        else { throw Fatal("libcurl failed to initialise") }
        handle = h
    }

    deinit { curl_easy_cleanup(handle) }

    enum Outcome {
        case response(Int, Sink)
        case transportError(CURLcode, String)
    }

    func perform(url: String, headers: [String], sink: Sink) -> Outcome {
        let h = handle
        curl_easy_reset(h)
        var list: UnsafeMutablePointer<curl_slist>? = nil
        for line in headers { list = curl_slist_append(list, line) }
        defer { curl_slist_free_all(list) }
        var errbuf = [CChar](repeating: 0, count: Int(CURL_ERROR_SIZE) + 1)
        let ud = Unmanaged.passUnretained(sink).toOpaque()
        let code: CURLcode = errbuf.withUnsafeMutableBufferPointer { eb in
            _ = s3c_set_str(h, CURLOPT_URL, url)
            _ = s3c_set_slist(h, CURLOPT_HTTPHEADER, list)
            _ = s3c_set_ptr(h, CURLOPT_ERRORBUFFER, eb.baseAddress)
            _ = s3c_set_cb(h, CURLOPT_HEADERFUNCTION, headerCallback)
            _ = s3c_set_ptr(h, CURLOPT_HEADERDATA, ud)
            _ = s3c_set_cb(h, CURLOPT_WRITEFUNCTION, dataCallback)
            _ = s3c_set_ptr(h, CURLOPT_WRITEDATA, ud)
            _ = s3c_set_long(h, CURLOPT_SUPPRESS_CONNECT_HEADERS, 1)
            _ = s3c_set_long(h, CURLOPT_FOLLOWLOCATION, 0)
            _ = s3c_set_long(h, CURLOPT_NOSIGNAL, 1)
            _ = s3c_set_long(h, CURLOPT_CONNECTTIMEOUT, 30)
            // A stall of 60 s below 1 byte/s counts as a dropped connection.
            _ = s3c_set_long(h, CURLOPT_LOW_SPEED_LIMIT, 1)
            _ = s3c_set_long(h, CURLOPT_LOW_SPEED_TIME, 60)
            _ = s3c_set_str(h, CURLOPT_CAINFO, "/etc/ssl/cert.pem")
            // No CURLOPT_ACCEPT_ENCODING and no content decoding: bytes arrive exactly as stored.
            _ = s3c_set_long(h, CURLOPT_HTTP_CONTENT_DECODING, 0)
            return curl_easy_perform(h)
        }
        if code != CURLE_OK {
            let msg = String(decoding: errbuf.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
            return .transportError(code, msg.isEmpty ? String(cString: curl_easy_strerror(code)) : msg)
        }
        var status: Int = 0
        _ = s3c_get_long(h, CURLINFO_RESPONSE_CODE, &status)
        if sink.status == 0 { sink.status = status }
        return .response(status, sink)
    }
}

// MARK: - SigV4

struct Signer {
    let creds: Credentials

    func hmac(_ key: [UInt8], _ msg: String) -> [UInt8] {
        Array(HMAC<SHA256>.authenticationCode(for: Array(msg.utf8), using: SymmetricKey(data: key)))
    }

    /// Signed headers for a GET with an empty body. `canonicalURI` and `canonicalQuery` must be
    /// exactly what goes on the wire.
    func headers(host: String, canonicalURI: String, canonicalQuery: String, now: time_t = time(nil)) -> [String] {
        var t = now
        var tmv = tm()
        gmtime_r(&t, &tmv)
        let amzDate = String(format: "%04d%02d%02dT%02d%02d%02dZ", tmv.tm_year + 1900, tmv.tm_mon + 1,
                             tmv.tm_mday, tmv.tm_hour, tmv.tm_min, tmv.tm_sec)
        let day = String(amzDate.prefix(8))
        var hdrs: [(String, String)] = [
            ("host", host),
            ("x-amz-content-sha256", emptySHA256),
            ("x-amz-date", amzDate),
        ]
        if let tok = creds.sessionToken { hdrs.append(("x-amz-security-token", tok)) }
        hdrs.sort { $0.0 < $1.0 }
        let signedHeaders = hdrs.map(\.0).joined(separator: ";")
        let canonicalHeaders = hdrs.map { "\($0.0):\($0.1.trimmingCharacters(in: .whitespaces))\n" }.joined()
        let canonicalRequest = ["GET", canonicalURI, canonicalQuery, canonicalHeaders, signedHeaders, emptySHA256]
            .joined(separator: "\n")
        let scope = "\(day)/\(creds.region)/s3/aws4_request"
        let stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope,
                            hex(SHA256.hash(data: Array(canonicalRequest.utf8)))].joined(separator: "\n")
        var key = hmac(Array("AWS4\(creds.secretKey)".utf8), day)
        key = hmac(key, creds.region)
        key = hmac(key, "s3")
        key = hmac(key, "aws4_request")
        let signature = hex(hmac(key, stringToSign))
        var out = hdrs.filter { $0.0 != "host" }.map { "\($0.0): \($0.1)" }
        out.append("Authorization: AWS4-HMAC-SHA256 Credential=\(creds.accessKey)/\(scope), "
                   + "SignedHeaders=\(signedHeaders), Signature=\(signature)")
        return out
    }
}

// MARK: - S3 client

enum GetResult {
    case ok(Sink)
    case notFound
}

final class S3Client {
    let bucket: String
    let creds: Credentials
    let transport: Transport
    let signer: Signer
    let host: String
    let pathPrefix: String
    var verbose = false

    init(bucket: String, creds: Credentials) throws {
        self.bucket = bucket
        self.creds = creds
        transport = try Transport()
        signer = Signer(creds: creds)
        if bucket.contains(".") {
            // A dotted bucket breaks the wildcard certificate under virtual-hosted style.
            host = "s3.\(creds.region).amazonaws.com"
            pathPrefix = "/" + uriEncode(bucket, keepSlash: false)
        } else {
            host = "\(bucket).s3.\(creds.region).amazonaws.com"
            pathPrefix = ""
        }
    }

    /// One signed GET, retried as format.md's reading checklist describes: a dropped
    /// connection for two minutes from the first failure, a 5xx up to three attempts in all,
    /// each wait random under a ceiling that doubles. 404 is a miss; any other failure throws.
    func get(key: String, query: [(String, String)] = [], into target: () throws -> Sink.Target,
             reset: () throws -> Void = {}) throws -> GetResult {
        let uri = pathPrefix + "/" + uriEncode(key, keepSlash: true)
        var pairs: [(String, String)] = []
        for (k, v) in query { pairs.append((uriEncode(k, keepSlash: false), uriEncode(v, keepSlash: false))) }
        pairs.sort { (a: (String, String), b: (String, String)) -> Bool in a.0 == b.0 ? a.1 < b.1 : a.0 < b.0 }
        let q = pairs.map { (p: (String, String)) -> String in p.0 + "=" + p.1 }.joined(separator: "&")
        let url = "https://\(host)\(uri)" + (q.isEmpty ? "" : "?\(q)")
        let key = key.isEmpty ? "?" + q : key  // for messages: a listing has no key
        var firstDrop: Date? = nil
        var serverErrors = 0
        var ceiling = 0.5
        while true {
            try reset()
            let sink = Sink(try target())
            let hdrs = signer.headers(host: host, canonicalURI: uri, canonicalQuery: q)
            if verbose { FileHandle.standardError.write(Data("GET \(url)\n".utf8)) }
            switch transport.perform(url: url, headers: hdrs, sink: sink) {
            case .transportError(let code, let msg):
                if sink.writeFailed != 0 {
                    throw Fatal("writing download of \(key): \(String(cString: strerror(sink.writeFailed)))")
                }
                let start = firstDrop ?? Date()
                firstDrop = start
                if Date().timeIntervalSince(start) > 120 {
                    throw Fatal("GET \(key): connection failed for two minutes (curl \(code.rawValue): \(msg))")
                }
                FileHandle.standardError.write(Data("  retrying \(key): curl \(code.rawValue): \(msg)\n".utf8))
            case .response(let status, let sink):
                switch status {
                case 200..<300:
                    return .ok(sink)
                case 404:
                    return .notFound
                case 500..<600:
                    serverErrors += 1
                    if serverErrors >= 3 {
                        throw Fatal("GET \(key): HTTP \(status) after 3 attempts: \(s3Message(sink.errorBody))")
                    }
                    FileHandle.standardError.write(Data("  retrying \(key): HTTP \(status)\n".utf8))
                default:
                    throw Fatal("GET \(key): HTTP \(status): \(s3Message(sink.errorBody))")
                }
            }
            Thread.sleep(forTimeInterval: Double.random(in: 0...ceiling))
            ceiling = min(ceiling * 2, 30)
        }
    }

    func getBytes(_ key: String) throws -> [UInt8]? {
        switch try get(key: key, into: { .memory }) {
        case .ok(let sink): return sink.body
        case .notFound: return nil
        }
    }

    /// ListObjectsV2 with a delimiter, every page. Keys come back URL-encoded
    /// (encoding-type=url) so that any byte in a key survives the XML.
    func list(prefix: String, delimiter: String = "/") throws -> (keys: [String], prefixes: [String]) {
        var keys = [String](), prefixes = [String]()
        var token: String? = nil
        repeat {
            var query = [("list-type", "2"), ("prefix", prefix), ("delimiter", delimiter), ("encoding-type", "url")]
            if let t = token { query.append(("continuation-token", t)) }
            guard case .ok(let sink) = try get(key: "", query: query, into: { .memory }) else {
                throw Fatal("listing \(prefix): bucket not found")
            }
            let page = ListPage(xml: Data(sink.body))
            guard page.parsed else { throw Fatal("listing \(prefix): unreadable ListObjectsV2 response") }
            for k in page.keys {
                guard let d = percentDecode(k) else { throw Fatal("listing \(prefix): undecodable key \(k)") }
                keys.append(d)
            }
            for p in page.prefixes {
                guard let d = percentDecode(p) else { throw Fatal("listing \(prefix): undecodable prefix \(p)") }
                prefixes.append(d)
            }
            token = page.truncated ? page.nextToken : nil
            if page.truncated && token == nil { throw Fatal("listing \(prefix): truncated page with no token") }
        } while token != nil
        return (keys, prefixes)
    }
}

func s3Message(_ body: [UInt8]) -> String {
    let text = String(decoding: body, as: UTF8.self)
    func tag(_ name: String) -> String? {
        guard let a = text.range(of: "<\(name)>"), let b = text.range(of: "</\(name)>", range: a.upperBound..<text.endIndex)
        else { return nil }
        return String(text[a.upperBound..<b.lowerBound])
    }
    if let code = tag("Code") { return code + (tag("Message").map { ": \($0)" } ?? "") }
    return text.prefix(200).description
}

final class ListPage: NSObject, XMLParserDelegate {
    var keys = [String](), prefixes = [String]()
    var truncated = false
    var nextToken: String? = nil
    var parsed = false
    private var path = [String]()
    private var text = ""

    init(xml: Data) {
        super.init()
        let p = XMLParser(data: xml)
        p.delegate = self
        parsed = p.parse()
    }

    func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?,
                qualifiedName: String?, attributes: [String: String] = [:]) {
        path.append(name); text = ""
    }

    func parser(_ parser: XMLParser, foundCharacters string: String) { text += string }

    func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
        let where_ = path.suffix(2).joined(separator: "/")
        switch where_ {
        case "Contents/Key": keys.append(text)
        case "CommonPrefixes/Prefix": prefixes.append(text)
        case "ListBucketResult/IsTruncated": truncated = (text == "true")
        case "ListBucketResult/NextContinuationToken": nextToken = text
        default: break
        }
        path.removeLast(); text = ""
    }
}
