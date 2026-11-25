#include "util.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void *xmalloc(size_t n) {
    void *p = malloc(n ? n : 1);
    if (!p) die("out of memory");
    return p;
}

void *xcalloc(size_t n, size_t m) {
    void *p = calloc(n ? n : 1, m ? m : 1);
    if (!p) die("out of memory");
    return p;
}

void *xrealloc(void *p, size_t n) {
    p = realloc(p, n ? n : 1);
    if (!p) die("out of memory");
    return p;
}

char *xstrdup(const char *s) { return xmemdup0(s, strlen(s)); }

char *xmemdup0(const void *p, size_t n) {
    char *r = xmalloc(n + 1);
    if (n) memcpy(r, p, n);
    r[n] = '\0';
    return r;
}

void buf_reserve(buf *b, size_t extra) {
    if (b->cap - b->n > extra) return; // always leaves room for a NUL
    size_t cap = b->cap ? b->cap : 256;
    while (cap - b->n <= extra) {
        if (cap > SIZE_MAX / 2) die("out of memory");
        cap *= 2;
    }
    b->p = xrealloc(b->p, cap);
    b->cap = cap;
}

void buf_add(buf *b, const void *p, size_t n) {
    buf_reserve(b, n);
    if (n) memcpy(b->p + b->n, p, n);
    b->n += n;
    b->p[b->n] = '\0';
}

void buf_puts(buf *b, const char *s) { buf_add(b, s, strlen(s)); }

void buf_putc(buf *b, char c) { buf_add(b, &c, 1); }

void buf_printf(buf *b, const char *fmt, ...) {
    va_list ap, ap2;
    va_start(ap, fmt);
    va_copy(ap2, ap);
    int n = vsnprintf(nullptr, 0, fmt, ap);
    va_end(ap);
    if (n < 0) die("vsnprintf failed");
    buf_reserve(b, (size_t)n);
    vsnprintf(b->p + b->n, (size_t)n + 1, fmt, ap2);
    va_end(ap2);
    b->n += (size_t)n;
}

char *buf_cstr(buf *b) {
    buf_reserve(b, 0);
    b->p[b->n] = '\0';
    return b->p;
}

void buf_free(buf *b) {
    free(b->p);
    *b = (buf){};
}

void die(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    fflush(stdout);
    fputs("s3cab-restore: ", stderr);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    va_end(ap);
    exit(2);
}

void hex_encode(const unsigned char *in, size_t n, char *out) {
    static const char digits[] = "0123456789abcdef";
    for (size_t i = 0; i < n; i++) {
        out[2 * i] = digits[in[i] >> 4];
        out[2 * i + 1] = digits[in[i] & 15];
    }
    out[2 * n] = '\0';
}
