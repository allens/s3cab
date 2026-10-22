// The restore: fetch, verify, and lay files out as format.md describes s3cab's own restore to a
// chosen directory: <output>/<name of the DIR that matched>/<rest of the path below it>.
import CryptoKit
import Darwin
import Foundation

func isSnapshotName(_ s: some Collection<UInt8>) -> Bool {
    let shape = Array("dddd-dd-ddTdddd".utf8)
    return s.count == shape.count && zip(s, shape).allSatisfy { c, d in
        d == UInt8(ascii: "d") ? (0x30...0x39).contains(c) : c == d
    }
}

func isRecordKey(_ k: String) -> Bool {
    let b = Array(k.utf8)
    let pre = Array("objects.deleted-".utf8), suf = Array(".tsv".utf8)
    guard b.count > pre.count + suf.count, b.starts(with: pre), b.suffix(suf.count).elementsEqual(suf) else { return false }
    return b[pre.count..<(b.count - suf.count)].allSatisfy { (0x30...0x39).contains($0) }
}

func err(_ s: String) { FileHandle.standardError.write(Data((s + "\n").utf8)) }

final class Restorer {
    let s3: S3Client
    let set: String
    let output: String
    let requested: String?

    var problems = 0          // anything that makes the exit nonzero
    var restored = 0, skippedExisting = 0, deliberate = 0, rounded = 0
    private var records: [String: [Deletion]]? = nil
    private var stage = ""
    private var outFd: Int32 = -1
    private var written = Set<[UInt64]>()   // (dev, ino) of files this run created

    init(s3: S3Client, set: String, output: String, snapshot: String?) {
        self.s3 = s3; self.set = set; self.output = output; self.requested = snapshot
    }

    func problem(_ s: String) { problems += 1; err(s) }

    /// Returns the process exit status: 0 complete, 1 restored what it could, 2 refused/stopped.
    func run() -> Int32 {
        guard !set.isEmpty, !set.contains("/") else { err("error: bad set name \(quote(set))"); return 2 }
        if !set.utf8.allSatisfy({ (0x61...0x7A).contains($0) || (0x30...0x39).contains($0) || $0 == 0x2D }) {
            err("warning: set name \(quote(set)) is not lowercase letters, digits and hyphens")
        }
        do {
            defer { cleanup() }
            return try restore()
        } catch {
            err("error: \(error)")
            err(restored == 0 ? "restore stopped: nothing restored"
                : "restore stopped after \(restored) file(s): the output is INCOMPLETE")
            return 2
        }
    }

    private func cleanup() {
        if outFd >= 0 { close(outFd) }
        if !stage.isEmpty { try? FileManager.default.removeItem(atPath: stage) }
    }

    private func pickSnapshot() throws -> String {
        let prefix = "snapshots/\(set)/"
        if var name = requested {
            if name.hasSuffix(".tsv.gz") { name = String(name.dropLast(7)) }
            guard isSnapshotName(name.utf8) else { throw Fatal("snapshot name \(quote(name)) is not YYYY-MM-DDTHHMM") }
            return name
        }
        let listing = try s3.list(prefix: prefix)
        let names: [Bytes] = listing.keys.compactMap { k in
            let b = Array(k.utf8)
            guard b.starts(with: prefix.utf8), b.count == prefix.utf8.count + 22,
                  b.suffix(7).elementsEqual(".tsv.gz".utf8) else { return nil }
            let n = Array(b[prefix.utf8.count..<(b.count - 7)])
            return isSnapshotName(n) ? n : nil
        }
        guard let latest = names.max(by: { $0.lexicographicallyPrecedes($1) }) else {
            throw Fatal("no snapshots under s3://\(s3.bucket)/\(prefix)")
        }
        return String(decoding: latest, as: UTF8.self)
    }

    private func restore() throws -> Int32 {
        let name = try pickSnapshot()
        let key = "snapshots/\(set)/\(name).tsv.gz"
        print("snapshot s3://\(s3.bucket)/\(key)")
        guard let gz = try s3.getBytes(key) else { throw Fatal("\(key): not found") }
        let snap: Snapshot
        do {
            let (text, members) = try gunzip(gz)
            if members > 1 { err("warning: \(key) holds \(members) gzip members; read as one stream") }
            snap = try parseSnapshot(text)
        } catch {
            err("error: snapshot refused: \(error)")
            err("nothing restored")
            return 2
        }
        for n in snap.notes { err("warning: \(n)") }
        for r in snap.refused {
            problem("refused line \(r.line)\(r.path.map { " \(quote($0))" } ?? ""): \(r.why)")
        }

        let planned: [PlannedFile]
        do { planned = try plan(snap) } catch {
            err("error: \(error)")
            err("nothing restored")
            return 2
        }

        if !snap.files.isEmpty {
            // Downloads are staged and hash-checked here, never in the output.
            var base = ProcessInfo.processInfo.environment["TMPDIR"] ?? "/tmp"
            while base.count > 1 && base.hasSuffix("/") { base.removeLast() }
            var tmpl = Array("\(base)/s3cab-restore.XXXXXX".utf8CString)
            guard mkdtemp(&tmpl) != nil else {
                throw Fatal("cannot create a staging directory under \(base): \(String(cString: strerror(errno)))")
            }
            stage = String(decoding: tmpl.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
        }

        var uses = [String: Int]()
        for f in snap.files { uses[f.hash, default: 0] += 1 }
        var fetched = [String: FetchState]()

        for p in planned {
            let f = p.row, dest = p.dest
            let shown = quote(f.rawPath)
            defer {
                uses[f.hash]! -= 1
                if uses[f.hash] == 0 { unlink(stage + "/" + f.hash) }
            }
            if dest.contains(where: { $0.contains(0) }) {
                problem("not restored \(shown): a name holds NUL, which no macOS filesystem can create"); continue
            }
            let state: FetchState
            if let s = fetched[f.hash] { state = s } else { state = try fetch(f.hash); fetched[f.hash] = state }
            switch state {
            case .missing:
                if let dels = try deletionRecords()[f.hash] {
                    let newest = dels.max { $0.date.lexicographicallyPrecedes($1.date) }!
                    deliberate += 1
                    err("skipped \(shown): content deliberately deleted \(String(decoding: newest.date, as: UTF8.self)) "
                        + "by \(quote(newest.who)) (\(newest.file))")
                } else {
                    problem("DAMAGE \(shown): objects/\(f.hash) is missing and no deletion record lists it")
                }
                continue
            case .wrongHash(let got):
                problem("DAMAGE \(shown): objects/\(f.hash) hashes to \(got); withheld"); continue
            case .ok:
                break
            }
            try place(f, dest: dest, shown: shown)
        }

        let total = snap.files.count + snap.refused.count
        print("\(restored) restored, \(skippedExisting) already present (left alone), \(deliberate) deliberately deleted, "
              + "\(problems) problem(s), of \(total) file row(s)")
        if rounded > 0 { print("\(rounded) modification time(s) rounded by the filesystem") }
        if problems > 0 { print("restore INCOMPLETE: see the messages above") }
        return problems > 0 ? 1 : 0
    }

    enum FetchState { case ok, missing, wrongHash(String) }

    private func fetch(_ hash: String) throws -> FetchState {
        let path = stage + "/" + hash
        let fd = open(path, O_RDWR | O_CREAT | O_TRUNC | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw Fatal("staging \(path): \(String(cString: strerror(errno)))") }
        defer { close(fd) }
        let result = try s3.get(key: "objects/\(hash)", into: { .file(fd) }, reset: {
            guard ftruncate(fd, 0) == 0, lseek(fd, 0, SEEK_SET) == 0 else {
                throw Fatal("staging \(path): \(String(cString: strerror(errno)))")
            }
        })
        switch result {
        case .notFound:
            unlink(path); return .missing
        case .ok(let sink):
            let got = hex(sink.hasher.finalize())
            if got != hash { unlink(path); return .wrongHash(got) }
            return .ok
        }
    }

    /// Every objects.deleted-<n>.tsv, read as one set, loaded on the first miss.
    private func deletionRecords() throws -> [String: [Deletion]] {
        if let r = records { return r }
        var all = [String: [Deletion]]()
        let keys = try s3.list(prefix: "objects.deleted-").keys.filter(isRecordKey)
        for k in keys {
            guard let data = try s3.getBytes(k) else { err("warning: deletion record \(k) vanished before it could be read"); continue }
            do {
                let rec = try parseRecord(data, name: k)
                for r in rec.refusedRows { err("warning: \(k) \(r): not trusted") }
                for (h, d) in rec.rows { all[h, default: []] += d }
            } catch {
                err("warning: deletion record \(k) refused (\(error)); none of its rows are trusted")
            }
        }
        records = all
        return all
    }

    private func openOutput() throws -> Int32 {
        if outFd >= 0 { return outFd }
        try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
        outFd = open(output, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard outFd >= 0 else { throw Fatal("cannot open output \(output): \(String(cString: strerror(errno)))") }
        return outFd
    }

    private func place(_ f: FileRow, dest: [Bytes], shown: String) throws {
        var dirfd = try openOutput()
        var opened: [Int32] = []
        defer { for d in opened { close(d) } }
        for seg in dest.dropLast() {
            var fd = openat(dirfd, cstr(seg), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            if fd < 0 && errno == ENOENT {
                if mkdirat(dirfd, cstr(seg), 0o777) != 0 && errno != EEXIST {
                    problem("not restored \(shown): cannot make folder \(quote(seg)): \(String(cString: strerror(errno)))"); return
                }
                fd = openat(dirfd, cstr(seg), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            }
            if fd < 0 {
                let e = errno
                if e == ENOTDIR || e == ELOOP || e == EEXIST {
                    problem("not restored \(shown): something in the way: \(quote(seg)) exists and is not a folder")
                } else {
                    problem("not restored \(shown): cannot open folder \(quote(seg)): \(String(cString: strerror(e)))")
                }
                return
            }
            opened.append(fd); dirfd = fd
        }
        let leaf = dest.last!
        let out = openat(dirfd, cstr(leaf), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o666)
        if out < 0 {
            let e = errno
            var st = stat()
            if e == EEXIST, fstatat(dirfd, cstr(leaf), &st, AT_SYMLINK_NOFOLLOW) == 0 {
                if (st.st_mode & S_IFMT) == S_IFREG {
                    if written.contains([UInt64(bitPattern: Int64(st.st_dev)), st.st_ino]) {
                        problem("not restored \(shown): this destination holds it as the same file as an earlier row "
                                + "(letter case or Unicode normalization)")
                    } else {
                        skippedExisting += 1
                        err("skipped \(shown): a file is already at the destination; left alone")
                    }
                } else {
                    problem("not restored \(shown): something in the way: \(quote(leaf)) exists and is not a file")
                }
            } else {
                problem("not restored \(shown): cannot create \(quote(leaf)): \(String(cString: strerror(e)))")
            }
            return
        }
        var ok = false
        defer {
            if !ok { unlinkat(dirfd, cstr(leaf), 0) }
            close(out)
        }
        let src = open(stage + "/" + f.hash, O_RDONLY | O_CLOEXEC)
        guard src >= 0 else { throw Fatal("staged object \(f.hash) vanished") }
        defer { close(src) }
        var buf = [UInt8](repeating: 0, count: 1 << 20)
        var hasher = SHA256()
        while true {
            let n = buf.withUnsafeMutableBytes { read(src, $0.baseAddress, $0.count) }
            if n < 0 { if errno == EINTR { continue }; throw Fatal("reading staged \(f.hash): \(String(cString: strerror(errno)))") }
            if n == 0 { break }
            hasher.update(data: buf[0..<n])
            var off = 0
            while off < n {
                let w = buf.withUnsafeBytes { Darwin.write(out, $0.baseAddress! + off, n - off) }
                if w < 0 {
                    if errno == EINTR { continue }
                    problem("not restored \(shown): write failed: \(String(cString: strerror(errno)))"); return
                }
                off += w
            }
        }
        // The bytes written are the bytes that hashed to the key: check again, it costs little.
        guard hex(hasher.finalize()) == f.hash else { throw Fatal("staged object \(f.hash) changed on disk") }
        var times = [timespec(tv_sec: 0, tv_nsec: Int(UTIME_OMIT)),
                     timespec(tv_sec: Int(f.mtime.seconds), tv_nsec: Int(f.mtime.millis) * 1_000_000)]
        if futimens(out, &times) != 0 {
            problem("restored \(shown) but could not set its time: \(String(cString: strerror(errno)))")
        }
        var st = stat()
        guard fstat(out, &st) == 0 else { throw Fatal("fstat: \(String(cString: strerror(errno)))") }
        ok = true
        restored += 1
        written.insert([UInt64(bitPattern: Int64(st.st_dev)), st.st_ino])
        let wantNs = Int128(f.mtime.seconds) * 1_000_000_000 + Int128(f.mtime.millis) * 1_000_000
        let gotNs = Int128(st.st_mtimespec.tv_sec) * 1_000_000_000 + Int128(st.st_mtimespec.tv_nsec)
        let off = wantNs - gotNs
        if off != 0 {
            if abs(off) < 2_000_000_000 {
                rounded += 1
            } else {
                problem("restored \(shown) but the filesystem kept its time as \(st.st_mtimespec.tv_sec).\(st.st_mtimespec.tv_nsec) "
                        + "(Unix seconds), not \(f.mtime.seconds).\(f.mtime.millis)")
            }
        }
    }
}

/// NUL-terminated copy of a name (callers have already refused names holding NUL).
func cstr(_ b: Bytes) -> [CChar] { b.map { CChar(bitPattern: $0) } + [0] }
