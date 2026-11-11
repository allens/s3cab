import Foundation

struct FileID: Hashable { let dev: dev_t; let ino: ino_t }

enum BadHash { case deleted(Bytes); case missing; case withheld }

struct Counts {
    var restored = 0, skipped = 0, deleted = 0, missing = 0, withheld = 0, refused = 0, collided = 0, inTheWay = 0, timeRounded = 0, timeNotKept = 0
}

// Streams a download into an open file, hashing as it goes. begin() restarts it for a retried attempt.
final class FileSink: BodySink {
    let fd: Int32
    var hasher = SHA256Hasher()
    init(fd: Int32) { self.fd = fd }
    func begin() throws {
        hasher = SHA256Hasher()
        guard ftruncate(fd, 0) == 0, lseek(fd, 0, SEEK_SET) == 0 else { throw S3Error.setup("resetting the temp file failed: \(errnoText())") }
    }
    func write(_ p: UnsafeRawBufferPointer) -> Bool {
        var off = 0
        while off < p.count {
            let n = Foundation.write(fd, p.baseAddress! + off, p.count - off)
            if n < 0 { if s3cab_errno() == EINTR { continue }; return false }
            off += n
        }
        hasher.update(p.baseAddress, p.count)
        return true
    }
}

final class Restorer {
    let s3: S3Client
    let output: Bytes
    let start: Instant?
    var written = Set<FileID>()
    var bad: [Bytes: BadHash] = [:]
    var records: [Bytes: Bytes]? = nil
    var counts = Counts()
    var failed = false
    var outputMade = false

    init(s3: S3Client, output: Bytes, start: Instant?) {
        var o = output
        while o.count > 1, o.last == 0x2F { o.removeLast() }
        self.s3 = s3; self.output = o; self.start = start
    }

    func report(_ what: String, _ path: Bytes) { print("\(what)\t\(display(path))") }

    private func lstatPath(_ p: Bytes) -> stat? {
        var st = stat()
        return lstat(cpath(p), &st) == 0 ? st : nil
    }
    private func isDirFollowing(_ p: Bytes) -> Bool {
        var st = stat()
        return stat(cpath(p), &st) == 0 && (st.st_mode & S_IFMT) == S_IFDIR
    }

    // <output> and every folder above it: made if missing, and may be links.
    private func ensureOutput() throws -> [Bytes] {
        var made: [Bytes] = []
        if output == bytes("/") { return made }
        let parts = output.split(separator: 0x2F, omittingEmptySubsequences: false).map(Array.init)
        var cur = Bytes()
        for (i, part) in parts.enumerated() {
            if i == 0 && part.isEmpty { cur = []; continue }      // absolute path: leading "/"
            if part.isEmpty || part == bytes(".") { if i == 0 { cur = part }; continue }
            cur = cur.isEmpty && parts[0].isEmpty ? [0x2F] + part : (cur.isEmpty ? part : cur + [0x2F] + part)
            if cur == [0x2F] { continue }
            if lstatPath(cur) == nil {
                guard mkdir(cpath(cur), 0o777) == 0 || s3cab_errno() == EEXIST else { throw S3Error.setup("can't create \(display(cur)): \(errnoText())") }
                made.append(cur)
            } else if !isDirFollowing(cur) {
                throw S3Error.setup("\(display(cur)) is in the way of the output folder")
            }
        }
        return made
    }

    private func cleanup(made: [Bytes]) {
        for p in made.reversed() { _ = rmdir(cpath(p)) }
    }

    private func fail(_ what: String, _ path: Bytes) { failed = true; report(what, path) }

    private func deliberatelyDeleted(_ hashHex: Bytes) throws -> Bytes? {
        if records == nil { records = try loadDeletionRecords(s3) }
        guard let st = start, let inst = records![hashHex] else { return nil }
        return st.text.lexicographicallyPrecedes(inst) ? inst : nil
    }

    func run(_ snap: Snapshot) throws {
        for row in snap.rows {
            switch row {
            case .refused(_, let path, let reason):
                counts.refused += 1; fail("refused (\(reason))", path)
            case .restore(let r):
                try restoreOne(r)
            }
        }
    }

    private func restoreOne(_ r: FileRow) throws {
        var components: [Bytes] = []
        if let root = r.parsed.rootFolder { components.append(root) }
        components.append(contentsOf: r.parsed.segments)
        let dest = output + [0x2F] + Array(components.joined(separator: [0x2F]))
        let hashKey = bytes(r.hashHex)

        // The destination first: fetch nothing for a row that is skipped.
        if let st = lstatPath(dest) {
            let id = FileID(dev: st.st_dev, ino: st.st_ino)
            if written.contains(id) {
                if let b = bad[hashKey] { reportBad(b, r.path); return }
                counts.collided += 1; fail("collision (another row already landed here)", r.path); return
            }
            if (st.st_mode & S_IFMT) == S_IFDIR { counts.inTheWay += 1; fail("in the way (a folder where the file should land)", r.path); return }
            counts.skipped += 1; report("skipped (already there before the restore)", r.path); return
        }
        if let b = bad[hashKey] { reportBad(b, r.path); return }

        // Folders, made only as the file lands; a failure removes what was made.
        var made: [Bytes] = []
        do { made = try ensureOutput() } catch { fail("in the way (\(error))", r.path); counts.inTheWay += 1; return }
        var cur = output
        for comp in components.dropLast() {
            cur = cur + [0x2F] + comp
            if let st = lstatPath(cur) {
                let t = st.st_mode & S_IFMT
                if t == S_IFLNK { counts.inTheWay += 1; fail("in the way (a link where a folder should be: \(display(cur)))", r.path); cleanup(made: made); return }
                if t != S_IFDIR { counts.inTheWay += 1; fail("in the way (a file where a folder should be: \(display(cur)))", r.path); cleanup(made: made); return }
            } else {
                guard mkdir(cpath(cur), 0o777) == 0 else { counts.inTheWay += 1; fail("can't make folder \(display(cur)): \(errnoText())", r.path); cleanup(made: made); return }
                made.append(cur)
            }
        }
        let parent = cur
        let temp = parent + bytes("/.s3cab-restore.\(getpid()).tmp")
        _ = unlink(cpath(temp))
        let fd = open(cpath(temp), O_WRONLY | O_CREAT | O_EXCL, 0o644)
        guard fd >= 0 else { fail("can't create a temp file in \(display(parent)): \(errnoText())", r.path); cleanup(made: made); return }
        var keepTemp = false
        defer { if !keepTemp { close(fd); _ = unlink(cpath(temp)); cleanup(made: made) } }

        let sink = FileSink(fd: fd)
        switch try s3.get(key: "objects/\(r.hashHex)", sink: sink) {
        case .miss:
            if let when = try deliberatelyDeleted(hashKey) {
                bad[hashKey] = .deleted(when); reportBad(.deleted(when), r.path)
            } else {
                bad[hashKey] = .missing; reportBad(.missing, r.path)
            }
            return
        case .ok: break
        }
        let got = sink.hasher.finish()
        guard got == r.hash else { bad[hashKey] = .withheld; reportBad(.withheld, r.path); return }

        var times = [timespec(tv_sec: Int(r.mtime.unixSeconds), tv_nsec: r.mtime.millis * 1_000_000),
                     timespec(tv_sec: Int(r.mtime.unixSeconds), tv_nsec: r.mtime.millis * 1_000_000)]
        let timeSet = futimens(fd, &times) == 0
        let timeErr = timeSet ? "" : errnoText()
        guard close(fd) == 0 else { keepTemp = true; _ = unlink(cpath(temp)); cleanup(made: made); fail("closing the file failed: \(errnoText())", r.path); return }
        keepTemp = true
        guard s3cab_rename_noreplace(cpath(temp), cpath(dest)) == 0 else {
            let e = s3cab_errno()
            _ = unlink(cpath(temp)); cleanup(made: made)
            if e == EEXIST { counts.inTheWay += 1; fail("in the way (something appeared at the destination during the restore)", r.path) }
            else { fail("can't place the file: \(String(cString: strerror(e)))", r.path) }
            return
        }
        counts.restored += 1
        guard let st = lstatPath(dest) else { fail("restored, but can't stat it back: \(errnoText())", r.path); return }
        written.insert(FileID(dev: st.st_dev, ino: st.st_ino))
        // Read the time back, compared rounded to the millisecond.
        let backMs = Int64(st.st_mtimespec.tv_sec) * 1000 + Int64((st.st_mtimespec.tv_nsec + 500_000) / 1_000_000)
        let diff = backMs - r.mtime.milliseconds
        if !timeSet {
            counts.timeNotKept += 1; fail("restored, but its time couldn't be set (\(timeErr)); it has \(formatMs(backMs))", r.path)
        } else if diff == 0 {
            report("restored", r.path)
        } else if abs(diff) < 2000 {
            counts.timeRounded += 1; report("restored (time rounded by the disk to \(formatMs(backMs)))", r.path)
        } else {
            counts.timeNotKept += 1; fail("restored, but the destination didn't keep its time: it has \(formatMs(backMs))", r.path)
        }
    }

    private func reportBad(_ b: BadHash, _ path: Bytes) {
        switch b {
        case .deleted(let when): counts.deleted += 1; report("deleted deliberately on \(String(decoding: when, as: UTF8.self))", path)
        case .missing: counts.missing += 1; fail("missing (object absent, no deletion record explains it: damage)", path)
        case .withheld: counts.withheld += 1; fail("withheld (download doesn't hash to its key: damage)", path)
        }
    }

    func summary() -> String {
        let c = counts
        return "restored \(c.restored), skipped \(c.skipped), deliberately deleted \(c.deleted), missing \(c.missing), withheld \(c.withheld), refused \(c.refused), collisions \(c.collided), in the way \(c.inTheWay), time rounded by the disk \(c.timeRounded), time not kept \(c.timeNotKept)"
    }
}

func formatMs(_ ms: Int64) -> String {
    var secs = ms / 1000; var rem = ms % 1000
    if rem < 0 { rem += 1000; secs -= 1 }
    var t = time_t(secs); var tm = tm()
    gmtime_r(&t, &tm)
    return String(format: "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec, Int(rem))
}
