import Foundation

// Writing the restored files. Every name goes to the system as raw bytes through the POSIX
// calls, relative to an open folder, so nothing normalizes a name and no link is followed
// below the output folder.

/// A download written to an open file and hashed as it arrives.
final class HashingFileSink: BodySink {
    private let fd: Int32
    private var ctx = CC_SHA256_CTX()

    init(fd: Int32) {
        self.fd = fd
        CC_SHA256_Init(&ctx)
    }

    func reset() -> Bool {
        CC_SHA256_Init(&ctx)
        return ftruncate(fd, 0) == 0 && lseek(fd, 0, SEEK_SET) == 0
    }

    func write(_ b: UnsafeRawBufferPointer) -> Bool {
        CC_SHA256_Update(&ctx, b.baseAddress, CC_LONG(b.count))
        var off = 0
        while off < b.count {
            let n = Darwin.write(fd, b.baseAddress! + off, b.count - off)
            if n < 0 && errno == EINTR { continue }
            if n <= 0 { return false }
            off += n
        }
        return true
    }

    func digest() -> String {
        var d = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        CC_SHA256_Final(&d, &ctx)
        return hexString(d)
    }
}

struct FileIdentity: Hashable {
    let device: Int32
    let inode: UInt64
}

/// What is already known about an object that could not be restored.
enum Unrestorable {
    case deleted(at: String)    // a deletion record explains it: not damage
    case missing                // not in the bucket, and nothing explains it: damage
    case withheld               // what came back doesn't hash to the key: damage
}

final class Restorer {
    private let s3: S3Client
    private let output: [UInt8]
    private let snapshot: Snapshot

    private var written = Set<FileIdentity>()
    private var unrestorable = [String: Unrestorable]()
    private var deletions: [String: String]? = nil      // hash -> its newest row's instant

    private(set) var restored = 0
    private(set) var skipped = 0
    private(set) var deliberatelyDeleted = 0
    private(set) var timesRounded = 0
    private(set) var failures = 0

    init(s3: S3Client, output: [UInt8], snapshot: Snapshot) {
        self.s3 = s3
        var o = output
        while o.count > 1 && o.last == 0x2F { o.removeLast() }
        self.output = o
        self.snapshot = snapshot
    }

    /// Restores every row it can, reports the rest, and returns the exit status.
    func run() throws -> Int32 {
        for row in snapshot.rows {
            if let why = row.refusal {
                failures += 1
                complain("refused: line \(row.line): \(why): \(printable(row.path))")
                continue
            }
            do {
                try restore(row)
            } catch let stop as Fatal {
                // Not a verdict on this file: the bucket can't be read, so nothing after it is tried.
                say("stopped at line \(row.line) of \(snapshot.lineCount): restored \(restored), skipped \(skipped) already there, "
                    + "\(deliberatelyDeleted) deliberately deleted, \(failures) failed, and the rest not tried")
                throw stop
            }
        }
        say("restored \(restored), skipped \(skipped) already there, \(deliberatelyDeleted) deliberately deleted, \(failures) failed")
        if timesRounded > 0 {
            say("\(timesRounded) restored file(s) hold a time the disk rounded, by less than 2 seconds")
        }
        return failures == 0 ? 0 : 1
    }

    // MARK: deletion records, read only once a fetch misses

    private func loadDeletions() throws -> [String: String] {
        if let deletions { return deletions }
        var newest = [String: String]()
        let listing = try s3.list(prefix: "objects.deleted-", delimiter: "/")
        for keyBytes in listing.keys {
            guard let key = strictUTF8(keyBytes), isDeletionRecordKey(key) else { continue }
            let sink = MemorySink()
            switch try s3.fetch(key: key, into: sink) {
            case .missing:
                complain("warning: deletion record \(key) was listed and is gone: it explains nothing")
            case .found:
                let record = parseDeletionRecord(sink.bytes)
                if !record.faults.isEmpty {
                    complain("warning: deletion record \(key) is not valid (\(record.faults.joined(separator: "; "))): only its well-formed rows count")
                }
                for (hash, instant) in record.rows {
                    if let have = newest[hash], !have.utf8.lexicographicallyPrecedes(instant.utf8) { continue }
                    newest[hash] = instant
                }
            }
        }
        deletions = newest
        return newest
    }

    /// A miss is deliberate only when a record's row for the hash is dated after the
    /// snapshot's START, both compared as text.
    private func judgeMiss(_ hash: String) throws -> Unrestorable {
        let records = try loadDeletions()
        if let start = snapshot.start, let when = records[hash], start.text.utf8.lexicographicallyPrecedes(when.utf8) {
            return .deleted(at: when)
        }
        return .missing
    }

    private func report(_ row: FileRow, _ state: Unrestorable) {
        let path = printable(row.path)
        switch state {
        case .deleted(let at):
            deliberatelyDeleted += 1
            say("deleted: \(path): deliberately deleted on \(at), so not restored")
        case .missing:
            failures += 1
            complain("missing: \(path): objects/\(row.hash) is not in the bucket, and no deletion record explains it")
        case .withheld:
            failures += 1
            complain("withheld: \(path): what objects/\(row.hash) holds does not hash to its key")
        }
    }

    // MARK: one row

    private enum Destination {
        case free(existingFolders: Int)     // nothing there; this many of its folders exist
        case thereBefore                    // a file that was there before the restore
        case writtenByUs                    // a file this restore wrote
        case inTheWay(String)
        case unusable(String)               // the destination can't be looked at
    }

    /// Looks at the destination without changing it. `fds` gets the output folder and then
    /// each existing folder on the way down, opened without following a link.
    private func look(_ parts: [[UInt8]], fds: inout [Int32]) -> Destination {
        let root = withCPath(output) { open($0, O_RDONLY | O_DIRECTORY | O_CLOEXEC) }
        if root < 0 {
            switch errno {
            case ENOENT: return .free(existingFolders: -1)
            case ENOTDIR: return .inTheWay("a file is at the output folder itself")
            default: return .unusable("the output folder can't be opened: \(errnoText(errno))")
            }
        }
        fds.append(root)
        var st = stat()
        for i in 0..<(parts.count - 1) {
            let name = printable(parts[i])
            if withCPath(parts[i], { fstatat(fds[i], $0, &st, AT_SYMLINK_NOFOLLOW) }) != 0 {
                if errno == ENOENT { return .free(existingFolders: i) }
                return .unusable("folder `\(name)`: \(errnoText(errno))")
            }
            switch st.st_mode & S_IFMT {
            case S_IFDIR:
                let fd = withCPath(parts[i]) { openat(fds[i], $0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) }
                if fd < 0 { return .unusable("folder `\(name)`: \(errnoText(errno))") }
                fds.append(fd)
            case S_IFLNK:
                return .inTheWay("a link is where its folder `\(name)` should be")
            default:
                return .inTheWay("a file is where its folder `\(name)` should be")
            }
        }
        if withCPath(parts[parts.count - 1], { fstatat(fds[parts.count - 1], $0, &st, AT_SYMLINK_NOFOLLOW) }) != 0 {
            if errno == ENOENT { return .free(existingFolders: parts.count - 1) }
            return .unusable(errnoText(errno))
        }
        if st.st_mode & S_IFMT == S_IFDIR { return .inTheWay("a folder is where the file should land") }
        // A link at the file's own name is a file already there, like anything else that isn't a folder.
        return written.contains(FileIdentity(device: st.st_dev, inode: st.st_ino)) ? .writtenByUs : .thereBefore
    }

    /// Makes the output folder and any missing folder above it; returns what it made, deepest last.
    private func makeOutputFolder() -> (made: [[UInt8]], error: String?) {
        var missing = [[UInt8]]()
        var p = output
        var st = stat()
        while true {
            if withCPath(p, { stat($0, &st) }) == 0 { break }
            if errno != ENOENT { return ([], "\(printable(p)): \(errnoText(errno))") }
            missing.append(p)
            guard let cut = p.lastIndex(of: 0x2F), cut > 0 else { break }   // the parent is `/` or the current folder
            p = Array(p[0..<cut])
            while p.count > 1 && p.last == 0x2F { p.removeLast() }
        }
        var made = [[UInt8]]()
        for q in missing.reversed() {
            if withCPath(q, { mkdir($0, 0o777) }) != 0 {
                let e = errno
                for m in made.reversed() { _ = withCPath(m) { rmdir($0) } }
                return ([], "\(printable(q)): \(errnoText(e))")
            }
            made.append(q)
        }
        return (made, nil)
    }

    private func restore(_ row: FileRow) throws {
        let parts = row.landing
        let shown = printable(row.path)
        var fds = [Int32]()
        defer { for fd in fds { close(fd) } }

        // The destination first: a file there before the restore is skipped, and a skip
        // fetches nothing, so it wins over a hash already known to be unrestorable.
        let destination = look(parts, fds: &fds)
        if case .thereBefore = destination {
            skipped += 1
            say("skipped: \(shown): a file was already there")
            return
        }
        if let known = unrestorable[row.hash] {
            report(row, known)
            return
        }
        let existingFolders: Int
        switch destination {
        case .thereBefore:
            return
        case .writtenByUs:
            failures += 1
            complain("collision: \(shown): lands on a file an earlier row of this restore wrote")
            return
        case .inTheWay(let what):
            failures += 1
            complain("in the way: \(shown): \(what)")
            return
        case .unusable(let what):
            failures += 1
            complain("failed: \(shown): \(what)")
            return
        case .free(let n):
            existingFolders = n
        }

        // Folders are made only as a file lands in them, and unmade if it doesn't.
        var madeOutput = [[UInt8]]()
        var madeFolders = 0             // parts[existingFolders ..< existingFolders + madeFolders]
        var temp: [UInt8]? = nil
        var landed = false
        defer {
            if !landed {
                if let temp, let dir = fds.last { _ = withCPath(temp) { unlinkat(dir, $0, 0) } }
                let first = max(existingFolders, 0)
                for i in (first..<(first + madeFolders)).reversed() {
                    _ = withCPath(parts[i]) { unlinkat(fds[i], $0, AT_REMOVEDIR) }
                }
                for m in madeOutput.reversed() { _ = withCPath(m) { rmdir($0) } }
            }
        }

        if existingFolders < 0 {
            let (made, error) = makeOutputFolder()
            if let error {
                failures += 1
                complain("failed: \(shown): the output folder can't be made: \(error)")
                return
            }
            madeOutput = made
            let root = withCPath(output) { open($0, O_RDONLY | O_DIRECTORY | O_CLOEXEC) }
            if root < 0 {
                failures += 1
                complain("failed: \(shown): the output folder can't be opened: \(errnoText(errno))")
                return
            }
            fds.append(root)
        }
        for i in max(existingFolders, 0)..<(parts.count - 1) {
            if withCPath(parts[i], { mkdirat(fds[i], $0, 0o777) }) != 0 {
                failures += 1
                complain("failed: \(shown): the destination won't make folder `\(printable(parts[i]))`: \(errnoText(errno))")
                return
            }
            madeFolders += 1
            let fd = withCPath(parts[i]) { openat(fds[i], $0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) }
            if fd < 0 {
                failures += 1
                complain("failed: \(shown): folder `\(printable(parts[i]))`: \(errnoText(errno))")
                return
            }
            fds.append(fd)
        }
        let dir = fds[parts.count - 1]
        let name = parts[parts.count - 1]

        // Download beside the destination, under a name nobody can predict, created exclusively.
        var nonce = [UInt8](repeating: 0, count: 12)
        arc4random_buf(&nonce, nonce.count)
        let tempName = Array(".s3cab-restore-\(hexString(nonce)).part".utf8)
        let fd = withCPath(tempName) { openat(dir, $0, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o666) }
        if fd < 0 {
            failures += 1
            complain("failed: \(shown): the destination won't create a file in its folder: \(errnoText(errno))")
            return
        }
        temp = tempName
        defer { close(fd) }

        let sink = HashingFileSink(fd: fd)
        switch try s3.fetch(key: "objects/\(row.hash)", into: sink) {
        case .missing:
            let state = try judgeMiss(row.hash)
            unrestorable[row.hash] = state
            report(row, state)
            return
        case .found:
            break
        }
        // The hash decides; the size column is never compared with the download.
        guard sink.digest() == row.hash else {
            unrestorable[row.hash] = .withheld
            report(row, .withheld)
            return
        }

        // The stored time, to the millisecond, through a nanosecond interface; the access time the same.
        let instant = row.instant!
        let t = timespec(tv_sec: Int(instant.seconds), tv_nsec: instant.millis * 1_000_000)
        var times = [t, t]
        let timeSet = futimens(fd, &times) == 0
        let timeError = errno

        // Give it its name without replacing anything that turned up there meanwhile.
        if withCPath(tempName, { from in withCPath(name) { to in renameatx_np(dir, from, dir, to, UInt32(RENAME_EXCL)) } }) != 0 {
            let e = errno
            failures += 1
            if e == EEXIST {
                complain("failed: \(shown): something appeared at the destination while the file was downloading")
            } else {
                complain("failed: \(shown): the destination won't take the name: \(errnoText(e))")
            }
            return
        }
        landed = true
        restored += 1

        // Read the time back from the file as it now stands.
        var st = stat()
        guard withCPath(name, { fstatat(dir, $0, &st, AT_SYMLINK_NOFOLLOW) }) == 0 else {
            failures += 1
            complain("failed: \(shown): restored, but it can't be read back: \(errnoText(errno))")
            return
        }
        written.insert(FileIdentity(device: st.st_dev, inode: st.st_ino))
        let has = Int64(st.st_mtimespec.tv_sec) * 1000 + Int64(st.st_mtimespec.tv_nsec + 500_000) / 1_000_000
        let off = abs(has - instant.totalMillis)
        if !timeSet {
            failures += 1
            complain("time not kept: \(shown): the destination refused \(instant.text) (\(errnoText(timeError))); the file is kept, with the time "
                + formatTime(seconds: Int64(st.st_mtimespec.tv_sec), nanos: st.st_mtimespec.tv_nsec))
        } else if off >= 2000 {
            failures += 1
            complain("time not kept: \(shown): stored \(instant.text), but the file is kept with the time "
                + formatTime(seconds: Int64(st.st_mtimespec.tv_sec), nanos: st.st_mtimespec.tv_nsec))
        } else if off != 0 {
            timesRounded += 1
        }
    }
}
