import Foundation

enum GzipError: Error, CustomStringConvertible {
    case notGzip
    case truncated
    case corrupt(String)
    case trailingBytes(Int)
    var description: String {
        switch self {
        case .notGzip: return "not a gzip file (bad magic bytes)"
        case .truncated: return "gzip stream cut short"
        case .corrupt(let m): return "gzip error: \(m)"
        case .trailingBytes(let n): return "\(n) bytes after the last gzip stream that don't start another"
        }
    }
}

enum Gzip {
    /// Decompress every gzip stream in turn and join them. Bytes after a stream that
    /// don't start another make the file damaged, except that a zero byte there ends
    /// the reading (what s3cab, through Node's gunzip, does).
    static func decompressAll(_ input: [UInt8]) throws -> [UInt8] {
        var out: [UInt8] = []
        var pos = 0
        guard input.count >= 2, input[0] == 0x1f, input[1] == 0x8b else { throw GzipError.notGzip }
        while pos < input.count {
            if input[pos] == 0x00 { break }
            guard pos + 1 < input.count, input[pos] == 0x1f, input[pos + 1] == 0x8b else {
                throw GzipError.trailingBytes(input.count - pos)
            }
            let consumed = try inflateOne(input, from: pos, into: &out)
            pos += consumed
        }
        return out
    }

    private static func inflateOne(_ input: [UInt8], from start: Int, into out: inout [UInt8]) throws -> Int {
        var strm = z_stream()
        var rc = s3r_inflateInit2(&strm, 15 + 16)   // gzip wrapper only
        guard rc == Z_OK else { throw GzipError.corrupt("inflateInit2 \(rc)") }
        defer { inflateEnd(&strm) }
        var buf = [UInt8](repeating: 0, count: 1 << 16)
        var inPtr = input
        var totalIn = 0
        var finished = false
        try inPtr.withUnsafeMutableBufferPointer { inBuf in
            strm.next_in = inBuf.baseAddress! + start
            strm.avail_in = UInt32(input.count - start)
            while !finished {
                let produced: Int = try buf.withUnsafeMutableBufferPointer { ob in
                    strm.next_out = ob.baseAddress
                    strm.avail_out = UInt32(ob.count)
                    rc = inflate(&strm, Z_NO_FLUSH)
                    switch rc {
                    case Z_OK: break
                    case Z_STREAM_END: finished = true
                    case Z_BUF_ERROR: throw GzipError.truncated
                    case Z_DATA_ERROR: throw GzipError.corrupt(strm.msg.map { String(cString: $0) } ?? "data error")
                    default: throw GzipError.corrupt("inflate returned \(rc)")
                    }
                    return ob.count - Int(strm.avail_out)
                }
                out.append(contentsOf: buf[0..<produced])
                if !finished && strm.avail_in == 0 && produced == 0 { throw GzipError.truncated }
            }
            totalIn = (input.count - start) - Int(strm.avail_in)
        }
        return totalIn
    }
}
