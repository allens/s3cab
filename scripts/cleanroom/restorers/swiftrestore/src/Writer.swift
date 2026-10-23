import Foundation

struct FileID: Hashable { let dev: dev_t; let ino: ino_t }

enum PreCheck {
    case clear
    case preexisting          // there before the restore began: skip, exit 0
    case collision([UInt8])   // this restore already wrote it (under some spelling)
    case inTheWay(String)     // a folder where a file should land, a file or link where a folder should be
}

enum WriteOutcome {
    case written(roundedBy: Int64?)          // nil: time read back exactly; else off by this many ms (< 2 s)
    case timeNotKept(readBack: String)       // written and kept, but the time is off by 2 s or more
    case failed(String)                      // nothing left behind
}

/// Writes restored files under the output directory with POSIX calls on raw bytes:
/// no path normalization, no replacing of anything that was there before.
final class Writer {
    let root: [UInt8]
    private(set) var written: [FileID: [UInt8]] = [:]
    private var tmpCounter = 0

    init(root: [UInt8]) { self.root = root }

    static func cstr(_ p: [UInt8]) -> [CChar] { p.map { CChar(bitPattern: $0) } + [0] }
    static func join(_ parts: [[UInt8]]) -> [UInt8] { Array(parts.joined(separator: [UInt8(ascii: "/")])) }
    static func shown(_ p: [UInt8]) -> String { String(decoding: p, as: UTF8.self) }

    private func lstat(_ p: [UInt8]) -> (stat?, Int32) {
        var st = stat()
        let rc = Darwin.lstat(Writer.cstr(p), &st)
        return rc == 0 ? (st, 0) : (nil, errno)
    }

    /// Looks at every folder on the way and at the destination itself, creating nothing.
    func precheck(components: [[UInt8]]) -> PreCheck {
        var cur = root
        let (rst, rerr) = lstat(cur)
        if let rst {
            if (rst.st_mode & S_IFMT) == S_IFLNK { return .inTheWay("output directory is a symbolic link") }
            if (rst.st_mode & S_IFMT) != S_IFDIR { return .inTheWay("output path is not a directory") }
        } else if rerr != ENOENT { return .inTheWay("output directory: \(String(cString: strerror(rerr)))") }
        else { return .clear }
        for (i, c) in components.enumerated() {
            cur = Writer.join([cur, c])
            let (st, err) = lstat(cur)
            let isLast = i == components.count - 1
            guard let st else {
                if err == ENOENT { return .clear }
                if err == ENOTDIR { return .inTheWay("a file is where a folder should be") }
                return .clear   // let the write report whatever this is
            }
            let fmt = st.st_mode & S_IFMT
            if isLast {
                if fmt == S_IFDIR { return .inTheWay("a folder is where the file should land") }
                let id = FileID(dev: st.st_dev, ino: st.st_ino)
                if let other = written[id] { return .collision(other) }
                return .preexisting
            } else {
                if fmt == S_IFLNK { return .inTheWay("a link is where a folder should be: \(Writer.shown(cur))") }
                if fmt != S_IFDIR { return .inTheWay("a file is where a folder should be: \(Writer.shown(cur))") }
            }
        }
        return .clear
    }

    /// Makes the folders for one file, writes it beside them under a temporary name,
    /// sets its times, then gives it its name without replacing anything. On failure,
    /// removes the folders it made for this file.
    func write(components: [[UInt8]], bytes: [UInt8], mtimeMs: Int64) -> WriteOutcome {
        var made: [[UInt8]] = []
        func undo() { for d in made.reversed() { _ = rmdir(Writer.cstr(d)) } }
        var cur = root
        if case (nil, ENOENT) = lstat(cur) {
            // Make the output directory, and any missing parents, only now that a file is landing.
            var missing: [[UInt8]] = [cur]
            var parent = cur
            while let slash = parent.lastIndex(of: UInt8(ascii: "/")), slash > 0 {
                parent = Array(parent[0..<slash])
                if case (nil, ENOENT) = lstat(parent) { missing.append(parent) } else { break }
            }
            for d in missing.reversed() {
                if mkdir(Writer.cstr(d), 0o755) != 0 { let e = errno; undo(); return .failed("cannot create output directory \(Writer.shown(d)): \(String(cString: strerror(e)))") }
                made.append(d)
            }
        }
        for c in components.dropLast() {
            cur = Writer.join([cur, c])
            let (st, err) = lstat(cur)
            if let st {
                let fmt = st.st_mode & S_IFMT
                if fmt == S_IFLNK { undo(); return .failed("a link is where a folder should be: \(Writer.shown(cur))") }
                if fmt != S_IFDIR { undo(); return .failed("a file is where a folder should be: \(Writer.shown(cur))") }
            } else if err == ENOENT {
                if mkdir(Writer.cstr(cur), 0o755) != 0 { let e = errno; undo(); return .failed("cannot create folder \(Writer.shown(cur)): \(String(cString: strerror(e)))") }
                made.append(cur)
            } else { undo(); return .failed("cannot look at \(Writer.shown(cur)): \(String(cString: strerror(err)))") }
        }
        let dest = Writer.join([cur, components.last!])
        tmpCounter += 1
        let tmp = Writer.join([cur, Array(".s3cab-restore.tmp.\(getpid()).\(tmpCounter)".utf8)])
        let fd = open(Writer.cstr(tmp), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644)
        if fd < 0 { let e = errno; undo(); return .failed("cannot create a temporary file in \(Writer.shown(cur)): \(String(cString: strerror(e)))") }
        var off = 0
        while off < bytes.count {
            let n = bytes[off...].withUnsafeBufferPointer { Darwin.write(fd, $0.baseAddress, $0.count) }
            if n < 0 { let e = errno; close(fd); unlink(Writer.cstr(tmp)); undo(); return .failed("write failed: \(String(cString: strerror(e)))") }
            off += n
        }
        let ts = Instant.timespec(fromMillis: mtimeMs)
        var times = [ts, ts]   // access time to the same instant, as s3cab does
        if futimens(fd, &times) != 0 {
            let e = errno; close(fd); unlink(Writer.cstr(tmp)); undo()
            return .failed("cannot set the modification time: \(String(cString: strerror(e)))")
        }
        if close(fd) != 0 { let e = errno; unlink(Writer.cstr(tmp)); undo(); return .failed("close failed: \(String(cString: strerror(e)))") }
        if s3r_rename_excl(Writer.cstr(tmp), Writer.cstr(dest)) != 0 {
            let e = errno; unlink(Writer.cstr(tmp)); undo()
            if e == EEXIST { return .failed("something appeared at the destination while it was being written") }
            return .failed("the destination won't take this name: \(String(cString: strerror(e)))")
        }
        guard let (st, _) = Optional(lstat(dest)), let st else { return .failed("written, but cannot read it back") }
        written[FileID(dev: st.st_dev, ino: st.st_ino)] = dest
        // Read the time back, rounded to the nearest millisecond.
        let ns = Int64(st.st_mtimespec.tv_sec) * 1_000_000_000 + Int64(st.st_mtimespec.tv_nsec)
        let readMs = Int64((Double(ns) / 1_000_000).rounded())
        let diff = readMs - mtimeMs
        if diff == 0 { return .written(roundedBy: nil) }
        if abs(diff) < 2000 { return .written(roundedBy: diff) }
        return .timeNotKept(readBack: Instant.format(millis: readMs))
    }
}
