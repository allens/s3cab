import Foundation
import CryptoKit

// AWS Signature Version 4 for S3, written from memory of the published scheme.

struct AWSCredentials {
    let accessKeyId: String
    let secretAccessKey: String
    let sessionToken: String?

    static func fromEnvironment() throws -> AWSCredentials {
        let env = ProcessInfo.processInfo.environment
        guard let ak = env["AWS_ACCESS_KEY_ID"], !ak.isEmpty,
              let sk = env["AWS_SECRET_ACCESS_KEY"], !sk.isEmpty else {
            throw RestoreFailure("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set")
        }
        let tok = env["AWS_SESSION_TOKEN"].flatMap { $0.isEmpty ? nil : $0 }
        return AWSCredentials(accessKeyId: ak, secretAccessKey: sk, sessionToken: tok)
    }
}

enum SigV4 {
    static func hexSHA256(_ bytes: [UInt8]) -> String {
        SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
    }
    static func hexSHA256(_ s: String) -> String { hexSHA256(Array(s.utf8)) }

    static func hmac(_ key: [UInt8], _ msg: String) -> [UInt8] {
        Array(HMAC<SHA256>.authenticationCode(for: Array(msg.utf8), using: SymmetricKey(data: key)))
    }

    /// RFC 3986 unreserved characters stay; everything else is %XX on its UTF-8 bytes.
    static func uriEncode(_ s: String, keepSlash: Bool) -> String {
        var out = ""
        for b in s.utf8 {
            switch b {
            case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"),
                 UInt8(ascii: "0")...UInt8(ascii: "9"),
                 UInt8(ascii: "-"), UInt8(ascii: "_"), UInt8(ascii: "."), UInt8(ascii: "~"):
                out.unicodeScalars.append(Unicode.Scalar(b))
            case UInt8(ascii: "/") where keepSlash:
                out.append("/")
            default:
                out += String(format: "%%%02X", b)
            }
        }
        return out
    }

    static func amzDate(_ date: Date = Date()) -> (full: String, day: String) {
        var t = time_t(date.timeIntervalSince1970.rounded(.down))
        var tm = tm()
        gmtime_r(&t, &tm)
        let full = String(format: "%04d%02d%02dT%02d%02d%02dZ", Int(tm.tm_year) + 1900, Int(tm.tm_mon) + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec)
        return (full, String(full.prefix(8)))
    }

    /// Headers for a GET with an empty body. `canonicalPath` is already URI-encoded
    /// (slashes kept); `query` is a list of raw (name, value) pairs.
    static func signGET(host: String, canonicalPath: String, query: [(String, String)],
                        region: String, credentials: AWSCredentials, now: Date = Date()) -> [String] {
        let (dateFull, dateDay) = amzDate(now)
        let payloadHash = hexSHA256([])
        var hdrs: [(String, String)] = [
            ("host", host),
            ("x-amz-content-sha256", payloadHash),
            ("x-amz-date", dateFull),
        ]
        if let tok = credentials.sessionToken { hdrs.append(("x-amz-security-token", tok)) }
        hdrs.sort { $0.0 < $1.0 }
        let canonicalHeaders = hdrs.map { "\($0.0):\($0.1)\n" }.joined()
        let signedHeaders = hdrs.map { $0.0 }.joined(separator: ";")
        var encodedQuery: [(String, String)] = query.map { (uriEncode($0.0, keepSlash: false), uriEncode($0.1, keepSlash: false)) }
        encodedQuery.sort { (a: (String, String), b: (String, String)) -> Bool in a.0 == b.0 ? a.1 < b.1 : a.0 < b.0 }
        let canonicalQuery: String = encodedQuery.map { (p: (String, String)) -> String in p.0 + "=" + p.1 }.joined(separator: "&")
        let canonicalRequest = ["GET", canonicalPath, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].joined(separator: "\n")
        let scope = "\(dateDay)/\(region)/s3/aws4_request"
        let stringToSign = ["AWS4-HMAC-SHA256", dateFull, scope, hexSHA256(canonicalRequest)].joined(separator: "\n")
        let kDate = hmac(Array("AWS4\(credentials.secretAccessKey)".utf8), dateDay)
        let kRegion = hmac(kDate, region)
        let kService = hmac(kRegion, "s3")
        let kSigning = hmac(kService, "aws4_request")
        let signature = hmac(kSigning, stringToSign).map { String(format: "%02x", $0) }.joined()
        let auth = "AWS4-HMAC-SHA256 Credential=\(credentials.accessKeyId)/\(scope), SignedHeaders=\(signedHeaders), Signature=\(signature)"
        var out = hdrs.filter { $0.0 != "host" }.map { "\($0.0): \($0.1)" }
        out.append("Authorization: \(auth)")
        return out
    }
}
