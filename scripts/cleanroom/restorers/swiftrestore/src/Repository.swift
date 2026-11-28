import Foundation

// Finding things in a repository: the environment's credentials and region, the names the
// layout allows, and a set's snapshots.

func environment(_ name: String) -> String? {
    guard let v = getenv(name) else { return nil }
    let s = String(cString: v)
    return s.isEmpty ? nil : s
}

/// The LibreSSL backend must be chosen before any other libcurl call.
func startTransport() throws {
    let chosen = curl_global_sslset(CURLSSLBACKEND_OPENSSL, nil, nil)
    guard curl_global_init(Int(CURL_GLOBAL_DEFAULT)) == CURLE_OK else { throw Fatal("libcurl would not start") }
    if chosen != CURLSSLSET_OK {
        complain("s3cab-restore: warning: libcurl would not select its LibreSSL backend (\(chosen.rawValue))")
    }
}

/// Credentials from the environment; the region from AWS_REGION, else AWS_DEFAULT_REGION, else
/// us-east-1. The bucket's own region is followed from there if it is another.
func makeClient(bucket: String) throws -> S3Client {
    guard let accessKey = environment("AWS_ACCESS_KEY_ID"), let secretKey = environment("AWS_SECRET_ACCESS_KEY") else {
        throw Fatal("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set in the environment")
    }
    let region = environment("AWS_REGION") ?? environment("AWS_DEFAULT_REGION") ?? "us-east-1"
    let creds = Credentials(accessKey: accessKey, secretKey: secretKey, sessionToken: environment("AWS_SESSION_TOKEN"))
    return try S3Client(bucket: bucket, region: region, creds: creds)
}

/// `a` to `z`, digits and hyphens. A folder under snapshots/ named with anything else holds no set.
func isSetName(_ b: [UInt8]) -> Bool {
    !b.isEmpty && b.allSatisfy { ($0 >= 0x61 && $0 <= 0x7A) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2D }
}

func isBucketName(_ b: [UInt8]) -> Bool {
    b.count >= 3 && b.count <= 63
        && b.allSatisfy { ($0 >= 0x61 && $0 <= 0x7A) || ($0 >= 0x30 && $0 <= 0x39) || $0 == 0x2D || $0 == 0x2E }
}

private let snapshotSuffix = Array(".tsv.gz".utf8)

/// The snapshots directly in a set's folder: keys named exactly YYYYMMDDTHHMM.tsv.gz, sorted.
/// A key in a folder below is not one, and the delimiter keeps those out of the listing.
func snapshotNames(_ s3: S3Client, set: String) throws -> [String] {
    let prefix = Array("snapshots/\(set)/".utf8)
    let listing = try s3.list(prefix: "snapshots/\(set)/", delimiter: "/")
    var names = [[UInt8]]()
    for key in listing.keys {
        guard key.count == prefix.count + 13 + snapshotSuffix.count, Array(key.prefix(prefix.count)) == prefix,
              Array(key.suffix(snapshotSuffix.count)) == snapshotSuffix else { continue }
        let name = Array(key[prefix.count..<(prefix.count + 13)])
        if isSnapshotName(name) { names.append(name) }
    }
    names.sort { $0.lexicographicallyPrecedes($1) }
    return names.map { String(decoding: $0, as: UTF8.self) }
}
