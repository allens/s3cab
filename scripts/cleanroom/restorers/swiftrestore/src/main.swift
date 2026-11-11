import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

func die(_ msg: String, code: Int32 = 1) -> Never { fputs("s3cab-restore: \(msg)\n", stderr); exit(code) }

let args = CommandLine.arguments
guard args.count == 4 || args.count == 5 else { die("usage: s3cab-restore <bucket> <set> <dir> [<snapshot>]", code: 2) }
let bucket = args[1], setName = args[2], outDir = args[3]
var snapshotArg: String? = args.count == 5 ? args[4] : nil

func isSetName(_ s: String) -> Bool {
    let u = Array(s.utf8)
    guard !u.isEmpty, u.first != 0x2D, u.last != 0x2D else { return false }
    var prevHyphen = false
    for c in u {
        if c == 0x2D { if prevHyphen { return false }; prevHyphen = true; continue }
        guard (c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39) else { return false }
        prevHyphen = false
    }
    return true
}
func isSnapshotName(_ s: String) -> Bool {
    let u = Array(s.utf8); guard u.count == 13 else { return false }
    for (i, c) in u.enumerated() {
        if i == 8 { if c != 0x54 { return false } } else if !(c >= 0x30 && c <= 0x39) { return false }
    }
    return true
}

guard isSetName(setName) else { die("'\(setName)' isn't a set name: a to z and digits with single hyphens between") }

let env = ProcessInfo.processInfo.environment
guard let ak = env["AWS_ACCESS_KEY_ID"], let sk = env["AWS_SECRET_ACCESS_KEY"] else { die("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set") }
let region = env["AWS_REGION"] ?? env["AWS_DEFAULT_REGION"] ?? "us-east-1"
let token = env["AWS_SESSION_TOKEN"]

let s3: S3Client
do { s3 = try S3Client(bucket: bucket, region: region, accessKey: ak, secretKey: sk, token: token) } catch { die("\(error)") }

var name: String
if var s = snapshotArg {
    if s.hasSuffix(".tsv.gz") { s = String(s.dropLast(7)) }
    guard isSnapshotName(s) else { die("'\(snapshotArg!)' isn't a snapshot name (YYYYMMDDTHHMM)") }
    name = s
} else {
    let prefix = "snapshots/\(setName)/"
    let listing: (keys: [String], prefixes: [String])
    do { listing = try s3.list(prefix: prefix) } catch { die("listing \(prefix): \(error)") }
    let names = listing.keys.compactMap { k -> String? in
        guard k.hasPrefix(prefix), k.hasSuffix(".tsv.gz") else { return nil }
        let n = String(k.dropFirst(prefix.count).dropLast(7))
        return isSnapshotName(n) ? n : nil
    }
    guard let latest = names.max(by: { Array($0.utf8).lexicographicallyPrecedes(Array($1.utf8)) }) else { die("set '\(setName)' has no snapshot in \(bucket)") }
    name = latest
    fputs("latest snapshot of \(setName): \(name) (of \(names.count))\n", stderr)
}

let key = "snapshots/\(setName)/\(name).tsv.gz"
let gz = MemorySink()
do {
    switch try s3.get(key: key, sink: gz) {
    case .miss: die("no such snapshot: \(key)")
    case .ok: break
    }
} catch { die("fetching \(key): \(error)") }

let text: Bytes
do { text = try gunzipAll(gz.data) } catch { die("snapshot \(key) is damaged: \(error); refusing to restore from it") }

let snap: Snapshot
do { snap = try parseSnapshot(text) } catch { die("snapshot \(key) refused: \(error)") }
fputs("snapshot \(name): \(snap.fileRowCount) file row(s), \(snap.dirs.count) @SET DIR row(s), START \(snap.start.map { String(decoding: $0.text, as: UTF8.self) } ?? "none")\n", stderr)

let restorer = Restorer(s3: s3, output: bytes(outDir), start: snap.start)
do { try restorer.run(snap) } catch { fputs("\(restorer.summary())\n", stderr); die("stopped: \(error)") }
fputs("\(restorer.summary()); \(s3.requests) request(s)\n", stderr)
exit(restorer.failed ? 1 : 0)
