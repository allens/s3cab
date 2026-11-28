import Foundation

// s3cab-restore <bucket> <set> <dir> [<snapshot>]
//
// Restores one snapshot of one set from an s3cab repository into <dir>, working only from the
// stored format. Credentials and region come from the environment.
//
// Exit status: 0 when every file row was restored, skipped because a file was already there,
// or deliberately deleted; 1 when anything else happened to a row; 2 when the restore could
// not start or had to stop (a refused snapshot, a failed request, bad arguments).

func rawArguments() -> [[UInt8]] {
    var args = [[UInt8]]()
    for i in 0..<Int(CommandLine.argc) {
        guard let p = CommandLine.unsafeArgv[i] else { continue }
        args.append(Array(UnsafeRawBufferPointer(start: p, count: strlen(p))))
    }
    return args
}

/// Not part of the restorer's contract: prints the sets and snapshots a bucket holds.
func listRepository(bucket: String) throws -> Int32 {
    let s3 = try makeClient(bucket: bucket)
    let top = try s3.list(prefix: "snapshots/", delimiter: "/")
    var sets = Set<String>()
    for p in top.prefixes {
        let name = Array(p.dropFirst("snapshots/".utf8.count).dropLast())
        if isSetName(name) { sets.insert(String(decoding: name, as: UTF8.self)) }
    }
    for k in top.keys {
        let name = Array(k.dropFirst("snapshots/".utf8.count))
        if name.count > 5, Array(name.suffix(5)) == Array(".info".utf8), isSetName(Array(name.dropLast(5))) {
            sets.insert(String(decoding: name.dropLast(5), as: UTF8.self))
        }
    }
    for set in sets.sorted() {
        for name in try snapshotNames(s3, set: set) { say("\(set)\t\(name)") }
    }
    // To stderr, so the list above stays machine-readable: a listing long enough to need
    // every page, and the deletion records.
    let objects = try s3.list(prefix: "objects/", delimiter: "/")
    let records = try s3.list(prefix: "objects.deleted-", delimiter: "/").keys
        .compactMap { strictUTF8($0) }.filter(isDeletionRecordKey)
    complain("\(objects.keys.count) keys directly under objects/; deletion records: \(records.joined(separator: " "))")
    complain("\(s3.requestsSent) requests sent")
    return 0
}

func restore(bucket: String, set: String, output: [UInt8], named: String?) throws -> Int32 {
    let s3 = try makeClient(bucket: bucket)

    let name: String
    if let named {
        name = named
    } else {
        // The latest is the name that sorts last, whatever its upload time or START says.
        guard let latest = try snapshotNames(s3, set: set).last else {
            throw Fatal("set `\(set)` has no snapshot in \(bucket)")
        }
        name = latest
    }
    let key = "snapshots/\(set)/\(name).tsv.gz"

    let stored = MemorySink()
    guard case .found = try s3.fetch(key: key, into: stored) else { throw Fatal("no such snapshot: \(key)") }

    // The whole snapshot is checked before any row of it is restored.
    let snapshot: Snapshot
    do {
        snapshot = try parseSnapshot(text: try gunzipAll(stored.bytes))
    } catch let d as Damaged {
        throw Fatal("\(key) is refused whole, nothing restored: damaged gzip: \(d.message)")
    } catch let r as Refused {
        throw Fatal("\(key) is refused whole, nothing restored: \(r.message)")
    }
    say("\(key): \(snapshot.rows.count) file row(s)")

    let restorer = Restorer(s3: s3, output: output, snapshot: snapshot)
    return try restorer.run()
}

func usage() -> Int32 {
    complain("usage: s3cab-restore <bucket> <set> <dir> [<snapshot>]")
    complain("       s3cab-restore --list <bucket>")
    return 2
}

func run() -> Int32 {
    let args = rawArguments()
    do {
        try startTransport()
        if args.count == 3, args[1] == Array("--list".utf8), isBucketName(args[2]) {
            return try listRepository(bucket: String(decoding: args[2], as: UTF8.self))
        }
        guard args.count == 4 || args.count == 5 else { return usage() }
        guard isBucketName(args[1]) else { throw Fatal("`\(printable(args[1]))` is not a bucket name") }
        guard isSetName(args[2]) else {
            throw Fatal("`\(printable(args[2]))` is not a set name: lowercase letters, digits and hyphens only")
        }
        guard !args[3].isEmpty else { throw Fatal("the output folder is empty") }
        if args.count == 5 {
            guard isSnapshotName(args[4]) else {
                throw Fatal("`\(printable(args[4]))` is not a snapshot name: YYYYMMDDTHHMM")
            }
        }
        return try restore(bucket: String(decoding: args[1], as: UTF8.self), set: String(decoding: args[2], as: UTF8.self),
                           output: args[3], named: args.count == 5 ? String(decoding: args[4], as: UTF8.self) : nil)
    } catch let f as Fatal {
        complain("s3cab-restore: \(f.message)")
        return 2
    } catch {
        complain("s3cab-restore: \(error)")
        return 2
    }
}

exit(run())
