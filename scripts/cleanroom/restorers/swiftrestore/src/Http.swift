import Foundation

// Plain HTTPS through the system libcurl. libcurl reads HTTPS_PROXY itself.

struct HTTPResponse {
    var status: Int
    var headers: [(String, String)]
    var body: [UInt8]
    func header(_ name: String) -> String? {
        let n = name.lowercased()
        return headers.first { $0.0.lowercased() == n }?.1
    }
}

enum HTTPError: Error, CustomStringConvertible {
    case transport(code: UInt32, message: String)   // CURLcode
    case setup(String)
    var description: String {
        switch self {
        case .transport(let code, let message): return "transport error \(code): \(message)"
        case .setup(let s): return "libcurl setup: \(s)"
        }
    }
    /// A dropped connection in the spec's sense: reset, refused, broken, unreachable,
    /// unresolvable, connect > 10 s, or 30 s without a byte.
    var isDroppedConnection: Bool {
        guard case .transport(let code, _) = self else { return false }
        switch code {
        case CURLE_COULDNT_RESOLVE_HOST.rawValue, CURLE_COULDNT_RESOLVE_PROXY.rawValue,
             CURLE_COULDNT_CONNECT.rawValue, CURLE_OPERATION_TIMEDOUT.rawValue,
             CURLE_SEND_ERROR.rawValue, CURLE_RECV_ERROR.rawValue, CURLE_PARTIAL_FILE.rawValue,
             CURLE_GOT_NOTHING.rawValue, CURLE_SSL_CONNECT_ERROR.rawValue, CURLE_HTTP2.rawValue,
             CURLE_HTTP2_STREAM.rawValue:
            return true
        default: return false
        }
    }
}

private final class ResponseBox {
    var body: [UInt8] = []
    var headerLines: [String] = []
}

private let writeBody: s3r_write_cb = { ptr, size, nmemb, userdata in
    let n = size * nmemb
    guard let ptr, let userdata else { return 0 }
    let box = Unmanaged<ResponseBox>.fromOpaque(userdata).takeUnretainedValue()
    ptr.withMemoryRebound(to: UInt8.self, capacity: n) { p in
        box.body.append(contentsOf: UnsafeBufferPointer(start: p, count: n))
    }
    return n
}

private let writeHeader: s3r_write_cb = { ptr, size, nmemb, userdata in
    let n = size * nmemb
    guard let ptr, let userdata else { return 0 }
    let box = Unmanaged<ResponseBox>.fromOpaque(userdata).takeUnretainedValue()
    let bytes = ptr.withMemoryRebound(to: UInt8.self, capacity: n) { Array(UnsafeBufferPointer(start: $0, count: n)) }
    box.headerLines.append(String(decoding: bytes, as: UTF8.self))
    return n
}

enum HTTP {
    // One easy handle for the whole run, so the TLS connection through the proxy is reused.
    nonisolated(unsafe) private static var shared: UnsafeMutableRawPointer? = nil

    static func globalInit() throws {
        // Must come before any other libcurl call, curl_easy_init included (ENVIRONMENT.md).
        let r = curl_global_sslset(CURLSSLBACKEND_OPENSSL, nil, nil)
        if r != CURLSSLSET_OK {
            throw HTTPError.setup("curl_global_sslset(OPENSSL) returned \(r.rawValue)")
        }
        curl_global_init(Int(CURL_GLOBAL_ALL))
    }

    static func get(url: String, headers: [String]) throws -> HTTPResponse {
        if shared == nil { shared = curl_easy_init() }
        guard let h = shared else { throw HTTPError.setup("curl_easy_init failed") }
        curl_easy_reset(h)
        let box = ResponseBox()
        let ctx = Unmanaged.passUnretained(box).toOpaque()
        var slist: UnsafeMutablePointer<curl_slist>? = nil
        for hdr in headers { slist = curl_slist_append(slist, hdr) }
        defer { curl_slist_free_all(slist) }

        _ = s3r_setopt_str(h, CURLOPT_URL, url)
        _ = s3r_setopt_slist(h, CURLOPT_HTTPHEADER, slist)
        _ = s3r_setopt_writefn(h, CURLOPT_WRITEFUNCTION, writeBody)
        _ = s3r_setopt_ptr(h, CURLOPT_WRITEDATA, ctx)
        _ = s3r_setopt_writefn(h, CURLOPT_HEADERFUNCTION, writeHeader)
        _ = s3r_setopt_ptr(h, CURLOPT_HEADERDATA, ctx)
        _ = s3r_setopt_long(h, CURLOPT_NOSIGNAL, 1)
        _ = s3r_setopt_long(h, CURLOPT_FOLLOWLOCATION, 0)
        _ = s3r_setopt_long(h, CURLOPT_CONNECTTIMEOUT, 10)       // connecting takes 10 seconds
        _ = s3r_setopt_long(h, CURLOPT_LOW_SPEED_LIMIT, 1)       // 30 seconds without a byte
        _ = s3r_setopt_long(h, CURLOPT_LOW_SPEED_TIME, 30)
        _ = s3r_setopt_long(h, CURLOPT_SSL_VERIFYPEER, 1)
        _ = s3r_setopt_long(h, CURLOPT_SSL_VERIFYHOST, 2)
        _ = s3r_setopt_str(h, CURLOPT_CAINFO, "/etc/ssl/cert.pem")
        _ = s3r_setopt_str(h, CURLOPT_ACCEPT_ENCODING, nil)      // no Content-Encoding games
        _ = s3r_setopt_long(h, CURLOPT_HTTP_TRANSFER_DECODING, 1)
        _ = s3r_setopt_long(h, CURLOPT_HTTP_CONTENT_DECODING, 0) // never decompress a stored object

        var errbuf = [CChar](repeating: 0, count: Int(CURL_ERROR_SIZE))
        let rc = errbuf.withUnsafeMutableBufferPointer { buf -> CURLcode in
            _ = s3r_setopt_ptr(h, CURLOPT_ERRORBUFFER, buf.baseAddress)
            return curl_easy_perform(h)
        }
        if rc != CURLE_OK {
            let fromBuf = String(decoding: errbuf.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
            let msg = fromBuf.isEmpty ? String(cString: curl_easy_strerror(rc)) : fromBuf
            throw HTTPError.transport(code: rc.rawValue, message: msg)
        }
        var status: Int = 0
        _ = s3r_getinfo_long(h, CURLINFO_RESPONSE_CODE, &status)
        var hdrs: [(String, String)] = []
        for line in box.headerLines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces)
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespacesAndNewlines)
            hdrs.append((name, value))
        }
        return HTTPResponse(status: status, headers: hdrs, body: box.body)
    }
}
