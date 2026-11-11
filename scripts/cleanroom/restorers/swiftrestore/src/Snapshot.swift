import Foundation

struct SnapshotRefused: Error, CustomStringConvertible { let description: String }

enum PathKind { case posix, drive, share }

struct ParsedPath {
    let kind: PathKind
    let rootFolder: Bytes?       // "C", "UNC", or nil for "/"
    let segments: [Bytes]        // as spelled in the row
    let foldedRoot: Bytes        // comparison key for the root
    let folded: [Bytes]          // comparison keys for the segments (lowercased on a Windows path)
}

private func isSlash(_ b: UInt8) -> Bool { b == 0x2F || b == 0x5C }
private func isAsciiLetter(_ b: UInt8) -> Bool { (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) }

func windowsKind(_ p: Bytes) -> PathKind? {
    if p.count >= 3, isAsciiLetter(p[0]), p[1] == 0x3A, isSlash(p[2]) { return .drive }
    if p.count >= 2, isSlash(p[0]), isSlash(p[1]) { return .share }
    return nil
}

private func splitSegments(_ body: ArraySlice<UInt8>, windows: Bool) -> [Bytes] {
    var segs: [Bytes] = []; var cur = Bytes()
    for b in body {
        if b == 0x2F || (windows && b == 0x5C) { segs.append(cur); cur = Bytes() } else { cur.append(b) }
    }
    segs.append(cur)
    return segs
}

// Unicode's full default case mapping, Final_Sigma included (Foundation's lowercased(with: nil), per the spec's hint).
func foldWindows(_ b: Bytes) -> Bytes { Array(String(decoding: b, as: UTF8.self).lowercased(with: nil).utf8) }

private func rawParts(_ p: Bytes) -> (kind: PathKind, root: Bytes, segs: [Bytes])? {
    if let k = windowsKind(p) {
        switch k {
        case .drive: return (.drive, [p[0]], splitSegments(p[3...], windows: true))
        case .share: return (.share, bytes("\\\\"), splitSegments(p[2...], windows: true))
        case .posix: return nil
        }
    }
    guard p.first == 0x2F else { return nil }
    return (.posix, bytes("/"), splitSegments(p[1...], windows: false))
}

// A @SET DIR row's value. nil means it matches nothing.
func parseDir(_ p: Bytes) -> ParsedPath? {
    guard !p.contains(0), let raw = rawParts(p) else { return nil }
    var segs = raw.segs
    while segs.last == [] { segs.removeLast() }          // ignore every separator it ends with
    if segs.contains([]) { return nil }                   // a doubled separator elsewhere
    if raw.kind == .share && segs.count < 2 { return nil } // needs a server and a share name
    var folded = segs, froot = raw.root
    if raw.kind != .posix {
        guard let f = rawParts(foldWindows(p)) else { return nil }
        var fs = f.segs; while fs.last == [] { fs.removeLast() }
        guard fs.count == segs.count else { return nil }
        folded = fs; froot = f.root
    }
    let rootFolder: Bytes? = raw.kind == .drive ? [p[0] & 0xDF] : (raw.kind == .share ? bytes("UNC") : nil)
    return ParsedPath(kind: raw.kind, rootFolder: rootFolder, segments: segs, foldedRoot: froot, folded: folded)
}

// A file row's path. .failure carries why the row is refused.
func parseFilePath(_ p: Bytes) -> Result<ParsedPath, SnapshotRefused> {
    if p.contains(0) { return .failure(.init(description: "path holds a NUL")) }
    if p.contains(CR) { return .failure(.init(description: "path holds a CR")) }
    if p.contains(TAB) { return .failure(.init(description: "path holds a tab")) }
    guard let raw = rawParts(p) else { return .failure(.init(description: "path isn't absolute")) }
    let segs = raw.segs
    if segs.contains([]) { return .failure(.init(description: "path has an empty segment (trailing or doubled separator)")) }
    if segs.contains(bytes(".")) || segs.contains(bytes("..")) { return .failure(.init(description: "path has a . or .. segment")) }
    var folded = segs, froot = raw.root
    if raw.kind != .posix {
        guard let f = rawParts(foldWindows(p)), f.segs.count == segs.count else { return .failure(.init(description: "path can't be case-folded")) }
        folded = f.segs; froot = f.root
    }
    let rootFolder: Bytes? = raw.kind == .drive ? [p[0] & 0xDF] : (raw.kind == .share ? bytes("UNC") : nil)
    return .success(ParsedPath(kind: raw.kind, rootFolder: rootFolder, segments: segs, foldedRoot: froot, folded: folded))
}

func isStrictlyUnder(_ path: ParsedPath, dir: ParsedPath) -> Bool {
    guard (dir.kind == .posix) == (path.kind == .posix), dir.foldedRoot == path.foldedRoot else { return false }
    guard dir.folded.count < path.folded.count else { return false }
    return Array(path.folded[0..<dir.folded.count]) == dir.folded
}

// Equal to a DIR by the same matching rules: refused even when strictly inside another (outer) DIR.
func isEqualTo(_ path: ParsedPath, dir: ParsedPath) -> Bool {
    guard (dir.kind == .posix) == (path.kind == .posix), dir.foldedRoot == path.foldedRoot else { return false }
    return dir.folded == path.folded
}

struct FileRow {
    let line: Int
    let hash: Bytes
    let hashHex: String
    let mtime: Instant
    let path: Bytes
    let parsed: ParsedPath
}

enum RowOutcome {
    case restore(FileRow)
    case refused(line: Int, path: Bytes, reason: String)
}

struct Snapshot {
    var dirs: [ParsedPath] = []
    var start: Instant? = nil
    var rows: [RowOutcome] = []
    var fileRowCount = 0
}

let headingURL = bytes("https://s3cab.plantegral.com/guide/format")

func parseSnapshot(_ text: Bytes) throws -> Snapshot {
    guard isValidUTF8(text) else { throw SnapshotRefused(description: "not valid UTF-8") }
    let (lines, terminated) = splitLF(text)
    guard !lines.isEmpty, terminated else { throw SnapshotRefused(description: "last line has no LF (file cut short)") }
    guard lines.last! == bytes(".") else { throw SnapshotRefused(description: "last line isn't the `.` terminator (file cut short)") }
    // heading row
    let h = splitFields(lines[0])
    guard h.count == 5, trimField(h[0]) == bytes("@S3CAB"), trimField(h[1]) == bytes("FORMAT"),
          trimField(h[2]) == bytes("size"), trimField(h[3]) == bytes("time"), h[4] == headingURL else {
        throw SnapshotRefused(description: "first line isn't the heading row")
    }
    var snap = Snapshot()
    struct Pending { let line: Int; let fields: [Bytes] }
    var pending: [Pending] = []
    for (i, line) in lines.enumerated() {
        if i == lines.count - 1 { break }
        if i == 0 { continue }
        if line == bytes(".") { throw SnapshotRefused(description: "line \(i + 1): a `.` with lines after it") }
        if trimField(line).isEmpty { throw SnapshotRefused(description: "line \(i + 1): blank line") }
        let f = splitFields(line)
        let type = trimField(f[0])
        if type == bytes("-") {
            pending.append(Pending(line: i + 1, fields: f))
        } else if type.first == 0x40 {           // @
            let prop = trimField(field(f, 1))
            if type == bytes("@SET"), prop == bytes("DIR") {
                let v = field(f, 4)
                if f.count == 5, !v.isEmpty, let d = parseDir(v) { snap.dirs.append(d) }
                else if f.count == 5, !v.isEmpty { fputs("note: @SET DIR matches nothing: \(display(v))\n", stderr) }
            } else if type == bytes("@SNAPSHOT"), prop == bytes("START") {
                snap.start = parseInstant(trimField(field(f, 3)))   // last one counts; a bad one counts as none
            }
        } else if type.first == 0x23 {           // # rows: a restore doesn't act on them
            continue
        } else {
            throw SnapshotRefused(description: "line \(i + 1): unknown row type \(display(type))")
        }
    }
    snap.fileRowCount = pending.count
    // Every file row takes part in the one-path-in-two-rows check, malformed ones included.
    var pathCount: [Bytes: Int] = [:]
    for p in pending { pathCount[field(p.fields, 4), default: 0] += 1 }
    struct Candidate { let row: FileRow }
    var outcomes: [(Int, RowOutcome)] = []
    var survivors: [FileRow] = []
    for p in pending {
        let f = p.fields
        let path = field(f, 4)
        func refuse(_ why: String) { outcomes.append((p.line, .refused(line: p.line, path: path, reason: why))) }
        if pathCount[path]! > 1 { refuse("path in more than one file row"); continue }
        let hash = trimField(field(f, 1))
        guard isLowerHex64(hash) else { refuse("hash isn't 64 lowercase hex characters"); continue }
        guard isDigits(trimField(field(f, 2))) else { refuse("size isn't decimal digits"); continue }
        guard let mtime = parseInstant(trimField(field(f, 3))) else { refuse("time isn't a real instant in the 24-character form"); continue }
        guard f.count == 5, !path.isEmpty else { refuse("no path"); continue }
        let parsed: ParsedPath
        switch parseFilePath(path) {
        case .failure(let e): refuse(e.description); continue
        case .success(let pp): parsed = pp
        }
        guard snap.dirs.contains(where: { isStrictlyUnder(parsed, dir: $0) }) else { refuse("path isn't strictly inside any @SET DIR"); continue }
        guard !snap.dirs.contains(where: { isEqualTo(parsed, dir: $0) }) else { refuse("path is equal to a (nested) @SET DIR"); continue }
        var raw = Bytes(); raw.reserveCapacity(32)
        var j = hash.startIndex
        while j < hash.endIndex { let s = String(decoding: hash[j..<j+2], as: UTF8.self); raw.append(UInt8(s, radix: 16)!); j += 2 }
        survivors.append(FileRow(line: p.line, hash: raw, hashHex: String(decoding: hash, as: UTF8.self), mtime: mtime, path: path, parsed: parsed))
    }
    // Last: one path running through another as a folder, among the survivors, paths compared exactly.
    let survivorPaths = Set(survivors.map { $0.path })
    var runsThrough = Set<Bytes>()
    for r in survivors {
        let windows = r.parsed.kind != .posix
        for i in 1..<r.path.count where r.path[i] == 0x2F || (windows && r.path[i] == 0x5C) {
            let prefix = Array(r.path[0..<i])
            if survivorPaths.contains(prefix) { runsThrough.insert(prefix); runsThrough.insert(r.path) }
        }
    }
    for r in survivors {
        if runsThrough.contains(r.path) { outcomes.append((r.line, .refused(line: r.line, path: r.path, reason: "path runs through, or is run through by, another file row's path"))) }
        else { outcomes.append((r.line, .restore(r))) }
    }
    outcomes.sort { $0.0 < $1.0 }
    snap.rows = outcomes.map { $0.1 }
    return snap
}
