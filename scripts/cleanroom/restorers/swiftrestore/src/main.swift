import Foundation
import CryptoKit

func usage() -> Never {
    eprint("usage: s3cab-restore <bucket> <set> <dir> [<snapshot>]")
    eprint("  credentials from AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN; region from AWS_REGION")
    exit(2)
}

/// Development aid: list the sets, their snapshots, and the root-level deletion records, with this program's own signed requests.
func listRepository(bucket: String) -> Int32 {
    let env = ProcessInfo.processInfo.environment
    guard let ak = env["AWS_ACCESS_KEY_ID"], let sk = env["AWS_SECRET_ACCESS_KEY"] else { eprint("error: no credentials in the environment"); return 2 }
    let creds = Credentials(accessKey: ak, secretKey: sk, sessionToken: env["AWS_SESSION_TOKEN"], region: env["AWS_REGION"] ?? "us-east-1")
    let client = S3Client(creds: creds, bucket: bucket, verbose: env["S3CAB_RESTORE_VERBOSE"] == "1")
    do {
        let root = try client.listKeysAndPrefixes(prefix: "")
        oprint("root keys: \(root.keys)")
        oprint("root folders: \(root.prefixes)")
        let setsLevel = try client.listKeysAndPrefixes(prefix: "snapshots/")
        oprint("snapshots/ keys: \(setsLevel.keys)")
        oprint("snapshots/ folders: \(setsLevel.prefixes)")
        for p in setsLevel.prefixes {
            let keys = try client.listKeys(prefix: p)
            oprint("  \(p): \(keys.map { String($0.dropFirst(p.count)) })")
        }
        for k in root.keys where k.hasPrefix("objects.deleted-") {
            if case .found(let b) = try client.getObject(key: k) {
                oprint("--- \(k) (\(b.count) bytes):")
                oprint(String(decoding: b, as: UTF8.self))
            }
        }
    } catch { eprint("error: \(error)"); return 1 }
    return 0
}

/// Development aid: decompress and parse a snapshot file on disk, with no network, and print what a restore would do with it.
func parseLocal(path: String) -> Int32 {
    guard let data = FileManager.default.contents(atPath: path) else { eprint("error: cannot read \(path)"); return 2 }
    let text: Bytes
    do { text = try gunzipAll(Array(data)) }
    catch let e as GzipDamaged { oprint("DAMAGED: \(e.reason)"); return 1 }
    catch { oprint("DAMAGED: \(error)"); return 1 }
    let snap: Snapshot
    do { snap = try parseSnapshot(text) }
    catch let e as RefuseWhole { oprint("REFUSED WHOLE: \(e.reason)"); return 1 }
    catch { oprint("REFUSED WHOLE: \(error)"); return 1 }
    oprint("dirs: \(snap.dirs.map { String(decoding: $0.raw, as: UTF8.self) + ($0.usable ? "" : " (matches nothing)") })")
    oprint("start: \(snap.start ?? "(none)") rows: \(snap.fileRowCount) restorable: \(snap.rows.count) refused: \(snap.refused.count)")
    for r in snap.refused { oprint("refused line \(r.line): \(r.reason): \(r.pathString)") }
    for r in snap.rows {
        let dest = destinationComponents(r.parsed).map { String(decoding: $0, as: UTF8.self) }.joined(separator: "/")
        oprint("restore line \(r.line): \(r.pathString) -> <output>/\(dest) mtime=\(r.mtimeMs)")
    }
    return snap.refused.isEmpty ? 0 : 1
}

func run() -> Int32 {
    var args = CommandLine.arguments
    if args.count == 3 && args[2] == "--list" { return listRepository(bucket: args[1]) }
    if args.count == 3 && args[1] == "--parse" { return parseLocal(path: args[2]) }
    if args.count >= 3 && args[1] == "--records" {   // development aid: parse deletion record files on disk, no network
        var recs = DeletionRecords()
        for p in args.dropFirst(2) {
            guard let d = FileManager.default.contents(atPath: p) else { eprint("error: cannot read \(p)"); return 2 }
            recs.add(record: p, bytes: Array(d))
        }
        oprint("files: \(recs.files) rows: \(recs.rows) malformed: \(recs.malformed)")
        for (h, i) in recs.newest.sorted(by: { $0.key < $1.key }) { oprint("\(h) \(i)") }
        return 0
    }
    // Development aid: `--local <snapshot.tsv.gz> <bucket> <dir>` reads a snapshot file from disk and fetches its objects from the real bucket.
    var localFile: String? = nil
    if args.count == 5 && args[1] == "--local" { localFile = args[2]; args = [args[0], args[3], "(local)", args[4], "(local)"] }
    guard args.count == 4 || args.count == 5 else { usage() }
    let bucket = args[1]
    let set = args[2]
    let outputDir = Array(args[3].utf8)
    var wantedSnapshot: String? = args.count == 5 ? args[4] : nil
    if let w = wantedSnapshot, w.hasSuffix(".tsv.gz") { wantedSnapshot = String(w.dropLast(7)) }

    let env = ProcessInfo.processInfo.environment
    guard let ak = env["AWS_ACCESS_KEY_ID"], let sk = env["AWS_SECRET_ACCESS_KEY"], !ak.isEmpty, !sk.isEmpty else {
        eprint("error: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set"); return 2
    }
    let region = env["AWS_REGION"] ?? env["AWS_DEFAULT_REGION"] ?? "us-east-1"
    let creds = Credentials(accessKey: ak, secretKey: sk, sessionToken: env["AWS_SESSION_TOKEN"], region: region)
    let client = S3Client(creds: creds, bucket: bucket, verbose: env["S3CAB_RESTORE_VERBOSE"] == "1")

    // 1. Which snapshot.
    let snapshotName: String
    do {
        if let w = wantedSnapshot {
            snapshotName = w
        } else {
            let prefix = "snapshots/\(set)/"
            let keys = try client.listKeys(prefix: prefix)
            let names = keys.compactMap { key -> String? in
                guard key.hasPrefix(prefix) else { return nil }
                let name = String(key.dropFirst(prefix.count))
                let u = Array(name.utf8)
                // exactly YYYYMMDDTHHMM.tsv.gz: digits in those places and nothing more
                guard u.count == 20, u[8] == 0x54, Array(u[13...]) == Array(".tsv.gz".utf8) else { return nil }
                for i in [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12] where !(u[i] >= 0x30 && u[i] <= 0x39) { return nil }
                return String(name.dropLast(7))
            }
            guard let latest = names.max(by: { bytesLess(Array($0.utf8), Array($1.utf8)) }) else {
                eprint("error: no snapshot found under \(prefix) (\(keys.count) keys listed there)"); return 1
            }
            oprint("latest snapshot of set '\(set)': \(latest) (of \(names.count))")
            snapshotName = latest
        }
    } catch {
        eprint("error: \(error)"); return 1
    }

    // 2. Fetch and decompress it.
    let snapshotKey = localFile ?? "snapshots/\(set)/\(snapshotName).tsv.gz"
    let text: Bytes
    do {
        let fetched: GetResult
        if let lf = localFile {
            guard let d = FileManager.default.contents(atPath: lf) else { eprint("error: cannot read \(lf)"); return 2 }
            fetched = .found(Array(d))
        } else {
            fetched = try client.getObject(key: snapshotKey)
        }
        switch fetched {
        case .missing(let code):
            eprint("error: snapshot \(snapshotKey) is not in the bucket (\(code))"); return 1
        case .found(let gz):
            do { text = try gunzipAll(gz) }
            catch let e as GzipDamaged { eprint("error: snapshot \(snapshotKey) is damaged: \(e.reason)"); return 1 }
            oprint("snapshot \(snapshotKey): \(gz.count) bytes compressed, \(text.count) decompressed")
            if let dump = env["S3CAB_RESTORE_DUMP"], !dump.isEmpty {   // development aid: keep the decompressed text
                let fd = open(dump, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
                if fd >= 0 { _ = text.withUnsafeBufferPointer { Darwin.write(fd, $0.baseAddress, $0.count) }; close(fd) } else { eprint("note: could not write dump \(dump): \(errnoText())") }
            }
        }
    } catch {
        eprint("error: \(error)"); return 1
    }

    // 3. Parse and validate.
    let snap: Snapshot
    do { snap = try parseSnapshot(text) }
    catch let e as RefuseWhole { eprint("error: snapshot \(snapshotKey) refused whole: \(e.reason)"); return 1 }
    catch { eprint("error: \(error)"); return 1 }
    oprint("member directories: \(snap.dirs.map { String(decoding: $0.raw, as: UTF8.self) + ($0.usable ? "" : " (matches nothing)") })")
    oprint("START: \(snap.start ?? "(none)"); file rows: \(snap.fileRowCount); restorable: \(snap.rows.count); refused: \(snap.refused.count)")
    for r in snap.refused { oprint("refused   line \(r.line): \(r.reason): \(r.pathString)") }

    // 4. Restore every row it can.
    let writer = Writer(output: outputDir)
    var records: DeletionRecords? = nil
    var badHashes = Set<String>()
    var nRestored = 0, nSkipped = 0, nDeleted = 0, nDamaged = 0, nCollision = 0, nInTheWay = 0, nRounded = 0, nTimeNotHeld = 0
    var exitCode: Int32 = snap.refused.isEmpty ? 0 : 1

    func loadRecords() throws -> DeletionRecords {
        var recs = DeletionRecords()
        let keys = try client.listKeys(prefix: "")
        let recordKeys = keys.filter { key in
            guard key.hasPrefix("objects.deleted-"), key.hasSuffix(".tsv") else { return false }
            let n = key.dropFirst("objects.deleted-".count).dropLast(4)
            let u = Array(n.utf8)
            return !u.isEmpty && u[0] != 0x30 && u.allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
        }.sorted()
        for k in recordKeys {
            switch try client.getObject(key: k) {
            case .found(let b): recs.add(record: k, bytes: b)
            case .missing: recs.invalidFiles.append(k)      // listed but gone: explains nothing
            }
        }
        oprint("deletion records: \(recordKeys.count) files, \(recs.rows) well-formed #deleted rows, \(recs.malformed) malformed lines\(recs.invalidFiles.isEmpty ? "" : ", gone: \(recs.invalidFiles)")")
        return recs
    }

    for row in snap.rows {
        let comps = destinationComponents(row.parsed)
        let label = row.pathString
        let check = writer.checkDestination(components: comps)
        var outcome: Outcome
        switch check {
        case .skippedExisting:
            outcome = .skippedExisting
        case .collision:
            outcome = .collision
        case .inTheWay(let why):
            outcome = .inTheWay(why)
        case .ok(let missing, let dest):
            if badHashes.contains(row.hash) {
                outcome = .damaged("object \(row.hash) already failed its hash check")
            } else {
                do {
                    switch try client.getObject(key: "objects/\(row.hash)") {
                    case .missing:
                        if records == nil { records = try loadRecords() }
                        if let when = records!.deletionDate(hash: row.hash, start: snap.start) {
                            outcome = .deliberatelyDeleted(when)
                        } else {
                            outcome = .damaged("object objects/\(row.hash) is missing and no deletion record later than START explains it")
                        }
                    case .found(let content):
                        let got = sha256Hex(content)
                        if got != row.hash {
                            badHashes.insert(row.hash)
                            outcome = .damaged("download of objects/\(row.hash) hashes to \(got); withheld")
                        } else {
                            outcome = writer.write(dest: dest, missingFolders: missing, content: content, mtimeMs: row.mtimeMs)
                        }
                    }
                } catch {
                    eprint("error: restore stopped: \(error)")
                    eprint("restored \(nRestored) of \(snap.rows.count) restorable rows before stopping")
                    return 1
                }
            }
        }
        switch outcome {
        case .restored: nRestored += 1; oprint("restored  \(label)")
        case .timeOffByRounding(let ms): nRestored += 1; nRounded += 1; oprint("restored  \(label)  (time off by \(ms) ms: disk rounding)")
        case .timeNotHeld(let why): nRestored += 1; nTimeNotHeld += 1; exitCode = 1; oprint("time      \(label)  not held: \(why)")
        case .skippedExisting: nSkipped += 1; oprint("skipped   \(label)  (already there before the restore)")
        case .deliberatelyDeleted(let when): nDeleted += 1; oprint("deleted   \(label)  (deliberately deleted \(when))")
        case .damaged(let why): nDamaged += 1; exitCode = 1; oprint("DAMAGE    \(label)  \(why)")
        case .collision: nCollision += 1; exitCode = 1; oprint("collision \(label)  (another row already landed on this file)")
        case .inTheWay(let why): nInTheWay += 1; exitCode = 1; oprint("in the way \(label)  \(why)")
        }
    }

    oprint("done: \(nRestored) restored (\(nRounded) with disk-rounded times, \(nTimeNotHeld) with a time not held), \(nSkipped) skipped as already there, \(nDeleted) deliberately deleted, \(nDamaged) damaged, \(nCollision) collisions, \(nInTheWay) in the way, \(snap.refused.count) rows refused; \(client.requestCount) requests; exit \(exitCode)")
    return exitCode
}

exit(run())
