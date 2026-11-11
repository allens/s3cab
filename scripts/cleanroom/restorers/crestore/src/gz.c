/* gzip per the format: every stream in turn; a zero byte after a stream ends
 * the file; any other byte there that doesn't start a stream, or any gzip
 * error (CRC and length included), is damage.  zlib's gzip mode checks the
 * header (flags, header CRC) and the trailer for us. */
#include "common.h"
#include <zlib.h>

bool gunzip_all(const unsigned char *in, size_t n, buf_t *out, const char **err) {
    *err = NULL;
    if (n == 0) { *err = "empty file (no gzip stream)"; return false; }
    z_stream z; memset(&z, 0, sizeof z);
    if (inflateInit2(&z, 15 + 16) != Z_OK) { *err = "inflateInit2 failed"; return false; }
    z.next_in = (unsigned char *)in; z.avail_in = (uInt)n;
    for (;;) {
        /* one stream */
        int rc;
        do {
            buf_reserve(out, 65536);
            z.next_out = out->p + out->len; z.avail_out = 65536;
            rc = inflate(&z, Z_NO_FLUSH);
            out->len += 65536 - z.avail_out;
            if (rc == Z_NEED_DICT || rc == Z_DATA_ERROR || rc == Z_MEM_ERROR || rc == Z_STREAM_ERROR) {
                *err = z.msg ? z.msg : "gzip data error";
                inflateEnd(&z);
                return false;
            }
            if (rc == Z_BUF_ERROR) {
                /* No progress possible: input exhausted mid-stream. */
                if (z.avail_in == 0) { *err = "gzip stream cut short"; inflateEnd(&z); return false; }
            }
        } while (rc != Z_STREAM_END);
        if (out->p) out->p[out->len] = 0;
        if (z.avail_in == 0) break;              /* clean end */
        if (z.next_in[0] == 0) break;            /* zero byte: ignore the rest */
        if (z.next_in[0] != 0x1f) { *err = "bytes after the gzip stream that don't start another"; inflateEnd(&z); return false; }
        if (inflateReset(&z) != Z_OK) { *err = "inflateReset failed"; inflateEnd(&z); return false; }
    }
    inflateEnd(&z);
    if (out->p) out->p[out->len] = 0;
    return true;
}
