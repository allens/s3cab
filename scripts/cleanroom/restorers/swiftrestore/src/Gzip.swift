import Foundation

struct GzipDamaged: Error { let reason: String }

/// Decompress every gzip stream in turn and join them. A zero byte after a stream ends the file;
/// any other byte there that doesn't start a stream, or any gzip error, makes the file damaged.
func gunzipAll(_ input: Bytes) throws -> Bytes {
    var out = Bytes()
    let n = input.count
    if n == 0 { throw GzipDamaged(reason: "empty file: no gzip stream") }
    var pos = 0
    var streams = 0
    try input.withUnsafeBufferPointer { inBuf in
        while pos < n {
            if streams > 0 && input[pos] == 0 { return }   // zero byte after a stream: ignore it and the rest
            guard pos + 1 < n, input[pos] == 0x1F, input[pos + 1] == 0x8B else {
                throw GzipDamaged(reason: streams == 0 ? "not a gzip file (no gzip magic at offset 0)"
                                                       : "byte 0x\(hex([input[pos]])) at offset \(pos) after a gzip stream does not start another")
            }
            var strm = z_stream()
            guard s3r_inflate_init_gzip(&strm) == Z_OK else { throw GzipDamaged(reason: "zlib inflateInit2 failed") }
            defer { inflateEnd(&strm) }
            strm.next_in = UnsafeMutablePointer(mutating: inBuf.baseAddress! + pos)
            strm.avail_in = UInt32(n - pos)
            var chunk = Bytes(repeating: 0, count: 1 << 16)
            var ret: Int32 = Z_OK
            repeat {
                let produced: Int = try chunk.withUnsafeMutableBufferPointer { cb in
                    strm.next_out = cb.baseAddress
                    strm.avail_out = UInt32(cb.count)
                    ret = inflate(&strm, Z_NO_FLUSH)
                    if ret == Z_BUF_ERROR {
                        throw GzipDamaged(reason: "gzip stream \(streams + 1) cut short (Z_BUF_ERROR with \(strm.avail_in) bytes left)")
                    }
                    if ret != Z_OK && ret != Z_STREAM_END {
                        let msg = strm.msg != nil ? String(cString: strm.msg) : "zlib error \(ret)"
                        throw GzipDamaged(reason: "gzip error in stream \(streams + 1): \(msg)")
                    }
                    return cb.count - Int(strm.avail_out)
                }
                out.append(contentsOf: chunk[0..<produced])
            } while ret != Z_STREAM_END
            pos = n - Int(strm.avail_in)
            streams += 1
        }
    }
    return out
}
