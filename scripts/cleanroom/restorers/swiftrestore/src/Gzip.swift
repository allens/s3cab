import Foundation

struct GzipDamage: Error, CustomStringConvertible { let description: String }

// Decompress every gzip stream in turn, as the spec's reader does; a zero byte after a stream ends the file;
// anything else after a stream that isn't another stream, or any zlib error, is damage.
func gunzipAll(_ input: Bytes) throws -> Bytes {
    var out = Bytes()
    var buf = Bytes(repeating: 0, count: 1 << 16)
    var inp = input                           // z_stream wants a mutable pointer
    var strm = z_stream()
    guard s3cab_inflateInit2(&strm, 15 + 16) == Z_OK else { throw GzipDamage(description: "inflateInit2 failed") }
    defer { inflateEnd(&strm) }
    var pos = 0
    var first = true
    try inp.withUnsafeMutableBufferPointer { ip in
        try buf.withUnsafeMutableBufferPointer { op in
            while true {
                if pos >= ip.count {
                    if first { throw GzipDamage(description: "empty file, no gzip stream") }
                    return
                }
                if !first {
                    if ip[pos] == 0 { return }            // a zero byte after a stream ends the file
                    guard inflateReset(&strm) == Z_OK else { throw GzipDamage(description: "inflateReset failed") }
                }
                strm.next_in = ip.baseAddress! + pos
                strm.avail_in = UInt32(ip.count - pos)
                while true {
                    strm.next_out = op.baseAddress
                    strm.avail_out = UInt32(op.count)
                    let rc = inflate(&strm, Z_NO_FLUSH)
                    let produced = op.count - Int(strm.avail_out)
                    if produced > 0 { out.append(contentsOf: UnsafeBufferPointer(start: op.baseAddress, count: produced)) }
                    if rc == Z_STREAM_END { break }
                    if rc != Z_OK {
                        let msg = strm.msg != nil ? String(cString: strm.msg) : "zlib error \(rc)"
                        if rc == Z_BUF_ERROR && strm.avail_in == 0 { throw GzipDamage(description: "gzip stream cut short") }
                        throw GzipDamage(description: msg)
                    }
                    if strm.avail_in == 0 && strm.avail_out != 0 { throw GzipDamage(description: "gzip stream cut short") }
                }
                pos = ip.count - Int(strm.avail_in)
                first = false
            }
        }
    }
    return out
}
