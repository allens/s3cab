import Foundation

struct RefuseWhole: Error { let reason: String }

struct FileRow {
    let line: Int               // 1-based line number in the decompressed text
    let hash: String
    let size: String
    let mtimeMs: Int64
    let mtimeText: String
    let path: Bytes
    let parsed: ParsedPath
    var pathString: String { String(decoding: path, as: UTF8.self) }
}

struct RefusedRow {
    let line: Int
    let path: Bytes
    let reason: String
    var pathString: String { String(decoding: path, as: UTF8.self) }
}

struct Snapshot {
    var dirs: [MemberDir] = []
    var start: String? = nil
    var rows: [FileRow] = []
    var refused: [RefusedRow] = []
    var fileRowCount = 0
}

let headingURL = Array("https://s3cab.plantegral.com/guide/format".utf8)
let bom: Bytes = [0xEF, 0xBB, 0xBF]

private struct RawFileRow {
    let line: Int
    let fields: [ArraySlice<UInt8>]
}

/// Parse and validate a decompressed snapshot. Throws RefuseWhole; otherwise per-row refusals are listed.
func parseSnapshot(_ textIn: Bytes) throws -> Snapshot {
    var text = textIn[...]
    if text.starts(with: bom) { text = text.dropFirst(3) }     // forgiven, per the spec
    guard isValidUTF8(text) else { throw RefuseWhole(reason: "not valid UTF-8") }
    let data = Array(text)
    guard !data.isEmpty else { throw RefuseWhole(reason: "empty file") }
    let (lines, terminated) = splitLF(data)
    guard terminated else { throw RefuseWhole(reason: "last line has no LF: the file was cut short") }
    guard lines.count >= 2 else { throw RefuseWhole(reason: "fewer than two lines: no heading row and '.'") }

    // The heading row: five fields, the first four trimmed, the fifth verbatim.
    let hf = splitFields(lines[0])
    guard trimField(hf[0]) == "@S3CAB", trimField(hf[1]) == "FORMAT", trimField(hf[2]) == "size", trimField(hf[3]) == "time", Array(hf[4]) == headingURL else {
        throw RefuseWhole(reason: "first line is not the heading row")
    }
    // The last line: exactly ".".
    guard Array(lines[lines.count - 1]) == [0x2E] else {
        throw RefuseWhole(reason: "last line is not '.': the file is truncated or has something after the '.'")
    }

    var snap = Snapshot()
    var raws: [RawFileRow] = []
    for i in 1..<(lines.count - 1) {
        let line = lines[i]
        let lineNo = i + 1
        if line.isEmpty { throw RefuseWhole(reason: "blank line at line \(lineNo)") }
        let f = splitFields(line)
        let type = trimField(f[0])
        if type == "-" {
            raws.append(RawFileRow(line: lineNo, fields: f))
        } else if type.hasPrefix("@") {
            let prop = trimField(f[1])
            if type == "@SET" && prop == "DIR" {
                let value = Array(f[4])
                if !value.isEmpty { snap.dirs.append(MemberDir(raw: value)) }
            } else if type == "@SNAPSHOT" && prop == "START" {
                let instant = trimField(f[3])
                if snap.start == nil, parseInstant(instant) != nil { snap.start = instant }
            }
        } else if type.hasPrefix("#") {
            continue
        } else {
            throw RefuseWhole(reason: "unknown row type '\(type)' at line \(lineNo), starting with neither '@' nor '#'")
        }
    }
    snap.fileRowCount = raws.count

    // One path in two file rows refuses both, malformed rows included.
    var byPath: [Bytes: [Int]] = [:]
    for (idx, r) in raws.enumerated() { byPath[Array(r.fields[4]), default: []].append(idx) }
    var refusedIdx = Set<Int>()
    for (_, idxs) in byPath where idxs.count > 1 {
        for i in idxs {
            refusedIdx.insert(i)
            snap.refused.append(RefusedRow(line: raws[i].line, path: Array(raws[i].fields[4]), reason: "path appears in \(idxs.count) file rows (lines \(idxs.map { raws[$0].line }.sorted()))"))
        }
    }

    // Per-row checks.
    var survivors: [FileRow] = []
    for (idx, r) in raws.enumerated() where !refusedIdx.contains(idx) {
        let path = Array(r.fields[4])
        func refuse(_ why: String) {
            refusedIdx.insert(idx)
            snap.refused.append(RefusedRow(line: r.line, path: path, reason: why))
        }
        let hash = trimField(r.fields[1])
        let size = trimField(r.fields[2])
        let mtime = trimField(r.fields[3])
        guard isLowerHex64(hash) else { refuse("hash is not 64 lowercase hex characters"); continue }
        guard isAllDigits(size) else { refuse("size is not decimal digits"); continue }
        guard let ms = parseInstant(mtime) else { refuse("modification time is not a real instant in the 24-character form"); continue }
        let parsed = parsePath(path, stripTrailingSeparators: false)
        if let why = fileRowPathProblem(path, parsed: parsed) { refuse(why); continue }
        let keys = parsed!.matchKeys
        var under = false
        var equal = false
        for d in snap.dirs {
            switch match(path: parsed!, pathKeys: keys, dir: d) {
            case .under: under = true
            case .equal: equal = true
            case .no: break
            }
        }
        if equal { refuse("path equals a @SET DIR") ; continue }
        if !under { refuse("path is under no @SET DIR"); continue }
        survivors.append(FileRow(line: r.line, hash: hash, size: size, mtimeMs: ms, mtimeText: mtime, path: path, parsed: parsed!))
    }

    // Last: one path running through another as a folder, among the survivors. Both are refused.
    let pathSet = Set(survivors.map { $0.path })
    var runThrough = Set<Bytes>()
    for s in survivors {
        let b = s.path
        for j in 1..<b.count where (s.parsed.isWindows ? isWinSep(b[j]) : b[j] == 0x2F) {
            let prefix = Array(b[0..<j])
            if pathSet.contains(prefix) {
                runThrough.insert(prefix)
                runThrough.insert(b)
            }
        }
    }
    for s in survivors where runThrough.contains(s.path) {
        snap.refused.append(RefusedRow(line: s.line, path: s.path, reason: "path runs through, or is run through by, another file row's path"))
    }
    snap.rows = survivors.filter { !runThrough.contains($0.path) }
    snap.refused.sort { $0.line < $1.line }
    return snap
}

/// The deletion records, read as one set: each hash's newest instant.
struct DeletionRecords {
    var newest: [String: String] = [:]
    var files = 0
    var rows = 0
    var malformed = 0
    var invalidFiles: [String] = []

    mutating func add(record key: String, bytes: Bytes) {
        files += 1
        var text = bytes[...]
        if text.starts(with: bom) { text = text.dropFirst(3) }
        let (lines, _) = splitLF(Array(text))
        for line in lines {
            guard isValidUTF8(line) else { malformed += 1; continue }
            let f = splitFields(line)
            guard trimField(f[0]) == "#deleted" else { continue }
            let hash = trimField(f[1]), size = trimField(f[2]), instant = trimField(f[3])
            guard isLowerHex64(hash), isAllDigits(size), parseInstant(instant) != nil else { malformed += 1; continue }
            rows += 1
            if let old = newest[hash], !bytesLess(Array(old.utf8), Array(instant.utf8)) { continue }
            newest[hash] = instant
        }
    }

    /// Deliberately deleted for a snapshot with this START: a row later than START, compared as text.
    func deletionDate(hash: String, start: String?) -> String? {
        guard let start, let inst = newest[hash] else { return nil }
        return bytesLess(Array(start.utf8), Array(inst.utf8)) ? inst : nil
    }
}
