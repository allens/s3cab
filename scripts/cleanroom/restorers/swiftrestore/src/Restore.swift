import Foundation

struct FileID: Hashable { let dev: Int32; let ino: UInt64 }

enum Outcome {
    case restored
    case skippedExisting
    case deliberatelyDeleted(String)
    case damaged(String)
    case collision
    case inTheWay(String)
    case timeOffByRounding(Int64)
    case timeNotHeld(String)
}

func cPath(_ b: Bytes) -> [CChar] {
    return b.map { CChar(bitPattern: $0) } + [0]
}

func lstatPath(_ p: Bytes) -> stat? {
    var st = stat()
    let rc = cPath(p).withUnsafeBufferPointer { lstat($0.baseAddress!, &st) }
    return rc == 0 ? st : nil
}
func statPath(_ p: Bytes) -> stat? {
    var st = stat()
    let rc = cPath(p).withUnsafeBufferPointer { stat($0.baseAddress!, &st) }
    return rc == 0 ? st : nil
}
func isDir(_ st: stat) -> Bool { (st.st_mode & S_IFMT) == S_IFDIR }
func isLink(_ st: stat) -> Bool { (st.st_mode & S_IFMT) == S_IFLNK }

func errnoText() -> String { String(cString: strerror(errno)) }

/// Writes restored files under <output> with raw POSIX calls, tracking what this run wrote.
final class Writer {
    let output: Bytes
    var written = Set<FileID>()
    var tmpCounter = 0

    init(output: Bytes) {
        var o = output
        while o.count > 1 && o.last == 0x2F { o.removeLast() }
        self.output = o
    }

    func join(_ base: Bytes, _ name: Bytes) -> Bytes { base + [0x2F] + name }

    enum DestinationCheck {
        case ok(missingFolders: [Bytes], dest: Bytes)
        case skippedExisting
        case collision
        case inTheWay(String)
    }

    /// Checked before anything is fetched, as s3cab does.
    func checkDestination(components: [Bytes]) -> DestinationCheck {
        var missing: [Bytes] = []
        var cur = output
        if let st = lstatPath(output) {
            if !isDir(st) {
                if isLink(st), let t = statPath(output), isDir(t) { /* <output> itself may be a link to a folder */ }
                else { return .inTheWay("the output directory is not a directory") }
            }
        } else {
            // <output> and any missing parents of it are made when the first file lands (the spec is silent on parents; tool's choice).
            var parents: [Bytes] = []
            var p = output
            while let slash = p.lastIndex(of: 0x2F), slash > 0 {
                p = Array(p[0..<slash])
                if lstatPath(p) != nil { break }
                parents.append(p)
            }
            missing.append(contentsOf: parents.reversed())
            missing.append(output)
        }
        for folder in components.dropLast() {
            cur = join(cur, folder)
            if !missing.isEmpty { missing.append(cur); continue }
            if let st = lstatPath(cur) {
                if isLink(st) { return .inTheWay("a link stands where the folder \(String(decoding: cur, as: UTF8.self)) should be") }
                if !isDir(st) { return .inTheWay("a file stands where the folder \(String(decoding: cur, as: UTF8.self)) should be") }
            } else {
                missing.append(cur)
            }
        }
        let dest = join(cur, components.last!)
        if let st = lstatPath(dest) {
            if isDir(st) { return .inTheWay("a folder stands where the file should land") }
            if written.contains(FileID(dev: st.st_dev, ino: st.st_ino)) { return .collision }
            return .skippedExisting
        }
        return .ok(missingFolders: missing, dest: dest)
    }

    /// Makes the missing folders, writes the bytes under a temporary name, sets the time, reads it back, and renames without replacing.
    func write(dest: Bytes, missingFolders: [Bytes], content: Bytes, mtimeMs: Int64) -> Outcome {
        var made: [Bytes] = []
        func undoFolders() { for f in made.reversed() { _ = cPath(f).withUnsafeBufferPointer { rmdir($0.baseAddress!) } } }
        for f in missingFolders {
            let rc = cPath(f).withUnsafeBufferPointer { mkdir($0.baseAddress!, 0o755) }
            if rc != 0 { let e = errnoText(); undoFolders(); return .damaged("could not create folder \(String(decoding: f, as: UTF8.self)): \(e)") }
            made.append(f)
        }
        guard let slash = dest.lastIndex(of: 0x2F) else { return .damaged("internal: destination has no folder") }
        let folder = Array(dest[0..<slash])
        tmpCounter += 1
        let tmp = join(folder, Array(".s3cab-restore-tmp-\(getpid())-\(tmpCounter)".utf8))
        let fd = cPath(tmp).withUnsafeBufferPointer { open($0.baseAddress!, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644) }
        if fd < 0 { let e = errnoText(); undoFolders(); return .damaged("could not create \(String(decoding: dest, as: UTF8.self)): \(e)") }
        func unlinkTmp() { _ = cPath(tmp).withUnsafeBufferPointer { unlink($0.baseAddress!) } }
        var off = 0
        while off < content.count {
            let n = content.withUnsafeBufferPointer { Darwin.write(fd, $0.baseAddress! + off, $0.count - off) }
            if n < 0 { let e = errnoText(); close(fd); unlinkTmp(); undoFolders(); return .damaged("write failed: \(e)") }
            off += n
        }
        let sec = floorDiv(mtimeMs, 1000)
        let nsec = (mtimeMs - sec * 1000) * 1_000_000
        var timeOutcome: Outcome = .restored
        if s3r_set_times(fd, sec, Int(nsec)) != 0 {
            timeOutcome = .timeNotHeld("futimens failed: \(errnoText())")
        }
        var st = stat()
        if fstat(fd, &st) == 0 {
            let actualMs = Int64(st.st_mtimespec.tv_sec) * 1000 + Int64(st.st_mtimespec.tv_nsec + 500_000) / 1_000_000
            let diff = abs(actualMs - mtimeMs)
            if diff != 0 {
                if diff < 2000 { timeOutcome = .timeOffByRounding(diff) }
                else { timeOutcome = .timeNotHeld("file has \(actualMs) ms since epoch, row has \(mtimeMs)") }
            }
        }
        close(fd)
        let rc = cPath(tmp).withUnsafeBufferPointer { t in cPath(dest).withUnsafeBufferPointer { d in s3r_rename_excl(t.baseAddress!, d.baseAddress!) } }
        if rc != 0 {
            let e = errnoText(); unlinkTmp(); undoFolders()
            return .damaged("could not move into place \(String(decoding: dest, as: UTF8.self)): \(e)")
        }
        if let st2 = lstatPath(dest) { written.insert(FileID(dev: st2.st_dev, ino: st2.st_ino)) }
        return timeOutcome
    }
}
