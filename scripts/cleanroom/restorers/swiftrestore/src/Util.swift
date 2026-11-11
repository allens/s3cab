import Foundation

typealias Bytes = [UInt8]

let TAB: UInt8 = 0x09
let LF: UInt8 = 0x0A
let CR: UInt8 = 0x0D

func bytes(_ s: String) -> Bytes { Array(s.utf8) }

func hexEncode(_ b: Bytes) -> String {
    let d = Array("0123456789abcdef".utf8)
    var out = Bytes(); out.reserveCapacity(b.count * 2)
    for x in b { out.append(d[Int(x >> 4)]); out.append(d[Int(x & 15)]) }
    return String(decoding: out, as: UTF8.self)
}

struct SHA256Hasher {
    private var ctx = CC_SHA256_CTX()
    init() { CC_SHA256_Init(&ctx) }
    mutating func update(_ p: UnsafeRawPointer?, _ n: Int) { if n > 0, let p = p { CC_SHA256_Update(&ctx, p, CC_LONG(n)) } }
    mutating func update(_ b: Bytes) { b.withUnsafeBytes { update($0.baseAddress, $0.count) } }
    mutating func finish() -> Bytes { var out = Bytes(repeating: 0, count: 32); CC_SHA256_Final(&out, &ctx); return out }
}

func sha256(_ b: Bytes) -> Bytes { var h = SHA256Hasher(); h.update(b); return h.finish() }

func hmacSHA256(key: Bytes, data: Bytes) -> Bytes {
    var out = Bytes(repeating: 0, count: 32)
    key.withUnsafeBytes { k in data.withUnsafeBytes { d in
        CCHmac(CCHmacAlgorithm(kCCHmacAlgSHA256), k.baseAddress, k.count, d.baseAddress, d.count, &out) } }
    return out
}

// The trim set: exactly JavaScript's trim() set, as the spec lists it.
func isTrimScalar(_ v: UInt32) -> Bool {
    switch v {
    case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x202F, 0x205F, 0x3000, 0x2028, 0x2029, 0xFEFF: return true
    default: return false
    }
}

// Trim a leading field. The caller guarantees valid UTF-8.
func trimField(_ b: Bytes) -> Bytes {
    let scalars = Array(String(decoding: b, as: UTF8.self).unicodeScalars)
    var lo = 0, hi = scalars.count
    while lo < hi, isTrimScalar(scalars[lo].value) { lo += 1 }
    while hi > lo, isTrimScalar(scalars[hi - 1].value) { hi -= 1 }
    if lo == 0 && hi == scalars.count { return b }
    var v = String.UnicodeScalarView(); v.append(contentsOf: scalars[lo..<hi])
    return Array(String(v).utf8)
}

func isValidUTF8(_ b: Bytes) -> Bool { String(validating: b, as: UTF8.self) != nil }

// Split on LF alone. Lines come back without their LF; `lastTerminated` says whether the final byte was an LF.
func splitLF(_ b: Bytes) -> (lines: [Bytes], lastTerminated: Bool) {
    var lines: [Bytes] = []
    var start = 0
    for i in 0..<b.count where b[i] == LF {
        lines.append(Array(b[start..<i])); start = i + 1
    }
    if start < b.count { lines.append(Array(b[start...])); return (lines, false) }
    return (lines, b.count > 0)
}

// Five fields, split at the first four tabs. Returns 1 to 5 fields; a missing one reads as empty.
func splitFields(_ line: Bytes) -> [Bytes] {
    var fields: [Bytes] = []
    var start = 0, i = 0
    while fields.count < 4, i < line.count {
        if line[i] == TAB { fields.append(Array(line[start..<i])); start = i + 1 }
        i += 1
    }
    fields.append(Array(line[start...]))
    return fields
}
func field(_ f: [Bytes], _ i: Int) -> Bytes { i < f.count ? f[i] : [] }

func isLowerHex64(_ b: Bytes) -> Bool {
    b.count == 64 && b.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
}
func isDigits(_ b: Bytes) -> Bool { !b.isEmpty && b.allSatisfy { $0 >= 0x30 && $0 <= 0x39 } }

// Spell control characters out before printing a path.
func display(_ b: Bytes) -> String {
    guard let s = String(validating: b, as: UTF8.self) else {
        return b.map { String(format: "\\x%02x", $0) }.joined()
    }
    var out = ""
    for u in s.unicodeScalars {
        let v = u.value
        if v < 0x20 || v == 0x7F || (0x80...0x9F).contains(v) || v == 0x2028 || v == 0x2029 || v == 0xFEFF {
            out += v < 0x100 ? String(format: "\\x%02x", v) : String(format: "\\u%04x", v)
        } else { out.unicodeScalars.append(u) }
    }
    return out
}

// An instant in the 24-character form YYYY-MM-DDTHH:MM:SS.sssZ, checked to be a real one.
struct Instant {
    let text: Bytes
    let unixSeconds: Int64
    let millis: Int
    var milliseconds: Int64 { unixSeconds * 1000 + Int64(millis) }
}

private func daysFromCivil(_ y0: Int, _ m: Int, _ d: Int) -> Int {
    let y = m <= 2 ? y0 - 1 : y0
    let era = (y >= 0 ? y : y - 399) / 400
    let yoe = y - era * 400
    let doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146097 + doe - 719468
}

func parseInstant(_ b: Bytes) -> Instant? {
    guard b.count == 24 else { return nil }
    func num(_ r: Range<Int>) -> Int? {
        var v = 0
        for i in r { let c = b[i]; guard c >= 0x30 && c <= 0x39 else { return nil }; v = v * 10 + Int(c - 0x30) }
        return v
    }
    guard b[4] == 0x2D, b[7] == 0x2D, b[10] == 0x54, b[13] == 0x3A, b[16] == 0x3A, b[19] == 0x2E, b[23] == 0x5A,
          let y = num(0..<4), let mo = num(5..<7), let d = num(8..<10), let h = num(11..<13),
          let mi = num(14..<16), let s = num(17..<19), let ms = num(20..<23) else { return nil }
    guard (1...12).contains(mo), h <= 23, mi <= 59, s <= 59 else { return nil }
    let leap = (y % 4 == 0) && (y % 100 != 0 || y % 400 == 0)
    let dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]
    guard d >= 1, d <= dim else { return nil }
    let days = daysFromCivil(y, mo, d)
    let secs = Int64(days) * 86400 + Int64(h * 3600 + mi * 60 + s)
    return Instant(text: b, unixSeconds: secs, millis: ms)
}

func cpath(_ b: Bytes) -> [CChar] { b.map { CChar(bitPattern: $0) } + [0] }
func errnoText() -> String { String(cString: strerror(s3cab_errno())) }
