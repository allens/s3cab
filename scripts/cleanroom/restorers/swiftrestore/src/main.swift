import Foundation
import CryptoKit

// s3cab-restore <bucket> <set> <dir> [<snapshot>]
// An independent restorer for the s3cab format, written from format.md alone.

let args = CommandLine.arguments
guard args.count == 4 || args.count == 5 else {
    log("usage: s3cab-restore <bucket> <set> <dir> [<snapshot>]")
    exit(2)
}
let bucket = args[1]
let setName = args[2]
let outDir = args[3]
var wanted: String? = args.count == 5 ? args[4] : nil
if let w = wanted, w.hasSuffix(".tsv.gz") { wanted = String(w.dropLast(7)) }

let setPattern = try! NSRegularExpression(pattern: "^[a-z0-9]+(-[a-z0-9]+)*$")
guard setPattern.firstMatch(in: setName, range: NSRange(setName.startIndex..., in: setName)) != nil else {
    log("not a set name (a-z, 0-9, single hyphens between): \(setName)")
    exit(2)
}
let snapshotNamePattern = try! NSRegularExpression(pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{4}$")

@MainActor func run() throws -> Int32 {
    let env = ProcessInfo.processInfo.environment
    let region = env["AWS_REGION"] ?? env["AWS_DEFAULT_REGION"] ?? "us-east-1"
    let creds = try AWSCredentials.fromEnvironment()
    try HTTP.globalInit()
    let s3 = S3Client(bucket: bucket, region: region, credentials: creds)

    // 1. Which snapshot.
    let prefix = "snapshots/\(setName)/"
    let name: String
    if let w = wanted {
        name = w
    } else {
        let listing = try s3.list(prefix: prefix, delimiter: "/")
        var names: [String] = []
        for key in listing.keys {
            let rest = String(key.dropFirst(prefix.count))
            guard rest.hasSuffix(".tsv.gz") else { continue }
            let n = String(rest.dropLast(7))
            if snapshotNamePattern.firstMatch(in: n, range: NSRange(n.startIndex..., in: n)) != nil { names.append(n) }
        }
        guard let latest = names.max(by: { Array($0.utf8).lexicographicallyPrecedes(Array($1.utf8)) }) else {
            throw RestoreFailure("no snapshot under \(prefix) (listed \(listing.keys.count) keys there)")
        }
        name = latest
        log("latest snapshot of \(setName): \(name) (of \(names.count))")
    }
    let key = "\(prefix)\(name).tsv.gz"

    // 2. Fetch and decompress it.
    let compressed: [UInt8]
    switch try s3.getObject(key: key) {
    case .ok(let b): compressed = b
    case .missing(let code): throw RestoreFailure("snapshot \(key) is not in the bucket (\(code))")
    case .failed(let status, let code, let msg): throw RestoreFailure("fetching \(key) failed: HTTP \(status) \(code) \(msg)")
    }
    let text: [UInt8]
    do { text = try Gzip.decompressAll(compressed) }
    catch { throw RestoreFailure("snapshot \(key) is damaged: \(error)") }

    // 3. Parse and check it.
    let snap: Snapshot
    do { snap = try SnapshotParser.parse(text) }
    catch let e as RestoreFailure { throw RestoreFailure("\(key): \(e.description)") }
    log("snapshot \(name): \(snap.dirs.count) @SET DIR row(s), \(snap.fileRowCount) file row(s), \(snap.rows.count) restorable, \(snap.refusals.count) refused"
        + (snap.info["@S3CAB SPEC"].map { "; spec \($0)" } ?? "")
        + (snap.info["@CLIENT NAME"].map { "; written by \($0) \(snap.info["@CLIENT VERSION"] ?? "")" } ?? ""))
    var exitCode: Int32 = 0
    for r in snap.refusals {
        log("REFUSED line \(r.line): \(r.reason): \(Writer.shown(r.path))")
        exitCode = 1
    }

    // 4. Whole-restore refusals: `/` beside another reached DIR, or two reached DIRs with one name.
    var reached: [Int] = []
    for row in snap.rows where !reached.contains(row.dirIndex) { reached.append(row.dirIndex) }
    if reached.count > 1 {
        var names: [[UInt8]: Int] = [:]
        for di in reached {
            let d = snap.dirs[di]
            guard let n = d.folderName else {
                throw RestoreFailure("refusing the restore: @SET DIR `/` (line \(d.line)) and another member directory are both reached, and their files would mix")
            }
            let lowered = ParsedPath.windowsLower(n)
            if let other = names[lowered] {
                throw RestoreFailure("refusing the restore: @SET DIR rows on lines \(snap.dirs[other].line) and \(d.line) both want the folder \(Writer.shown(n))")
            }
            names[lowered] = di
        }
    }

    // 5. Restore everything we can, then report.
    let rootBytes = Array(outDir.utf8)
    let writer = Writer(root: rootBytes)
    var deleted: DeletionRecords? = nil
    var restored = 0, skipped = 0, deletedCount = 0, damage = 0, rounded = 0, collisions = 0, failed = 0
    var cache: [String: [UInt8]] = [:]   // content by hash, for a hash the snapshot names more than once

    for row in snap.rows {
        let dir = snap.dirs[row.dirIndex]
        var comps: [[UInt8]] = []
        if let n = dir.folderName { comps.append(n) }
        comps += row.parsed.segments[dir.parsed!.segments.count...]
        let shownDest = Writer.shown(Writer.join([rootBytes] + comps))
        switch writer.precheck(components: comps) {
        case .preexisting:
            log("skipped (already there): \(shownDest)"); skipped += 1; continue
        case .collision(let other):
            log("COLLISION: \(shownDest) was already written by this restore as \(Writer.shown(other)) (line \(row.line))"); collisions += 1; exitCode = 1; continue
        case .inTheWay(let what):
            log("IN THE WAY: \(what): \(shownDest) (line \(row.line))"); failed += 1; exitCode = 1; continue
        case .clear: break
        }
        var content: [UInt8]
        if let c = cache[row.hash] { content = c } else {
            switch try s3.getObject(key: "objects/\(row.hash)") {
            case .ok(let b):
                content = b
            case .missing:
                if deleted == nil {
                    deleted = try DeletionRecords.load(from: s3)
                    for p in deleted!.problems { log("deletion records: \(p)") }
                }
                if let when = deleted!.byHash[row.hash] {
                    log("deleted \(when): \(Writer.shown(row.path)) (object \(row.hash) was deliberately deleted)"); deletedCount += 1
                } else {
                    log("DAMAGE: object \(row.hash) is missing and no deletion record lists it: \(Writer.shown(row.path)) (line \(row.line))"); damage += 1; exitCode = 1
                }
                continue
            case .failed(let status, let code, let msg):
                throw RestoreFailure("stopping: fetching objects/\(row.hash) failed with HTTP \(status) \(code) \(msg)")
            }
            let got = SigV4.hexSHA256(content)
            if got != row.hash {
                log("DAMAGE: objects/\(row.hash) downloaded as \(got) (\(content.count) bytes); withheld: \(Writer.shown(row.path)) (line \(row.line))"); damage += 1; exitCode = 1
                continue
            }
            if content.count <= 4 << 20 { cache[row.hash] = content }
        }
        switch writer.write(components: comps, bytes: content, mtimeMs: row.mtimeMs) {
        case .written(let r):
            restored += 1
            if let r { rounded += 1; log("restored (time rounded by \(r) ms): \(shownDest)") }
            else { log("restored: \(shownDest)") }
        case .timeNotKept(let back):
            restored += 1; exitCode = 1
            log("TIME NOT KEPT: \(shownDest) holds \(back), not \(Instant.format(millis: row.mtimeMs)) (line \(row.line))")
        case .failed(let why):
            failed += 1; exitCode = 1
            log("FAILED: \(why): \(shownDest) (line \(row.line))")
        }
    }
    log("done: \(restored) restored (\(rounded) with a rounded time), \(skipped) skipped as already there, \(deletedCount) deliberately deleted, \(damage) damaged, \(collisions) collisions, \(failed) failed, \(snap.refusals.count) rows refused; \(s3.requestCount) requests, \(s3.retryCount) retries")
    return exitCode
}

do {
    exit(try run())
} catch {
    log("s3cab-restore: \(error)")
    exit(1)
}
