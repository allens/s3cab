import Foundation

struct DirEntry {
    let line: Int
    let raw: [UInt8]
    let parsed: ParsedPath?      // nil: not absolute, or has an empty segment, so matches nothing
    /// The folder a restore to a chosen directory lands this DIR's files in; nil for `/`.
    let folderName: [UInt8]?
}

struct FileRow {
    let line: Int
    let hash: String
    let size: String
    let mtimeMs: Int64
    let path: [UInt8]
    let parsed: ParsedPath
    var dirIndex: Int = -1
}

struct Refusal { let line: Int; let path: [UInt8]; let reason: String }

struct Snapshot {
    var dirs: [DirEntry] = []
    var rows: [FileRow] = []          // rows every check let through, in file order
    var refusals: [Refusal] = []
    var fileRowCount = 0
    var info: [String: String] = [:]  // a few @ properties, for messages only
}

enum SnapshotParser {
    static let headingLead = ["@S3CAB", "FORMAT", "size", "time"]
    static let headingLast = Array("https://s3cab.plantegral.com/guide/format".utf8)

    static func parse(_ raw: [UInt8]) throws -> Snapshot {
        let bytes = TextRules.stripBOM(raw)
        guard TextRules.validateUTF8(bytes) else { throw RestoreFailure("snapshot refused: not valid UTF-8") }
        let (lines, terminated) = TextRules.lines(bytes)
        guard !lines.isEmpty else { throw RestoreFailure("snapshot refused: empty file") }
        guard terminated else { throw RestoreFailure("snapshot refused: last line has no LF, the file was cut short") }
        let head = TextRules.fields(lines[0])
        guard head.lead == headingLead, head.last == headingLast else {
            throw RestoreFailure("snapshot refused: first line is not the heading row")
        }
        // The `.` is the last non-blank line.
        var dot = lines.count - 1
        while dot > 0 && TextRules.isBlank(lines[dot]) { dot -= 1 }
        guard dot > 0, lines[dot] == [UInt8(ascii: ".")] else {
            throw RestoreFailure("snapshot refused: last line is not `.`, the file was cut short")
        }

        var snap = Snapshot()
        struct Candidate { let line: Int; let lead: [String]; let last: [UInt8]; let tabs: Int }
        var candidates: [Candidate] = []
        for i in 1..<dot {
            let line = lines[i]
            if TextRules.isBlank(line) { continue }
            let f = TextRules.fields(line)
            let type = f.lead[0]
            if type == "-" {
                candidates.append(Candidate(line: i + 1, lead: f.lead, last: f.last, tabs: f.tabCount))
            } else if type.hasPrefix("@") {
                if type == "@SET" && f.lead[1] == "DIR" {
                    if f.tabCount == 4 && !f.last.isEmpty {
                        var parsed = ParsedPath.parse(f.last, stripTrailingSeparators: true)
                        if let p = parsed, p.hasEmptySegment { parsed = nil }
                        if let p = parsed, p.isShare, p.segments.isEmpty { parsed = nil }
                        var name: [UInt8]? = nil
                        if let p = parsed {
                            if let last = p.segments.last { name = last }
                            else if let l = p.driveLetter { name = [l] }
                        }
                        snap.dirs.append(DirEntry(line: i + 1, raw: f.last, parsed: parsed, folderName: name))
                    }
                } else if (type == "@SET" || type == "@SNAPSHOT" || type == "@S3CAB" || type == "@CLIENT") && f.tabCount == 4 {
                    snap.info["\(type) \(f.lead[1])"] = String(decoding: f.last, as: UTF8.self)
                }
            } else if type.hasPrefix("#") {
                continue
            } else {
                throw RestoreFailure("snapshot refused: line \(i + 1) has unknown row type \(String(reflecting: type))")
            }
        }
        snap.fileRowCount = candidates.count

        // Per-row checks. Malformed rows still take part in the one-path-in-two-rows check.
        var refusedLines = Set<Int>()
        var reasons: [Int: String] = [:]
        var parsedRows: [Int: FileRow] = [:]
        for c in candidates {
            var why: [String] = []
            if !TextRules.isLowerHex64(c.lead[1]) { why.append("hash is not 64 lowercase hex characters") }
            if !TextRules.isDecimal(c.lead[2]) { why.append("size is not decimal digits") }
            let ms = Instant.parseMillis(c.lead[3])
            if ms == nil { why.append("time is not a real instant in the 24-character form") }
            if c.tabs < 4 { why.append("fewer than five fields") }
            let path = c.last
            if path.contains(0x0D) { why.append("path holds a CR") }
            if path.contains(0x09) { why.append("path holds a tab") }
            if path.contains(0x00) { why.append("path holds a NUL") }
            var parsed: ParsedPath? = nil
            if !ParsedPath.isAbsolute(path) { why.append("path is not absolute") }
            else {
                parsed = ParsedPath.parse(path, stripTrailingSeparators: false)
                if let p = parsed {
                    if p.hasEmptySegment { why.append("path has an empty segment (doubled or trailing separator)") }
                    if p.hasDotSegment { why.append("path has a `.` or `..` segment") }
                    if p.segments.isEmpty { why.append("path is a root, not a file") }
                }
            }
            if why.isEmpty, let p = parsed, let ms {
                parsedRows[c.line] = FileRow(line: c.line, hash: c.lead[1], size: c.lead[2], mtimeMs: ms, path: path, parsed: p)
            } else {
                refusedLines.insert(c.line); reasons[c.line] = why.joined(separator: "; ")
            }
        }
        // One path in two rows, compared exactly as bytes: both refused.
        var byPath: [[UInt8]: [Int]] = [:]
        for c in candidates { byPath[c.last, default: []].append(c.line) }
        for (_, ls) in byPath where ls.count > 1 {
            for l in ls {
                refusedLines.insert(l)
                reasons[l] = (reasons[l].map { $0 + "; " } ?? "") + "path is in more than one row (lines \(ls.map(String.init).joined(separator: ", ")))"
            }
        }
        // Place each surviving row under a DIR: longest match wins, first of equals; never a DIR itself.
        var placed: [FileRow] = []
        for c in candidates where !refusedLines.contains(c.line) {
            guard var row = parsedRows[c.line] else { continue }
            var best = -1
            var bestLen = -1
            var isDir = false
            for (i, d) in snap.dirs.enumerated() {
                guard let dp = d.parsed else { continue }
                if dp.equals(row.parsed) { isDir = true; break }
                if dp.contains(row.parsed), dp.cmpSegments.count > bestLen { best = i; bestLen = dp.cmpSegments.count }
            }
            if isDir { refusedLines.insert(c.line); reasons[c.line] = "path is a @SET DIR itself"; continue }
            if best < 0 { refusedLines.insert(c.line); reasons[c.line] = "path is under no @SET DIR"; continue }
            row.dirIndex = best
            placed.append(row)
        }
        // Last: one path running through another as a folder, exact bytes, among survivors.
        let survivors = Set(placed.map { $0.path })
        var through = Set<[UInt8]>()
        for row in placed {
            let p = row.path
            for i in row.parsed.rootLength..<p.count where ParsedPath.isSep(p[i], row.parsed.kind) {
                let prefix = Array(p[0..<i])
                if survivors.contains(prefix) { through.insert(prefix); through.insert(p) }
            }
        }
        for row in placed where through.contains(row.path) {
            refusedLines.insert(row.line); reasons[row.line] = "path runs through, or is run through by, another file row's path"
        }
        snap.rows = placed.filter { !through.contains($0.path) }
        for c in candidates where refusedLines.contains(c.line) {
            snap.refusals.append(Refusal(line: c.line, path: c.last, reason: reasons[c.line] ?? "malformed"))
        }
        snap.refusals.sort { $0.line < $1.line }
        return snap
    }
}
