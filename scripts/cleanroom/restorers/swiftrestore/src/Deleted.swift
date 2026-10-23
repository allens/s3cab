import Foundation

/// Every objects.deleted-<n>.tsv read as one set: hash -> newest deletion instant text.
struct DeletionRecords {
    var byHash: [String: String] = [:]
    var files: [String] = []
    var problems: [String] = []

    static let keyPattern = try! NSRegularExpression(pattern: "^objects\\.deleted-(0|[1-9][0-9]*)\\.tsv$")

    static func load(from s3: S3Client) throws -> DeletionRecords {
        var recs = DeletionRecords()
        let listing = try s3.list(prefix: "objects.deleted-", delimiter: "/")
        for key in listing.keys {
            let range = NSRange(key.startIndex..., in: key)
            guard let m = keyPattern.firstMatch(in: key, range: range) else { continue }
            let n = String(key[Range(m.range(at: 1), in: key)!])
            if n == "0" { continue }   // from 1 up
            switch try s3.getObject(key: key) {
            case .ok(let bytes): recs.parse(bytes, name: key)
            case .missing: recs.problems.append("\(key) vanished between listing and fetch (compacted?)")
            case .failed(let status, let code, let msg): throw RestoreFailure("fetching \(key) failed: HTTP \(status) \(code) \(msg)")
            }
            recs.files.append(key)
        }
        return recs
    }

    /// Well-formed #deleted rows count even in an invalid record; the rest is reported.
    mutating func parse(_ raw: [UInt8], name: String) {
        let bytes = TextRules.stripBOM(raw)
        let (lines, terminated) = TextRules.lines(bytes)
        var valid = terminated && !lines.isEmpty
        if let first = lines.first {
            let h = TextRules.fields(first)
            if h.lead != SnapshotParser.headingLead || h.last != SnapshotParser.headingLast { valid = false }
        }
        var dot = lines.count - 1
        while dot > 0 && TextRules.isBlank(lines[dot]) { dot -= 1 }
        if dot <= 0 || lines[dot] != [UInt8(ascii: ".")] { valid = false }
        for (i, line) in lines.enumerated() {
            if i == 0 || TextRules.isBlank(line) { continue }
            guard TextRules.validateUTF8(line) else { valid = false; continue }
            if line == [UInt8(ascii: ".")] { continue }
            let f = TextRules.fields(line)
            let type = f.lead[0]
            if type == "#deleted" {
                let hash = f.lead[1]
                if TextRules.isLowerHex64(hash), TextRules.isDecimal(f.lead[2]), let ms = Instant.parseMillis(f.lead[3]) {
                    if let old = byHash[hash], let oldMs = Instant.parseMillis(old), oldMs >= ms { continue }
                    byHash[hash] = f.lead[3]
                } else {
                    valid = false
                    problems.append("\(name) line \(i + 1): malformed #deleted row, refused")
                }
            } else if type.hasPrefix("@") || type.hasPrefix("#") {
                continue
            } else {
                valid = false
                problems.append("\(name) line \(i + 1): unknown row type \(String(reflecting: type))")
            }
        }
        if !valid { problems.append("\(name) is not a valid deletion record; its well-formed rows still count") }
    }
}
