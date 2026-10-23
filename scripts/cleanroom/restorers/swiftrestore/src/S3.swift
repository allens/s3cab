import Foundation

struct RestoreFailure: Error, CustomStringConvertible {
    let description: String
    init(_ s: String) { description = s }
}

enum S3GetResult {
    case ok([UInt8])
    case missing(code: String)                 // 404 NoSuchKey / NotFound
    case failed(status: Int, code: String, message: String)
}

final class S3Client {
    let bucket: String
    let region: String
    let credentials: AWSCredentials
    let host: String
    var requestCount = 0
    var retryCount = 0

    init(bucket: String, region: String, credentials: AWSCredentials) {
        self.bucket = bucket
        self.region = region
        self.credentials = credentials
        self.host = "\(bucket).s3.\(region).amazonaws.com"
    }

    private func buildURL(path: String, query: [(String, String)]) -> String {
        var url = "https://\(host)\(path)"
        if !query.isEmpty {
            url += "?" + query.map { "\(SigV4.uriEncode($0.0, keepSlash: false))=\(SigV4.uriEncode($0.1, keepSlash: false))" }.joined(separator: "&")
        }
        return url
    }

    /// One signed GET with the spec's retry policy for dropped connections and 5xx.
    private func request(path: String, query: [(String, String)] = []) throws -> HTTPResponse {
        let url = buildURL(path: path, query: query)
        var attempts5xx = 0
        var dropStart: Date? = nil
        var dropCeiling = 0.5
        var ceiling5xx = 0.1
        while true {
            let headers = SigV4.signGET(host: host, canonicalPath: path, query: query, region: region, credentials: credentials)
            requestCount += 1
            do {
                let resp = try HTTP.get(url: url, headers: headers)
                if resp.status >= 500 {
                    attempts5xx += 1
                    let code = S3Client.errorCode(resp.body) ?? ""
                    if attempts5xx >= 3 { return resp }
                    if resp.status == 503 && code == "SlowDown" && ceiling5xx < 0.5 { ceiling5xx = 0.5 }
                    let wait = Double.random(in: 0..<ceiling5xx)
                    log("retrying after HTTP \(resp.status) \(code) (wait \(String(format: "%.2f", wait))s)")
                    retryCount += 1
                    Thread.sleep(forTimeInterval: wait)
                    ceiling5xx = min(ceiling5xx * 2, 20)
                    continue
                }
                return resp
            } catch let e as HTTPError where e.isDroppedConnection {
                let now = Date()
                if dropStart == nil { dropStart = now }
                if now.timeIntervalSince(dropStart!) >= 120 { throw e }
                let wait = Double.random(in: 0..<dropCeiling)
                log("retrying after \(e) (wait \(String(format: "%.2f", wait))s)")
                retryCount += 1
                Thread.sleep(forTimeInterval: wait)
                dropCeiling = min(dropCeiling * 2, 2)
            }
        }
    }

    static func errorCode(_ body: [UInt8]) -> String? {
        XMLExtract.first(tag: "Code", in: body)
    }

    func getObject(key: String) throws -> S3GetResult {
        let path = "/" + SigV4.uriEncode(key, keepSlash: true)
        let resp = try request(path: path)
        if resp.status == 200 { return .ok(resp.body) }
        let code = S3Client.errorCode(resp.body) ?? ""
        let message = XMLExtract.first(tag: "Message", in: resp.body) ?? ""
        if resp.status == 404 && (code == "NoSuchKey" || code == "NotFound") { return .missing(code: code) }
        return .failed(status: resp.status, code: code, message: message)
    }

    struct Listing { var keys: [String] = []; var prefixes: [String] = [] }

    /// ListObjectsV2 under a prefix, all pages. With delimiter "/" only keys directly there.
    func list(prefix: String, delimiter: String? = "/") throws -> Listing {
        var out = Listing()
        var token: String? = nil
        repeat {
            var q: [(String, String)] = [("list-type", "2"), ("prefix", prefix)]
            if let d = delimiter { q.append(("delimiter", d)) }
            if let t = token { q.append(("continuation-token", t)) }
            let resp = try request(path: "/", query: q)
            guard resp.status == 200 else {
                let code = S3Client.errorCode(resp.body) ?? ""
                let message = XMLExtract.first(tag: "Message", in: resp.body) ?? ""
                throw RestoreFailure("listing \(prefix) failed: HTTP \(resp.status) \(code) \(message)")
            }
            let doc = XMLExtract.parse(resp.body)
            out.keys += doc.values(path: ["ListBucketResult", "Contents", "Key"])
            out.prefixes += doc.values(path: ["ListBucketResult", "CommonPrefixes", "Prefix"])
            let truncated = doc.values(path: ["ListBucketResult", "IsTruncated"]).first == "true"
            token = truncated ? doc.values(path: ["ListBucketResult", "NextContinuationToken"]).first : nil
        } while token != nil
        return out
    }
}

// Minimal XML reading through Foundation's XMLParser: collects text by element path.
final class XMLExtract: NSObject, XMLParserDelegate {
    private var stack: [String] = []
    private var text: [String: [String]] = [:]
    private var current = ""

    static func parse(_ bytes: [UInt8]) -> XMLExtract {
        let x = XMLExtract()
        let p = XMLParser(data: Data(bytes))
        p.delegate = x
        p.parse()
        return x
    }
    static func first(tag: String, in bytes: [UInt8]) -> String? {
        let x = parse(bytes)
        return x.text.first { $0.key.hasSuffix("/" + tag) || $0.key == tag }?.value.first
    }
    func values(path: [String]) -> [String] { text[path.joined(separator: "/")] ?? [] }

    func parser(_ parser: XMLParser, didStartElement elementName: String, namespaceURI: String?, qualifiedName qName: String?, attributes attributeDict: [String: String] = [:]) {
        stack.append(elementName); current = ""
    }
    func parser(_ parser: XMLParser, foundCharacters string: String) { current += string }
    func parser(_ parser: XMLParser, didEndElement elementName: String, namespaceURI: String?, qualifiedName qName: String?) {
        text[stack.joined(separator: "/"), default: []].append(current)
        current = ""
        _ = stack.popLast()
    }
}

func log(_ s: String) {
    FileHandle.standardError.write(Data((s + "\n").utf8))
}
