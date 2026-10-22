// gzip decompression through the system zlib. Members are joined, as format.md says s3cab's
// own reader does; anything after the last member that isn't another member refuses the file.
import zlib

enum GunzipError: Error, CustomStringConvertible {
    case notGzip
    case truncated
    case corrupt(String)
    case trailingGarbage(Int)

    var description: String {
        switch self {
        case .notGzip: return "not gzip"
        case .truncated: return "gzip stream cut short"
        case .corrupt(let m): return "gzip data corrupt (\(m))"
        case .trailingGarbage(let n): return "\(n) byte(s) after the gzip stream that are not gzip"
        }
    }
}

func gunzip(_ input: [UInt8]) throws -> (bytes: [UInt8], members: Int) {
    guard input.count >= 2, input[0] == 0x1f, input[1] == 0x8b else { throw GunzipError.notGzip }
    var out = [UInt8]()
    var members = 0
    var strm = z_stream()
    // inflateInit2 is a macro; call the function it expands to. 15 + 16 = gzip wrapper only.
    guard inflateInit2_(&strm, 15 + 16, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size)) == Z_OK else {
        throw GunzipError.corrupt("inflateInit2 failed")
    }
    defer { inflateEnd(&strm) }
    var chunk = [UInt8](repeating: 0, count: 1 << 16)
    try input.withUnsafeBufferPointer { inBuf in
        var offset = 0
        while true {
            strm.next_in = UnsafeMutablePointer(mutating: inBuf.baseAddress! + offset)
            strm.avail_in = uInt(inBuf.count - offset)
            var ended = false
            while true {
                let rc: Int32 = chunk.withUnsafeMutableBufferPointer { cb in
                    strm.next_out = cb.baseAddress
                    strm.avail_out = uInt(cb.count)
                    return inflate(&strm, Z_NO_FLUSH)
                }
                let produced = chunk.count - Int(strm.avail_out)
                out.append(contentsOf: chunk[0..<produced])
                if rc == Z_STREAM_END { ended = true; break }
                if rc == Z_BUF_ERROR || (rc == Z_OK && strm.avail_in == 0 && produced == 0) {
                    throw GunzipError.truncated
                }
                if rc != Z_OK {
                    let msg = strm.msg.map { String(cString: $0) } ?? "zlib error \(rc)"
                    throw GunzipError.corrupt(msg)
                }
            }
            precondition(ended)
            members += 1
            offset = inBuf.count - Int(strm.avail_in)
            if offset == inBuf.count { break }
            let rest = inBuf.count - offset
            guard rest >= 2, inBuf[offset] == 0x1f, inBuf[offset + 1] == 0x8b else {
                throw GunzipError.trailingGarbage(rest)
            }
            guard inflateReset(&strm) == Z_OK else { throw GunzipError.corrupt("inflateReset failed") }
        }
    }
    return (out, members)
}
