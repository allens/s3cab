import Foundation

// The five reading rules: UTF-8 (BOM forgiven at the start), split on LF alone,
// nothing escaped, leading fields trimmed by the JavaScript trim() set, last verbatim.

enum TextRules {
    static let LF: UInt8 = 0x0A
    static let TAB: UInt8 = 0x09
    static let CR: UInt8 = 0x0D

    static func isTrimScalar(_ v: UInt32) -> Bool {
        switch v {
        case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x202F, 0x205F, 0x3000, 0x2028, 0x2029, 0xFEFF:
            return true
        default: return false
        }
    }

    /// Strict UTF-8 check. Returns nil when the bytes aren't UTF-8.
    static func validateUTF8(_ bytes: [UInt8]) -> Bool {
        String(validating: bytes, as: UTF8.self) != nil
    }

    static func stripBOM(_ bytes: [UInt8]) -> [UInt8] {
        if bytes.count >= 3, bytes[0] == 0xEF, bytes[1] == 0xBB, bytes[2] == 0xBF { return Array(bytes[3...]) }
        return bytes
    }

    /// Split on LF exactly. The last line must be terminated; `terminated` says whether it was.
    static func lines(_ bytes: [UInt8]) -> (lines: [[UInt8]], terminated: Bool) {
        var out: [[UInt8]] = []
        var start = 0
        for (i, b) in bytes.enumerated() where b == LF {
            out.append(Array(bytes[start..<i])); start = i + 1
        }
        if start < bytes.count { out.append(Array(bytes[start...])); return (out, false) }
        return (out, true)
    }

    /// Trim the JavaScript trim() set from both ends of a UTF-8 field.
    static func trim(_ field: [UInt8]) -> String {
        let s = String(decoding: field, as: UTF8.self)   // bytes were validated as UTF-8 already
        let scalars = Array(s.unicodeScalars)
        var lo = 0, hi = scalars.count
        while lo < hi && isTrimScalar(scalars[lo].value) { lo += 1 }
        while hi > lo && isTrimScalar(scalars[hi - 1].value) { hi -= 1 }
        var u = String.UnicodeScalarView()
        u.append(contentsOf: scalars[lo..<hi])
        return String(u)
    }

    /// A blank line holds nothing but what the trim removes.
    static func isBlank(_ line: [UInt8]) -> Bool {
        let s = String(decoding: line, as: UTF8.self)
        return s.unicodeScalars.allSatisfy { isTrimScalar($0.value) }
    }

    /// Five fields split at the first four tabs: the first four trimmed, the last verbatim.
    /// A line with fewer tabs reads the missing fields as empty.
    static func fields(_ line: [UInt8]) -> (lead: [String], last: [UInt8], tabCount: Int) {
        var parts: [[UInt8]] = []
        var start = 0
        var tabs = 0
        var i = 0
        while i < line.count && tabs < 4 {
            if line[i] == TAB { parts.append(Array(line[start..<i])); start = i + 1; tabs += 1 }
            i += 1
        }
        let last = Array(line[start...])
        var lead = parts.map { trim($0) }
        var lastField = last
        if tabs < 4 {
            // Fewer than five fields: what we have are leading fields; the last is empty.
            lead.append(trim(last))
            while lead.count < 4 { lead.append("") }
            lastField = []
        }
        return (lead, lastField, tabs)
    }

    static func isLowerHex64(_ s: String) -> Bool {
        s.utf8.count == 64 && s.utf8.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
    }
    static func isDecimal(_ s: String) -> Bool {
        !s.isEmpty && s.utf8.allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
    }
}

enum Instant {
    /// Parses exactly YYYY-MM-DDTHH:MM:SS.sssZ into milliseconds since 1970-01-01T00:00:00Z,
    /// refusing anything that isn't a real instant. Year 0000 is allowed.
    static func parseMillis(_ s: String) -> Int64? {
        let b = Array(s.utf8)
        guard b.count == 24 else { return nil }
        func digit(_ i: Int) -> Int? { let c = b[i]; return (c >= 0x30 && c <= 0x39) ? Int(c - 0x30) : nil }
        func num(_ r: Range<Int>) -> Int? { var v = 0; for i in r { guard let d = digit(i) else { return nil }; v = v * 10 + d }; return v }
        guard b[4] == UInt8(ascii: "-"), b[7] == UInt8(ascii: "-"), b[10] == UInt8(ascii: "T"),
              b[13] == UInt8(ascii: ":"), b[16] == UInt8(ascii: ":"), b[19] == UInt8(ascii: "."), b[23] == UInt8(ascii: "Z") else { return nil }
        guard let y = num(0..<4), let mo = num(5..<7), let d = num(8..<10), let h = num(11..<13),
              let mi = num(14..<16), let se = num(17..<19), let ms = num(20..<23) else { return nil }
        guard (1...12).contains(mo), d >= 1, d <= daysInMonth(y, mo), h <= 23, mi <= 59, se <= 59 else { return nil }
        let days = daysFromCivil(Int64(y), Int64(mo), Int64(d))
        return ((days * 86400 + Int64(h) * 3600 + Int64(mi) * 60 + Int64(se)) * 1000) + Int64(ms)
    }
    static func isLeap(_ y: Int) -> Bool { (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 }
    static func daysInMonth(_ y: Int, _ m: Int) -> Int {
        switch m {
        case 1, 3, 5, 7, 8, 10, 12: return 31
        case 4, 6, 9, 11: return 30
        default: return isLeap(y) ? 29 : 28
        }
    }
    static func daysFromCivil(_ y0: Int64, _ m: Int64, _ d: Int64) -> Int64 {
        let y = m <= 2 ? y0 - 1 : y0
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let mp = (m + 9) % 12
        let doy = (153 * mp + 2) / 5 + d - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146097 + doe - 719468
    }
    /// Milliseconds -> (seconds, nanoseconds) with floor division, for times before 1970.
    static func timespec(fromMillis ms: Int64) -> timespec {
        var sec = ms / 1000
        var rem = ms % 1000
        if rem < 0 { rem += 1000; sec -= 1 }
        return Darwin.timespec(tv_sec: Int(sec), tv_nsec: Int(rem) * 1_000_000)
    }
    static func format(millis ms: Int64) -> String {
        var sec = ms / 1000
        var rem = ms % 1000
        if rem < 0 { rem += 1000; sec -= 1 }
        // civil from days (Howard Hinnant's algorithm)
        var days = sec / 86400
        var sod = sec % 86400
        if sod < 0 { sod += 86400; days -= 1 }
        let z = days + 719468
        let era = (z >= 0 ? z : z - 146096) / 146097
        let doe = z - era * 146097
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
        let y = yoe + era * 400
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let d = doy - (153 * mp + 2) / 5 + 1
        let m = mp < 10 ? mp + 3 : mp - 9
        let yy = m <= 2 ? y + 1 : y
        return String(format: "%04lld-%02lld-%02lldT%02lld:%02lld:%02lld.%03lldZ", yy, m, d, sod / 3600, (sod % 3600) / 60, sod % 60, rem)
    }
}
