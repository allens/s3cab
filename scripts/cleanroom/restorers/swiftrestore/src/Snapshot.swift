import Foundation

struct FileRow {
    /// 1-based line number in the decompressed text.
    let line: Int
    /// Trimmed column 2. Only meaningful when the row is not refused.
    let hash: String
    /// Column 4, when it is a real instant.
    let instant: Instant?
    /// The last field, verbatim.
    let path: [UInt8]
    /// Folder names and then the file name, under the output folder. Empty when refused.
    var landing: [[UInt8]] = []
    /// Why this one path is refused; nil when the row restores.
    var refusal: String? = nil
}

struct Snapshot {
    var rows: [FileRow] = []
    /// Every @SET DIR value that has one, verbatim.
    var dirValues: [[UInt8]] = []
    /// The last @SNAPSHOT START's instant; nil when there is none or the last isn't a real one.
    var start: Instant? = nil
    var lineCount = 0
}

/// The whole file is refused: nothing of it is restored.
struct Refused: Error {
    let message: String
}

let utf8BOM: [UInt8] = [0xEF, 0xBB, 0xBF]
private let typeFile: [UInt8] = [0x2D]
private let typeSet = Array("@SET".utf8)
private let typeSnapshot = Array("@SNAPSHOT".utf8)
private let propDir = Array("DIR".utf8)
private let propStart = Array("START".utf8)

/// Reads a snapshot's decompressed text, whole, before anything is restored from it.
func parseSnapshot(text whole: [UInt8]) throws -> Snapshot {
    // UTF-8, strictly. A decode error means damage, not another encoding.
    guard strictUTF8(whole) != nil else { throw Refused(message: "not valid UTF-8") }
    // A byte-order mark at the very start is read past, as s3cab does.
    let text = whole.starts(with: utf8BOM) ? Array(whole.dropFirst(3)) : whole
    guard let last = text.last else { throw Refused(message: "empty: no heading row and no final `.`") }
    guard last == 0x0A else { throw Refused(message: "the last line has no LF: the file was cut short") }

    // Split on LF exactly. The text ends with LF, so the piece after the last one is empty.
    var lines = [ArraySlice<UInt8>]()
    var lineStart = 0
    for i in 0..<text.count where text[i] == 0x0A {
        lines.append(text[lineStart..<i])
        lineStart = i + 1
    }

    guard isHeadingRow(lines[0]) else { throw Refused(message: "the first line is not the heading row") }
    guard lines.count >= 2, Array(lines[lines.count - 1]) == [0x2E] else {
        throw Refused(message: "the last line is not `.`: the file was cut short, or something follows its end")
    }

    var snap = Snapshot()
    snap.lineCount = lines.count
    struct Raw {
        var line: Int
        var x: Fields
    }
    var raws = [Raw]()

    for n in 1..<(lines.count - 1) {
        let line = lines[n]
        if trimmed(line).isEmpty { throw Refused(message: "line \(n + 1) is blank") }
        let x = splitFields(line)
        let type = trimmed(x.f[0])
        if type == typeFile {
            raws.append(Raw(line: n + 1, x: x))
        } else if type.first == 0x40 {          // "@": a property; skip the ones not known
            let prop = trimmed(x.f[1])
            if type == typeSet && prop == propDir {
                // Fewer than five fields is no value, and an empty value is no directory.
                if x.present == 5 && !x.f[4].isEmpty { snap.dirValues.append(Array(x.f[4])) }
            } else if type == typeSnapshot && prop == propStart {
                snap.start = parseInstant(trimmed(x.f[3]))      // the last one counts, real or not
            }
        } else if type.first == 0x23 {          // "#": nothing a restore acts on
            continue
        } else {
            throw Refused(message: "line \(n + 1) has an unknown row type `\(printable(type))`")
        }
    }

    let dirs = snap.dirValues.compactMap { MemberDir(value: $0) }
    var lowered = [[UInt8]: [UInt8]]()
    func lower(_ seg: [UInt8]) -> [UInt8] {
        if let l = lowered[seg] { return l }
        let l = lowercasedForMatching(seg)
        lowered[seg] = l
        return l
    }

    // Each file row on its own.
    var parsed = [ParsedPath?]()
    for raw in raws {
        let x = raw.x
        let hash = trimmed(x.f[1])
        let size = trimmed(x.f[2])
        let instant = parseInstant(trimmed(x.f[3]))
        let path = Array(x.f[4])
        var row = FileRow(line: raw.line, hash: String(decoding: hash, as: UTF8.self), instant: instant, path: path)
        var pp: ParsedPath? = nil

        if x.present < 5 {
            row.refusal = "malformed row: fewer than five fields"
        } else if !isHash(hash) {
            row.refusal = "malformed row: the hash is not 64 lowercase hex characters"
        } else if !isDecimal(size) {
            row.refusal = "malformed row: the size is not decimal digits"
        } else if instant == nil {
            row.refusal = "malformed row: the time is not a real instant in the 24-character form"
        } else if path.contains(0x09) {
            row.refusal = "the path holds a tab"
        } else if path.contains(0x0D) {
            row.refusal = "the path holds a CR"
        } else if path.contains(0x00) {
            row.refusal = "the path holds a NUL"
        } else if let p = parsePath(path) {
            if p.segments.isEmpty {
                row.refusal = "the path is a root, not a file"
            } else if p.segments.contains(where: { $0.isEmpty }) {
                row.refusal = "the path has an empty segment (a doubled or trailing separator)"
            } else if p.segments.contains(where: { $0 == [0x2E] || $0 == [0x2E, 0x2E] }) {
                row.refusal = "the path has a `.` or `..` segment"
            } else {
                let segs = p.isWindows ? p.segments.map(lower) : p.segments
                var inside = false
                var equal = false
                for d in dirs {
                    switch relation(of: p.kind, drive: p.drive, rowSegments: segs, to: d) {
                    case .inside: inside = true
                    case .equal: equal = true
                    case .outside: break
                    }
                }
                if equal {
                    row.refusal = "the path is a @SET DIR itself"
                } else if !inside {
                    row.refusal = "the path is under no @SET DIR"
                } else {
                    pp = p
                }
            }
        } else {
            row.refusal = "the path is not absolute"
        }
        snap.rows.append(row)
        parsed.append(pp)
    }

    // One path in two file rows: both refused, a malformed twin included. Compared as bytes.
    var seen = [[UInt8]: [Int]]()
    for (i, row) in snap.rows.enumerated() { seen[row.path, default: []].append(i) }
    for (_, idxs) in seen where idxs.count > 1 {
        for i in idxs {
            snap.rows[i].refusal = "the path is in \(idxs.count) file rows (lines \(idxs.map { String(snap.rows[$0].line) }.joined(separator: ", ")))"
            parsed[i] = nil
        }
    }

    // One path running through another as a folder: last, among the rows every other check let
    // through. An exact prefix, then any separator of the path's kind.
    var standing = [[UInt8]: Int]()
    for (i, row) in snap.rows.enumerated() where row.refusal == nil { standing[row.path] = i }
    var through = [Int: String]()
    for (i, row) in snap.rows.enumerated() where row.refusal == nil {
        guard let p = parsed[i] else { continue }
        let path = row.path
        for cut in p.rootLength..<path.count where isSeparator(path[cut], windows: p.isWindows) {
            if let j = standing[Array(path[0..<cut])] {
                through[i] = "the path runs through line \(snap.rows[j].line)'s file as a folder"
                through[j] = "the path is a file that line \(row.line) runs through as a folder"
            }
        }
    }
    for (i, why) in through {
        snap.rows[i].refusal = why
        parsed[i] = nil
    }

    for i in snap.rows.indices {
        if let p = parsed[i], snap.rows[i].refusal == nil { snap.rows[i].landing = landingComponents(p) }
    }
    return snap
}

// MARK: deletion records

struct DeletionRecord {
    /// The well-formed #deleted rows before the first `.`, each ended by an LF.
    var rows: [(hash: String, instant: String)] = []
    /// Why the record is not valid; empty when it is. A restore counts the rows either way.
    var faults: [String] = []
}

private let typeDeleted = Array("#deleted".utf8)

/// A record is read line by line and never refused whole: each line is decoded on its own.
func parseDeletionRecord(_ data: [UInt8]) -> DeletionRecord {
    var rec = DeletionRecord()
    var lineStart = data.starts(with: utf8BOM) ? 3 : 0      // a BOM at the very start is read past
    var lineNo = 0
    var ended = false
    var afterEnd = false
    for i in lineStart..<data.count where data[i] == 0x0A {
        let line = data[lineStart..<i]
        lineStart = i + 1
        lineNo += 1
        if ended {
            afterEnd = true
            continue
        }
        if Array(line) == [0x2E] {
            ended = true
            continue
        }
        guard strictUTF8(line) != nil else {
            rec.faults.append("line \(lineNo) is not UTF-8")
            continue
        }
        if lineNo == 1 {
            if isHeadingRow(line) { continue }
            rec.faults.append("the first line is not the heading row")
        }
        if trimmed(line).isEmpty {
            rec.faults.append("line \(lineNo) is blank")
            continue
        }
        let x = splitFields(line)
        let type = trimmed(x.f[0])
        if type == typeDeleted {
            let hash = trimmed(x.f[1])
            let instant = trimmed(x.f[3])
            if isHash(hash), isDecimal(trimmed(x.f[2])), let t = parseInstant(instant) {
                rec.rows.append((String(decoding: hash, as: UTF8.self), t.text))
            } else {
                rec.faults.append("line \(lineNo) is a malformed #deleted row")
            }
        } else if type.first != 0x40 && type.first != 0x23 {
            rec.faults.append("line \(lineNo) has a row type a record can't hold")
        }
    }
    if lineStart < data.count {
        if ended { afterEnd = true } else { rec.faults.append("the last line has no LF") }
    }
    if !ended { rec.faults.append("no final `.`") }
    if afterEnd { rec.faults.append("something follows the `.`") }
    return rec
}

func isDeletionRecordKey(_ key: String) -> Bool {
    let k = Array(key.utf8)
    let pre = Array("objects.deleted-".utf8)
    let suf = Array(".tsv".utf8)
    guard k.count > pre.count + suf.count, Array(k.prefix(pre.count)) == pre, Array(k.suffix(suf.count)) == suf else { return false }
    let n = Array(k[pre.count..<(k.count - suf.count)])
    return isDecimal(n) && n[0] != 0x30
}

/// `YYYYMMDDTHHMM`: digits in those places and nothing more. Not checked as a date.
func isSnapshotName(_ name: [UInt8]) -> Bool {
    guard name.count == 13 else { return false }
    for (i, b) in name.enumerated() {
        if i == 8 {
            if b != 0x54 { return false }
        } else if b < 0x30 || b > 0x39 {
            return false
        }
    }
    return true
}
