import Foundation

// The well-formed #deleted rows of one record file: before any `.`, each ended by an LF, decoded line by line.
func parseDeletionRecord(_ data: Bytes) -> [(hash: Bytes, instant: Bytes)] {
    var out: [(Bytes, Bytes)] = []
    let (lines, terminated) = splitLF(data)
    for (i, line) in lines.enumerated() {
        if i == lines.count - 1 && !terminated { break }   // a last row with no LF explains nothing
        if line == bytes(".") { break }
        guard isValidUTF8(line) else { continue }
        let f = splitFields(line)
        guard trimField(f[0]) == bytes("#deleted") else { continue }
        let hash = trimField(field(f, 1))
        guard isLowerHex64(hash), isDigits(trimField(field(f, 2))), let inst = parseInstant(trimField(field(f, 3))) else { continue }
        out.append((hash, inst.text))
    }
    return out
}

func isDeletionRecordKey(_ key: String) -> Bool {
    let u = Array(key.utf8)
    let pre = bytes("objects.deleted-"), suf = bytes(".tsv")
    guard u.count > pre.count + suf.count, Array(u[0..<pre.count]) == pre, Array(u[(u.count - suf.count)...]) == suf else { return false }
    let n = Array(u[pre.count..<(u.count - suf.count)])
    return isDigits(n) && n[0] != 0x30
}

// Every record read as one set: hash -> the newest instant that lists it.
func loadDeletionRecords(_ s3: S3Client) throws -> [Bytes: Bytes] {
    var merged: [Bytes: Bytes] = [:]
    let listing = try s3.list(prefix: "objects.deleted-")
    let keys = listing.keys.filter(isDeletionRecordKey)
    for k in keys {
        let sink = MemorySink()
        switch try s3.get(key: k, sink: sink) {
        case .miss: fputs("note: deletion record \(k) was listed but is gone; it explains nothing\n", stderr); continue
        case .ok: break
        }
        for (h, inst) in parseDeletionRecord(sink.data) {
            if let old = merged[h], !old.lexicographicallyPrecedes(inst) { continue }
            merged[h] = inst
        }
    }
    fputs("read \(keys.count) deletion record(s), \(merged.count) hash(es)\n", stderr)
    return merged
}
