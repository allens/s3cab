import Foundation

// The reading rules that hold for every snapshot and deletion record. Everything here works
// on bytes: lines are split on the LF byte and fields on the tab byte, never by a String API.

// MARK: the trim

/// The trim set, exactly: U+0009..U+000D, the Zs spaces, U+2028, U+2029 and U+FEFF.
/// Nothing else, so not U+0085 and not U+001C..U+001F.
func isTrimScalar(_ v: UInt32) -> Bool {
    switch v {
    case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
        return true
    default:
        return false
    }
}

/// Decodes the scalar that starts at `i`. The bytes are already known to be well-formed UTF-8.
private func scalar(in b: ArraySlice<UInt8>, at i: Int) -> (value: UInt32, length: Int) {
    let b0 = UInt32(b[i])
    if b0 < 0x80 { return (b0, 1) }
    if b0 < 0xE0 { return ((b0 & 0x1F) << 6 | UInt32(b[i + 1] & 0x3F), 2) }
    if b0 < 0xF0 { return ((b0 & 0x0F) << 12 | UInt32(b[i + 1] & 0x3F) << 6 | UInt32(b[i + 2] & 0x3F), 3) }
    return ((b0 & 0x07) << 18 | UInt32(b[i + 1] & 0x3F) << 12 | UInt32(b[i + 2] & 0x3F) << 6 | UInt32(b[i + 3] & 0x3F), 4)
}

/// A leading field, trimmed at both ends. Never call this on the last field.
func trimmed(_ field: ArraySlice<UInt8>) -> [UInt8] {
    var lo = field.startIndex
    var hi = field.endIndex
    while lo < hi {
        let (v, n) = scalar(in: field, at: lo)
        if !isTrimScalar(v) { break }
        lo += n
    }
    while hi > lo {
        var s = hi - 1
        while s > lo && (field[s] & 0xC0) == 0x80 { s -= 1 }
        let (v, _) = scalar(in: field, at: s)
        if !isTrimScalar(v) { break }
        hi = s
    }
    return Array(field[lo..<hi])
}

// MARK: lines and fields

struct Fields {
    /// Always five: the line split at its first four tabs, the missing ones empty.
    var f: [ArraySlice<UInt8>]
    /// How many the line really holds, 1 to 5.
    var present: Int
}

func splitFields(_ line: ArraySlice<UInt8>) -> Fields {
    var f = [ArraySlice<UInt8>]()
    var start = line.startIndex
    var i = line.startIndex
    while i < line.endIndex && f.count < 4 {
        if line[i] == 0x09 {
            f.append(line[start..<i])
            start = i + 1
        }
        i += 1
    }
    f.append(line[start..<line.endIndex])
    let present = f.count
    while f.count < 5 { f.append(line[line.endIndex..<line.endIndex]) }
    return Fields(f: f, present: present)
}

let headingLeading: [[UInt8]] = [Array("@S3CAB".utf8), Array("FORMAT".utf8), Array("size".utf8), Array("time".utf8)]
let headingAddress: [UInt8] = Array("https://s3cab.plantegral.com/guide/format".utf8)

/// The heading row: all five fields, the first four trimmed, the last verbatim.
func isHeadingRow(_ line: ArraySlice<UInt8>) -> Bool {
    let x = splitFields(line)
    guard x.present == 5 else { return false }
    for i in 0..<4 where trimmed(x.f[i]) != headingLeading[i] { return false }
    return Array(x.f[4]) == headingAddress
}

func isHash(_ b: [UInt8]) -> Bool {
    b.count == 64 && b.allSatisfy { ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x61 && $0 <= 0x66) }
}

func isDecimal(_ b: [UInt8]) -> Bool {
    !b.isEmpty && b.allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
}

// MARK: instants

/// `YYYY-MM-DDTHH:MM:SS.sssZ`, a real instant of the proleptic Gregorian calendar.
struct Instant {
    let text: String
    /// Whole seconds since 1970-01-01T00:00:00Z, floored, so `millis` is always 0...999.
    let seconds: Int64
    let millis: Int
    var totalMillis: Int64 { seconds * 1000 + Int64(millis) }
}

func isLeapYear(_ y: Int) -> Bool { y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) }

func daysInMonth(_ y: Int, _ m: Int) -> Int {
    switch m {
    case 1, 3, 5, 7, 8, 10, 12: return 31
    case 4, 6, 9, 11: return 30
    default: return isLeapYear(y) ? 29 : 28
    }
}

/// Days from 1970-01-01 to y-m-d in the proleptic Gregorian calendar (year 0000 included).
func daysFromCivil(_ y: Int, _ m: Int, _ d: Int) -> Int64 {
    let yy = Int64(m <= 2 ? y - 1 : y)
    let era = (yy >= 0 ? yy : yy - 399) / 400
    let yoe = yy - era * 400
    let mp = Int64((m + 9) % 12)
    let doy = (153 * mp + 2) / 5 + Int64(d) - 1
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146097 + doe - 719468
}

func civilFromDays(_ z0: Int64) -> (y: Int64, m: Int, d: Int) {
    let z = z0 + 719468
    let era = (z >= 0 ? z : z - 146096) / 146097
    let doe = z - era * 146097
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
    let y = yoe + era * 400
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
    let mp = (5 * doy + 2) / 153
    let d = Int(doy - (153 * mp + 2) / 5 + 1)
    let m = Int(mp < 10 ? mp + 3 : mp - 9)
    return (m <= 2 ? y + 1 : y, m, d)
}

func parseInstant(_ b: [UInt8]) -> Instant? {
    guard b.count == 24 else { return nil }
    func num(_ from: Int, _ n: Int) -> Int? {
        var v = 0
        for i in from..<(from + n) {
            guard b[i] >= 0x30 && b[i] <= 0x39 else { return nil }
            v = v * 10 + Int(b[i] - 0x30)
        }
        return v
    }
    guard b[4] == 0x2D, b[7] == 0x2D, b[10] == 0x54, b[13] == 0x3A, b[16] == 0x3A, b[19] == 0x2E, b[23] == 0x5A,
          let y = num(0, 4), let mo = num(5, 2), let d = num(8, 2),
          let h = num(11, 2), let mi = num(14, 2), let s = num(17, 2), let ms = num(20, 3)
    else { return nil }
    guard mo >= 1, mo <= 12, d >= 1, d <= daysInMonth(y, mo), h <= 23, mi <= 59, s <= 59 else { return nil }
    let secs = daysFromCivil(y, mo, d) * 86400 + Int64(h * 3600 + mi * 60 + s)
    return Instant(text: String(decoding: b, as: UTF8.self), seconds: secs, millis: ms)
}

/// A time read back from a file, for a message: the 24-character form where the year fits.
func formatTime(seconds: Int64, nanos: Int) -> String {
    let days = seconds >= 0 ? seconds / 86400 : (seconds - 86399) / 86400
    let rem = Int(seconds - days * 86400)
    let (y, m, d) = civilFromDays(days)
    func pad(_ v: Int64, _ width: Int) -> String {
        let digits = String(abs(v))
        return (v < 0 ? "-" : "") + String(repeating: "0", count: max(0, width - digits.count)) + digits
    }
    return pad(y, 4) + "-" + pad(Int64(m), 2) + "-" + pad(Int64(d), 2) + "T" + pad(Int64(rem / 3600), 2) + ":"
        + pad(Int64(rem % 3600 / 60), 2) + ":" + pad(Int64(rem % 60), 2) + "." + pad(Int64(nanos), 9) + "Z"
}

// MARK: gzip (the system's zlib)

struct Damaged: Error {
    let message: String
}

/// Every gzip stream in turn, joined. A zero byte after a stream ends the file; any other byte
/// there must start another stream; any gzip error, a cut-short stream included, is damage.
func gunzipAll(_ data: [UInt8]) throws -> [UInt8] {
    if data.isEmpty { throw Damaged(message: "the file is empty: no gzip stream") }
    if data[0] == 0 { throw Damaged(message: "a zero byte before the first gzip stream") }
    var strm = z_stream()
    guard s3r_inflateInit2(&strm, 15 + 16) == Z_OK else { throw Damaged(message: "zlib would not start") }
    defer { inflateEnd(&strm) }

    var out = [UInt8]()
    var chunk = [UInt8](repeating: 0, count: 1 << 16)
    var failure: String? = nil
    var streams = 0

    data.withUnsafeBufferPointer { inp in
        var pos = 0
        while true {
            var ended = false
            while !ended {
                let take = min(inp.count - pos, 1 << 30)
                strm.next_in = UnsafeMutablePointer(mutating: inp.baseAddress! + pos)
                strm.avail_in = uInt(take)
                let rc: Int32 = chunk.withUnsafeMutableBufferPointer { o in
                    strm.next_out = o.baseAddress
                    strm.avail_out = uInt(o.count)
                    return inflate(&strm, Z_NO_FLUSH)
                }
                let produced = chunk.count - Int(strm.avail_out)
                out.append(contentsOf: chunk[0..<produced])
                pos += take - Int(strm.avail_in)
                switch rc {
                case Z_STREAM_END:
                    ended = true
                case Z_OK:
                    // Input gone and room left to write: zlib wants bytes the file doesn't have.
                    if pos >= inp.count && strm.avail_out != 0 {
                        failure = "gzip stream \(streams + 1) is cut short"
                        return
                    }
                case Z_BUF_ERROR:
                    failure = "gzip stream \(streams + 1) is cut short"
                    return
                default:
                    let why = strm.msg.map { String(cString: $0) } ?? "zlib error \(rc)"
                    failure = "gzip stream \(streams + 1): \(why)"
                    return
                }
            }
            streams += 1
            if pos >= inp.count { return }      // nothing after the stream
            if inp[pos] == 0 { return }         // padding: it and everything after it are ignored
            inflateReset(&strm)                 // anything else must be another stream
        }
    }
    if let failure { throw Damaged(message: failure) }
    return out
}
