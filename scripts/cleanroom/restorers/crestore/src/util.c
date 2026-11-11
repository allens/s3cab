#include "common.h"
#include <stdarg.h>
#include <openssl/sha.h>
#include <openssl/hmac.h>
#include <openssl/evp.h>

void buf_init(buf_t *b) { b->p = NULL; b->len = b->cap = 0; }
void buf_free(buf_t *b) { free(b->p); buf_init(b); }
void buf_reserve(buf_t *b, size_t extra) {
    if (b->len + extra + 1 > b->cap) {
        size_t nc = b->cap ? b->cap : 256;
        while (nc < b->len + extra + 1) nc *= 2;
        b->p = xrealloc(b->p, nc);
        b->cap = nc;
    }
}
void buf_append(buf_t *b, const void *data, size_t n) {
    buf_reserve(b, n);
    memcpy(b->p + b->len, data, n);
    b->len += n;
    b->p[b->len] = 0;
}
void buf_appendstr(buf_t *b, const char *s) { buf_append(b, s, strlen(s)); }
void buf_appendf(buf_t *b, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    va_list ap2;
    va_copy(ap2, ap);
    int n = vsnprintf(NULL, 0, fmt, ap);
    va_end(ap);
    if (n < 0) { va_end(ap2); return; }
    buf_reserve(b, (size_t)n);
    vsnprintf((char *)b->p + b->len, (size_t)n + 1, fmt, ap2);
    va_end(ap2);
    b->len += (size_t)n;
}

void *xmalloc(size_t n) { void *p = malloc(n ? n : 1); if (!p) die("out of memory"); return p; }
void *xrealloc(void *p, size_t n) { p = realloc(p, n ? n : 1); if (!p) die("out of memory"); return p; }
char *xstrdup(const char *s) { char *d = strdup(s); if (!d) die("out of memory"); return d; }
char *xstrndup(const char *s, size_t n) { char *d = xmalloc(n + 1); memcpy(d, s, n); d[n] = 0; return d; }

void die(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    fputs("s3cab-restore: fatal: ", stderr);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    va_end(ap);
    exit(2);
}

void hex_encode(const unsigned char *in, size_t n, char *out) {
    static const char hx[] = "0123456789abcdef";
    for (size_t i = 0; i < n; i++) { out[2 * i] = hx[in[i] >> 4]; out[2 * i + 1] = hx[in[i] & 15]; }
    out[2 * n] = 0;
}

void sha256_hex(const void *data, size_t n, char out[65]) {
    unsigned char d[32];
    SHA256(data, n, d);
    hex_encode(d, 32, out);
}

void hmac_sha256(const void *key, size_t klen, const void *data, size_t n, unsigned char out[32]) {
    unsigned int len = 32;
    if (!HMAC(EVP_sha256(), key, (int)klen, data, n, out, &len)) die("HMAC failed");
}
