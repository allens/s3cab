import Foundation

typealias Bytes = [UInt8]

let LF: UInt8 = 0x0A
let CR: UInt8 = 0x0D
let TAB: UInt8 = 0x09

func eprint(_ s: String) {
    FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
}
func oprint(_ s: String) {
    FileHandle.standardOutput.write((s + "\n").data(using: .utf8)!)
}

/// Strict UTF-8 validation: rejects overlong forms, surrogates, code points past U+10FFFF, and cut sequences.
func isValidUTF8(_ b: ArraySlice<UInt8>) -> Bool {
    var i = b.startIndex
    let end = b.endIndex
    while i < end {
        let c = b[i]
        if c < 0x80 { i += 1; continue }
        var need = 0
        var minCP: UInt32 = 0
        var cp: UInt32 = 0
        if c & 0xE0 == 0xC0 { need = 1; cp = UInt32(c & 0x1F); minCP = 0x80 }
        else if c & 0xF0 == 0xE0 { need = 2; cp = UInt32(c & 0x0F); minCP = 0x800 }
        else if c & 0xF8 == 0xF0 { need = 3; cp = UInt32(c & 0x07); minCP = 0x10000 }
        else { return false }
        if end - i <= need { return false }
        for k in 1...need {
            let cc = b[i + k]
            if cc & 0xC0 != 0x80 { return false }
            cp = (cp << 6) | UInt32(cc & 0x3F)
        }
        if cp < minCP || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF) { return false }
        i += need + 1
    }
    return true
}

/// Split on LF exactly. The text after the final LF, if any, is returned as an unterminated last line.
func splitLF(_ data: Bytes) -> (lines: [ArraySlice<UInt8>], lastTerminated: Bool) {
    var lines: [ArraySlice<UInt8>] = []
    var start = 0
    for (i, b) in data.enumerated() where b == LF {
        lines.append(data[start..<i])
        start = i + 1
    }
    if start < data.count {
        lines.append(data[start..<data.count])
        return (lines, false)
    }
    return (lines, true)
}

/// Five fields, split at the first four tabs. Missing fields read as empty.
func splitFields(_ line: ArraySlice<UInt8>) -> [ArraySlice<UInt8>] {
    var fields: [ArraySlice<UInt8>] = []
    var start = line.startIndex
    var i = line.startIndex
    while i < line.endIndex && fields.count < 4 {
        if line[i] == TAB {
            fields.append(line[start..<i])
            start = i + 1
        }
        i += 1
    }
    fields.append(line[start..<line.endIndex])
    while fields.count < 5 { fields.append(line[line.endIndex..<line.endIndex]) }
    return fields
}

/// JavaScript's trim() set, exactly as the spec lists it.
func isTrimScalar(_ s: Unicode.Scalar) -> Bool {
    switch s.value {
    case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x202F, 0x205F, 0x3000, 0x2028, 0x2029, 0xFEFF:
        return true
    default:
        return false
    }
}

func trimField(_ field: ArraySlice<UInt8>) -> String {
    let s = String(decoding: field, as: UTF8.self)   // the whole file was validated as UTF-8 first
    let scalars = s.unicodeScalars
    var lo = scalars.startIndex
    var hi = scalars.endIndex
    while lo < hi && isTrimScalar(scalars[lo]) { lo = scalars.index(after: lo) }
    while hi > lo && isTrimScalar(scalars[scalars.index(before: hi)]) { hi = scalars.index(before: hi) }
    return String(String.UnicodeScalarView(scalars[lo..<hi]))
}

func isLowerHex64(_ s: String) -> Bool {
    let u = Array(s.utf8)
    if u.count != 64 { return false }
    for b in u {
        if !((b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x66)) { return false }
    }
    return true
}

func isAllDigits(_ s: String) -> Bool {
    let u = Array(s.utf8)
    if u.isEmpty { return false }
    for b in u where !(b >= 0x30 && b <= 0x39) { return false }
    return true
}

/// A real instant in the 24-character form YYYY-MM-DDTHH:MM:SS.sssZ. Returns milliseconds since the Unix epoch.
func parseInstant(_ s: String) -> Int64? {
    let u = Array(s.utf8)
    if u.count != 24 { return nil }
    func digit(_ i: Int) -> Int? { let b = u[i]; return (b >= 0x30 && b <= 0x39) ? Int(b - 0x30) : nil }
    func num(_ from: Int, _ len: Int) -> Int? {
        var v = 0
        for i in from..<(from + len) { guard let d = digit(i) else { return nil }; v = v * 10 + d }
        return v
    }
    guard u[4] == 0x2D, u[7] == 0x2D, u[10] == 0x54, u[13] == 0x3A, u[16] == 0x3A, u[19] == 0x2E, u[23] == 0x5A else { return nil }
    guard let y = num(0, 4), let mo = num(5, 2), let d = num(8, 2), let h = num(11, 2), let mi = num(14, 2), let se = num(17, 2), let ms = num(20, 3) else { return nil }
    if mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || se > 59 { return nil }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
    let dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]
    if d > dim { return nil }
    // days from civil, proleptic Gregorian (Howard Hinnant's algorithm), valid for year 0
    let y2 = mo <= 2 ? y - 1 : y
    let era = (y2 >= 0 ? y2 : y2 - 399) / 400
    let yoe = y2 - era * 400
    let mp = (mo + 9) % 12
    let doy = (153 * mp + 2) / 5 + d - 1
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    let days = era * 146097 + doe - 719468
    let secs = Int64(days) * 86400 + Int64(h) * 3600 + Int64(mi) * 60 + Int64(se)
    return secs * 1000 + Int64(ms)
}

func floorDiv(_ a: Int64, _ b: Int64) -> Int64 {
    let q = a / b
    return (a % b != 0 && (a < 0) != (b < 0)) ? q - 1 : q
}

func hex(_ data: some Sequence<UInt8>) -> String {
    let table: [Character] = Array("0123456789abcdef")
    var s = ""
    for b in data { s.append(table[Int(b >> 4)]); s.append(table[Int(b & 0x0F)]) }
    return s
}

func bytesLess(_ a: Bytes, _ b: Bytes) -> Bool {
    return a.lexicographicallyPrecedes(b)
}
