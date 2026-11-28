import Foundation

/// Anything that stops the whole restore.
struct Fatal: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

// MARK: output (unbuffered, so stdout and stderr keep their order when captured together)

func writeAll(_ fd: Int32, _ s: String) {
    let bytes = Array(s.utf8)
    bytes.withUnsafeBytes { buf in
        var off = 0
        while off < buf.count {
            let n = write(fd, buf.baseAddress! + off, buf.count - off)
            if n < 0 && errno == EINTR { continue }
            if n <= 0 { break }
            off += n
        }
    }
}
func say(_ s: String) { writeAll(1, s + "\n") }
func complain(_ s: String) { writeAll(2, s + "\n") }

/// A path or other file text made safe to print: control characters, the line and paragraph
/// separators and the bidi controls are spelled out. Decoded first, since U+0085 is two bytes.
func printable(_ bytes: some Sequence<UInt8>) -> String {
    var s = ""
    for u in String(decoding: Array(bytes), as: UTF8.self).unicodeScalars {
        let v = u.value
        let hidden = v < 0x20 || (v >= 0x7F && v <= 0x9F) || v == 0x2028 || v == 0x2029
            || (v >= 0x202A && v <= 0x202E) || (v >= 0x2066 && v <= 0x2069) || v == 0xFEFF
        if hidden {
            s += "\\u{" + String(v, radix: 16, uppercase: true) + "}"
        } else {
            s.unicodeScalars.append(u)
        }
    }
    return s
}

// MARK: bytes

func hexString(_ b: [UInt8]) -> String {
    let d = Array("0123456789abcdef".utf8)
    var o = [UInt8]()
    o.reserveCapacity(b.count * 2)
    for x in b {
        o.append(d[Int(x >> 4)])
        o.append(d[Int(x & 15)])
    }
    return String(decoding: o, as: UTF8.self)
}

/// Strict UTF-8: nil on any byte sequence that is not well-formed (no U+FFFD substitution).
func strictUTF8(_ bytes: some Sequence<UInt8>) -> String? {
    String(validating: bytes, as: UTF8.self)
}

/// Calls `body` with the bytes as a NUL-terminated C string. The bytes go to the system call
/// untouched: no String, no URL, no normalization.
func withCPath<T>(_ bytes: [UInt8], _ body: (UnsafePointer<CChar>) -> T) -> T {
    var z = bytes
    z.append(0)
    return z.withUnsafeBufferPointer { buf in
        buf.baseAddress!.withMemoryRebound(to: CChar.self, capacity: buf.count) { body($0) }
    }
}

func errnoText(_ e: Int32) -> String { String(cString: strerror(e)) }

// MARK: hashing (CommonCrypto)

func sha256(_ bytes: [UInt8]) -> [UInt8] {
    var d = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
    _ = bytes.withUnsafeBytes { CC_SHA256($0.baseAddress, CC_LONG($0.count), &d) }
    return d
}

func hmacSHA256(key: [UInt8], _ data: [UInt8]) -> [UInt8] {
    var d = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
    key.withUnsafeBytes { k in
        data.withUnsafeBytes { m in
            CCHmac(CCHmacAlgorithm(kCCHmacAlgSHA256), k.baseAddress, k.count, m.baseAddress, m.count, &d)
        }
    }
    return d
}

func monotonicSeconds() -> Double {
    var ts = timespec()
    clock_gettime(CLOCK_MONOTONIC, &ts)
    return Double(ts.tv_sec) + Double(ts.tv_nsec) / 1e9
}

func sleepSeconds(_ s: Double) {
    guard s > 0 else { return }
    var want = timespec(tv_sec: Int(s), tv_nsec: Int((s - Double(Int(s))) * 1e9))
    var left = timespec()
    while nanosleep(&want, &left) != 0 && errno == EINTR { want = left }
}
