// The s3cab text format, read strictly from format.md (spec of 2026-10-20).
// Everything is kept as bytes: Swift String equality is canonical equivalence, which would
// merge paths a filesystem keeps apart.

typealias Bytes = [UInt8]

let headingURL = Array("https://s3cab.plantegral.com/guide/format".utf8)
let headingLeading: [Bytes] = ["@S3CAB", "FORMAT", "size", "time"].map { Array($0.utf8) }

// MARK: - The four reading rules

/// Leading fields are trimmed of tab, VT, FF, CR, LF, every Zs space, U+2028, U+2029 and a BOM;
/// not U+0085, not U+001C-U+001F. (Both ends: the spec doesn't say; columns pad both ways.)
func isTrimmable(_ s: Unicode.Scalar) -> Bool {
    switch s.value {
    case 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x2028, 0x2029, 0xFEFF: return true
    case 0x85: return false
    default: return s.properties.generalCategory == .spaceSeparator
    }
}

func trimField(_ f: ArraySlice<UInt8>) -> Bytes {
    // The whole file was validated as UTF-8 and fields are cut at ASCII bytes, so this decodes.
    let scalars = Array(String(decoding: f, as: UTF8.self).unicodeScalars)
    var lo = 0, hi = scalars.count
    while lo < hi, isTrimmable(scalars[lo]) { lo += 1 }
    while hi > lo, isTrimmable(scalars[hi - 1]) { hi -= 1 }
    var s = String.UnicodeScalarView()
    s.append(contentsOf: scalars[lo..<hi])
    return Array(String(s).utf8)
}

func eq(_ a: Bytes, _ b: String) -> Bool { a.elementsEqual(b.utf8) }

struct Line {
    let number: Int  // 1-based
    let fields: [ArraySlice<UInt8>]  // split on every tab
    /// Field n (0-based) with everything after it: "the last as the rest of the line".
    let raw: ArraySlice<UInt8>
    func rest(from n: Int) -> ArraySlice<UInt8>? {
        guard fields.count > n else { return nil }
        return raw[fields[n].startIndex..<raw.endIndex]
    }
}

enum WholeFileRefusal: Error, CustomStringConvertible {
    case notUTF8, noHeading(String), notTerminated, rowsAfterDot(Int), unknownType(Int, String), empty

    var description: String {
        switch self {
        case .notUTF8: return "not valid UTF-8"
        case .noHeading(let why): return "first line is not the heading row (\(why))"
        case .notTerminated: return "last line is not the `.` terminator: the file was cut short"
        case .rowsAfterDot(let n): return "a `.` terminator at line \(n) has rows after it"
        case .unknownType(let n, let t): return "line \(n) has unknown row type \(quote(t)) (neither @ nor #)"
        case .empty: return "empty file"
        }
    }
}

/// Applies the rules every snapshot and deletion record share: strict UTF-8 (one leading BOM
/// forgiven), LF-only splitting, the heading row first, exactly one `.` and it last.
/// Returns the rows between heading and `.`.
func splitDocument(_ data: Bytes) throws -> [Line] {
    var body = data[...]
    if body.starts(with: [0xEF, 0xBB, 0xBF]) { body = body.dropFirst(3) }
    guard String(validating: body, as: UTF8.self) != nil else { throw WholeFileRefusal.notUTF8 }
    guard !body.isEmpty else { throw WholeFileRefusal.empty }
    // A `.` without its LF doesn't count, and nothing may follow the final LF.
    guard body.last == 0x0A else { throw WholeFileRefusal.notTerminated }
    var lines = [ArraySlice<UInt8>]()
    var start = body.startIndex
    for i in body.indices where body[i] == 0x0A {
        lines.append(body[start..<i]); start = i + 1
    }
    guard let last = lines.last, last.elementsEqual([UInt8(ascii: ".")]) else {
        throw WholeFileRefusal.notTerminated
    }
    for (i, l) in lines.dropLast().enumerated() where l.elementsEqual([UInt8(ascii: ".")]) {
        throw WholeFileRefusal.rowsAfterDot(i + 1)
    }
    let parsed = lines.dropLast().enumerated().map { (i, l) in
        Line(number: i + 1, fields: l.split(separator: 0x09, omittingEmptySubsequences: false), raw: l)
    }
    guard let head = parsed.first else { throw WholeFileRefusal.noHeading("no lines before the `.`") }
    guard head.fields.count >= 5 else { throw WholeFileRefusal.noHeading("fewer than five fields") }
    for i in 0..<4 where trimField(head.fields[i]) != headingLeading[i] {
        throw WholeFileRefusal.noHeading("field \(i + 1) is \(quote(head.fields[i]))")
    }
    guard head.rest(from: 4)!.elementsEqual(headingURL) else {
        throw WholeFileRefusal.noHeading("field 5 is \(quote(head.rest(from: 4)!))")
    }
    return Array(parsed.dropFirst())
}

// MARK: - Field shapes

func isHash(_ b: Bytes) -> Bool {
    b.count == 64 && b.allSatisfy { (0x30...0x39).contains($0) || (0x61...0x66).contains($0) }
}

func isDecimal(_ b: Bytes) -> Bool { !b.isEmpty && b.allSatisfy { (0x30...0x39).contains($0) } }

/// An instant as exactly YYYY-MM-DDTHH:MM:SS.sssZ, calendar-checked. Returns Unix seconds and ms.
func parseInstant(_ b: Bytes) -> (seconds: Int64, millis: Int64)? {
    guard b.count == 24 else { return nil }
    let shape = Array("dddd-dd-ddTdd:dd:dd.dddZ".utf8)
    for (c, s) in zip(b, shape) {
        if s == UInt8(ascii: "d") { guard (0x30...0x39).contains(c) else { return nil } } else if c != s { return nil }
    }
    func num(_ r: Range<Int>) -> Int64 { r.reduce(0) { $0 * 10 + Int64(b[$1] - 0x30) } }
    let y = num(0..<4), mo = num(5..<7), d = num(8..<10)
    let h = num(11..<13), mi = num(14..<16), s = num(17..<19), ms = num(20..<23)
    guard (1...12).contains(mo), h < 24, mi < 60, s < 60 else { return nil }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
    let dim: [Int64] = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    guard d >= 1, d <= dim[Int(mo - 1)] else { return nil }
    // days_from_civil (proleptic Gregorian), exact integer arithmetic.
    let yy = mo <= 2 ? y - 1 : y
    let era = (yy >= 0 ? yy : yy - 399) / 400
    let yoe = yy - era * 400
    let mp = (mo + 9) % 12
    let doy = (153 * mp + 2) / 5 + d - 1
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    let days = era * 146097 + doe - 719468
    return (days * 86400 + h * 3600 + mi * 60 + s, ms)
}

// MARK: - Paths

enum PathKind: Hashable { case posix, drive, share }

/// An absolute path as root + segments. Which separators count depends on the path:
/// a Windows path (drive letter + `\` or `/`, or a share starting `\\` or `//`) splits on both,
/// any other on `/` alone.
struct ParsedPath: Hashable {
    let kind: PathKind
    let root: Bytes       // "/" ; "C:" ; "\\" (as written, for drive the letter and colon)
    let segments: [Bytes]

    var exactKey: PathKey { PathKey(kind: kind, root: root, segments: segments) }
}

struct PathKey: Hashable {
    let kind: PathKind
    let root: Bytes
    let segments: [Bytes]
}

func isSep(_ c: UInt8, windows: Bool) -> Bool { c == 0x2F || (windows && c == 0x5C) }

func classify(_ p: Bytes) -> (PathKind, Bytes, ArraySlice<UInt8>)? {
    if p.count >= 3, (0x41...0x5A).contains(p[0]) || (0x61...0x7A).contains(p[0]),
       p[1] == UInt8(ascii: ":"), isSep(p[2], windows: true) {
        return (.drive, Array(p[0..<2]), p[3...])
    }
    if p.count >= 2, (p[0] == 0x5C && p[1] == 0x5C) || (p[0] == 0x2F && p[1] == 0x2F) {
        return (.share, [0x5C, 0x5C], p[2...])  // `\\` and `//` are one root
    }
    if p.first == 0x2F { return (.posix, [0x2F], p[1...]) }
    return nil
}

/// A file row's path: absolute, and every segment past the root a name (not empty, `.`, `..`).
enum PathProblem: Error, CustomStringConvertible {
    case notAbsolute, emptySegment, dotSegment, hasCR
    var description: String {
        switch self {
        case .notAbsolute: return "path is not absolute"
        case .emptySegment: return "path has an empty segment (doubled or trailing separator)"
        case .dotSegment: return "path has a `.` or `..` segment"
        case .hasCR: return "path holds a carriage return"
        }
    }
}

func parseFilePath(_ p: Bytes) -> Result<ParsedPath, PathProblem> {
    if p.contains(0x0D) { return .failure(.hasCR) }
    guard let (kind, root, rest) = classify(p) else { return .failure(.notAbsolute) }
    let segs = rest.split(omittingEmptySubsequences: false) { isSep($0, windows: kind != .posix) }.map(Array.init)
    for s in segs {
        if s.isEmpty { return .failure(.emptySegment) }
        if s == [0x2E] || s == [0x2E, 0x2E] { return .failure(.dotSegment) }
    }
    return .success(ParsedPath(kind: kind, root: root, segments: segs))
}

/// A `@SET DIR`: trailing separators ignored; a doubled separator after the root leaves an
/// empty segment, so it matches nothing. Relative DIRs match nothing.
struct SetDir {
    let raw: Bytes
    let line: Int
    let parsed: ParsedPath?   // nil = matches nothing
    /// Folder name under the output: last segment, a drive root's letter, nil for `/`.
    var name: Bytes? {
        guard let p = parsed else { return nil }
        if let last = p.segments.last { return last }
        if p.kind == .drive { return [p.root[0]] }
        return nil
    }
    var matchKey: PathKey? {
        guard let p = parsed else { return nil }
        return p.kind == .posix ? p.exactKey
            : PathKey(kind: p.kind, root: foldCase(p.root), segments: p.segments.map(foldCase))
    }

    init(raw: Bytes, line: Int) {
        self.raw = raw
        self.line = line
        guard let (kind, root, rest) = classify(raw) else { parsed = nil; return }
        var r = rest
        while let l = r.last, isSep(l, windows: kind != .posix) { r = r.dropLast() }
        let segs = r.isEmpty ? [] : r.split(omittingEmptySubsequences: false) { isSep($0, windows: kind != .posix) }.map(Array.init)
        parsed = segs.contains(where: \.isEmpty) ? nil : ParsedPath(kind: kind, root: root, segments: segs)
    }
}

/// Unicode's default lowercase mapping (full mappings plus the Final_Sigma context), compared
/// afterwards as bytes. Not String.lowercased(): that maps a word-final Σ to σ, not ς, so
/// `ΟΔΟΣ` would match `οδοσ` where Python and JavaScript match `οδος`.
func foldCase(_ b: Bytes) -> Bytes {
    let s = Array(String(decoding: b, as: UTF8.self).unicodeScalars)
    var out = String.UnicodeScalarView()
    for i in s.indices {
        if s[i].value == 0x03A3 && isFinalSigma(s, i) { out.append(Unicode.Scalar(0x03C2)!); continue }
        out.append(contentsOf: s[i].properties.lowercaseMapping.unicodeScalars)
    }
    return Array(String(out).utf8)
}

/// Final_Sigma (Unicode 3.13): preceded by a cased letter and not followed by one, skipping
/// case-ignorable characters on both sides.
func isFinalSigma(_ s: [Unicode.Scalar], _ i: Int) -> Bool {
    var j = i - 1
    while j >= 0 && s[j].properties.isCaseIgnorable { j -= 1 }
    guard j >= 0, s[j].properties.isCased else { return false }
    var k = i + 1
    while k < s.count && s[k].properties.isCaseIgnorable { k += 1 }
    return !(k < s.count && s[k].properties.isCased)
}

func matchKey(of p: ParsedPath) -> PathKey {
    p.kind == .posix ? p.exactKey : PathKey(kind: p.kind, root: foldCase(p.root), segments: p.segments.map(foldCase))
}

// MARK: - Snapshot

struct FileRow {
    let line: Int
    let hash: String
    let mtime: (seconds: Int64, millis: Int64)
    let rawPath: Bytes
    let path: ParsedPath
    var dirIndex: Int = -1
}

struct RefusedRow {
    let line: Int
    let path: Bytes?
    let why: String
}

struct Snapshot {
    var dirs: [SetDir] = []
    var files: [FileRow] = []
    var refused: [RefusedRow] = []
    var notes: [String] = []
    var properties: [(String, String, Bytes)] = []
}

func parseSnapshot(_ data: Bytes) throws -> Snapshot {
    let rows = try splitDocument(data)
    var snap = Snapshot()
    var candidates: [(line: Line, fields: [Bytes])] = []
    for line in rows {
        let type = trimField(line.fields[0])
        if eq(type, "-") {
            candidates.append((line, []))
        } else if type.first == UInt8(ascii: "@") {
            let prop = line.fields.count > 1 ? trimField(line.fields[1]) : []
            if line.fields.count >= 5 {
                snap.properties.append((String(decoding: type, as: UTF8.self), String(decoding: prop, as: UTF8.self),
                                        Array(line.rest(from: 4)!)))
            }
            if eq(type, "@SET") && eq(prop, "DIR") {
                if let v = line.rest(from: 4) {
                    snap.dirs.append(SetDir(raw: Array(v), line: line.number))
                } else {
                    snap.notes.append("line \(line.number): @SET DIR row with fewer than five fields, ignored")
                }
            }
        } else if type.first == UInt8(ascii: "#") {
            continue  // a restore doesn't act on # rows
        } else {
            throw WholeFileRefusal.unknownType(line.number, String(decoding: type, as: UTF8.self))
        }
    }

    // Identical DIR rows are one DIR (guess: the spec doesn't say).
    var seenDir = Set<Bytes>()
    snap.dirs = snap.dirs.filter { seenDir.insert($0.raw).inserted }

    // Per-row checks. A row that has a parseable path still counts for the duplicate check.
    struct Pending { var row: FileRow?; let line: Int; let rawPath: Bytes?; let key: PathKey?; var why: String? }
    var pending = [Pending]()
    for (line, _) in candidates {
        let f = line.fields
        let rawPath: Bytes? = f.count >= 5 ? Array(line.rest(from: 4)!) : nil
        var parsed: ParsedPath? = nil
        var why: String? = nil
        if let rp = rawPath {
            switch parseFilePath(rp) {
            case .success(let p): parsed = p
            case .failure(let prob): why = prob.description
            }
        }
        if f.count != 5 { why = f.count < 5 ? "file row has \(f.count) fields, not five" : "file row has \(f.count) fields: a tab in the path" }
        var row: FileRow? = nil
        if why == nil {
            let hash = trimField(f[1]), size = trimField(f[2]), time = trimField(f[3])
            if !isHash(hash) { why = "hash \(quote(hash)) is not 64 lowercase hex" }
            else if !isDecimal(size) { why = "size \(quote(size)) is not decimal" }
            else if let t = parseInstant(time) {
                row = FileRow(line: line.number, hash: String(decoding: hash, as: UTF8.self), mtime: t,
                              rawPath: rawPath!, path: parsed!)
            } else { why = "time \(quote(time)) is not YYYY-MM-DDTHH:MM:SS.sssZ" }
        }
        // Place under the longest matching DIR, strictly inside it.
        if var r = row {
            let key = matchKey(of: r.path)
            var best = -1, bestLen = -1, tie = false, isDir = false
            for (i, d) in snap.dirs.enumerated() {
                guard let dk = d.matchKey, dk.kind == key.kind, dk.root == key.root,
                      key.segments.count >= dk.segments.count,
                      Array(key.segments.prefix(dk.segments.count)) == dk.segments else { continue }
                if key.segments.count == dk.segments.count { isDir = true; continue }
                if dk.segments.count > bestLen { best = i; bestLen = dk.segments.count; tie = false }
                else if dk.segments.count == bestLen { tie = true }
            }
            if isDir { why = "path is a @SET DIR itself, not inside one"; row = nil }
            else if best < 0 { why = "path is under no @SET DIR"; row = nil }
            else if tie { why = "path matches two different @SET DIR rows equally deep"; row = nil }
            else { r.dirIndex = best; row = r }
        }
        pending.append(Pending(row: row, line: line.number, rawPath: rawPath, key: parsed?.exactKey, why: why))
    }

    // One path in two file rows: both refused, whatever else is wrong with either.
    var byKey = [PathKey: [Int]]()
    for (i, p) in pending.enumerated() { if let k = p.key { byKey[k, default: []].append(i) } }
    for (_, idx) in byKey where idx.count > 1 {
        let lines = idx.map { String(pending[$0].line) }.joined(separator: ", ")
        for i in idx where pending[i].why == nil {
            pending[i].why = "same path as another file row (lines \(lines))"; pending[i].row = nil
        }
    }

    // Last, among the survivors: one file's path running through another's as a folder.
    var survivors = [PathKey: Int]()
    for (i, p) in pending.enumerated() where p.row != nil { survivors[p.key!] = i }
    var through = Set<Int>()
    for (i, p) in pending.enumerated() where p.row != nil {
        let k = p.key!
        for n in stride(from: k.segments.count - 1, through: 1, by: -1) {
            let prefix = PathKey(kind: k.kind, root: k.root, segments: Array(k.segments.prefix(n)))
            if let j = survivors[prefix] { through.insert(i); through.insert(j) }
        }
    }
    for i in through {
        pending[i].why = "one file row's path runs through another's as a folder"; pending[i].row = nil
    }

    for p in pending {
        if let r = p.row { snap.files.append(r) }
        else { snap.refused.append(RefusedRow(line: p.line, path: p.rawPath, why: p.why ?? "refused")) }
    }
    return snap
}

// MARK: - Deletion records

struct Deletion { let date: Bytes; let who: Bytes; let file: String }

struct RecordParse {
    var rows: [String: [Deletion]] = [:]
    var refusedRows: [String] = []
}

func parseRecord(_ data: Bytes, name: String) throws -> RecordParse {
    let rows = try splitDocument(data)
    var out = RecordParse()
    for line in rows {
        let type = trimField(line.fields[0])
        if eq(type, "#deleted") {
            guard line.fields.count >= 5 else {
                out.refusedRows.append("line \(line.number): #deleted row has \(line.fields.count) fields"); continue
            }
            let hash = trimField(line.fields[1]), size = trimField(line.fields[2]), time = trimField(line.fields[3])
            guard isHash(hash), isDecimal(size), parseInstant(time) != nil else {
                out.refusedRows.append("line \(line.number): malformed #deleted row"); continue
            }
            out.rows[String(decoding: hash, as: UTF8.self), default: []]
                .append(Deletion(date: time, who: Array(line.rest(from: 4)!), file: name))
        } else if type.first == UInt8(ascii: "@") || type.first == UInt8(ascii: "#") {
            continue
        } else if eq(type, "-") {
            // Guess: a record carries no paths; a file row means this isn't a record. Distrust it.
            throw WholeFileRefusal.unknownType(line.number, "- (a file row in a deletion record)")
        } else {
            throw WholeFileRefusal.unknownType(line.number, String(decoding: type, as: UTF8.self))
        }
    }
    return out
}

// MARK: - Display

/// Shows bytes for a human: control characters and the unprintable spelled out, so a report
/// line can't be cut or forged by the name it prints.
func quote(_ b: some Collection<UInt8>) -> String {
    var s = "\""
    for u in String(decoding: b, as: UTF8.self).unicodeScalars {
        switch u.value {
        case 0x22: s += "\\\""
        case 0x5C: s += "\\\\"
        case 0..<0x20, 0x7F, 0x80..<0xA0, 0x2028, 0x2029, 0xFEFF:
            s += "\\u{\(String(u.value, radix: 16))}"
        default: s.unicodeScalars.append(u)
        }
    }
    return s + "\""
}

func quote(_ s: String) -> String { quote(Array(s.utf8)) }
