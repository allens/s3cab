#include "util.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

[[noreturn]] void die(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    fputs("s3cab-restore: ", stderr);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    va_end(ap);
    exit(1);
}

void *xmalloc(size_t n)
{
    void *p = malloc(n ? n : 1);
    if (!p) die("out of memory");
    return p;
}

void *xcalloc(size_t a, size_t b)
{
    void *p = calloc(a ? a : 1, b ? b : 1);
    if (!p) die("out of memory");
    return p;
}

void *xrealloc(void *p, size_t n)
{
    p = realloc(p, n ? n : 1);
    if (!p) die("out of memory");
    return p;
}

char *xstrdup(const char *s)
{
    size_t n = strlen(s);
    char *d = xmalloc(n + 1);
    memcpy(d, s, n + 1);
    return d;
}

void buf_reserve(buf_t *b, size_t extra)
{
    if (b->len + extra + 1 <= b->cap) return;
    size_t cap = b->cap ? b->cap : 256;
    while (cap < b->len + extra + 1) cap *= 2;
    b->p = xrealloc(b->p, cap);
    b->cap = cap;
}

void buf_add(buf_t *b, const void *data, size_t n)
{
    buf_reserve(b, n);
    if (n) memcpy(b->p + b->len, data, n);
    b->len += n;
    b->p[b->len] = 0;
}

void buf_adds(buf_t *b, const char *s) { buf_add(b, s, strlen(s)); }

void buf_addf(buf_t *b, const char *fmt, ...)
{
    va_list ap, ap2;
    va_start(ap, fmt);
    va_copy(ap2, ap);
    int n = vsnprintf(nullptr, 0, fmt, ap);
    va_end(ap);
    if (n < 0) die("format error");
    buf_reserve(b, (size_t)n);
    vsnprintf((char *)b->p + b->len, (size_t)n + 1, fmt, ap2);
    va_end(ap2);
    b->len += (size_t)n;
}

void buf_free(buf_t *b)
{
    free(b->p);
    *b = (buf_t){0};
}

bool str_eq(str_t a, str_t b) { return a.n == b.n && (a.n == 0 || memcmp(a.p, b.p, a.n) == 0); }

bool str_eqz(str_t a, const char *z)
{
    size_t n = strlen(z);
    return a.n == n && memcmp(a.p, z, n) == 0;
}

char *str_dup(str_t s)
{
    char *d = xmalloc(s.n + 1);
    if (s.n) memcpy(d, s.p, s.n);
    d[s.n] = 0;
    return d;
}

static uint64_t fnv1a(const void *k, size_t n)
{
    const unsigned char *p = k;
    uint64_t h = 1469598103934665603ULL;
    for (size_t i = 0; i < n; i++) {
        h ^= p[i];
        h *= 1099511628211ULL;
    }
    return h;
}

static void sset_grow(sset_t *s)
{
    size_t ncap = s->cap ? s->cap * 2 : 64;
    struct sset_slot *ns = xcalloc(ncap, sizeof *ns);
    for (size_t i = 0; i < s->cap; i++) {
        if (!s->slot[i].used) continue;
        size_t j = fnv1a(s->slot[i].k, s->slot[i].n) & (ncap - 1);
        while (ns[j].used) j = (j + 1) & (ncap - 1);
        ns[j] = s->slot[i];
    }
    free(s->slot);
    s->slot = ns;
    s->cap = ncap;
}

bool sset_has(const sset_t *s, const void *k, size_t n, size_t *tag_out)
{
    if (!s->cap) return false;
    size_t j = fnv1a(k, n) & (s->cap - 1);
    while (s->slot[j].used) {
        if (s->slot[j].n == n && memcmp(s->slot[j].k, k, n) == 0) {
            if (tag_out) *tag_out = s->slot[j].tag;
            return true;
        }
        j = (j + 1) & (s->cap - 1);
    }
    return false;
}

bool sset_add(sset_t *s, const void *k, size_t n, size_t tag, size_t *tag_out)
{
    if (sset_has(s, k, n, tag_out)) return false;
    if ((s->count + 1) * 2 > s->cap) sset_grow(s);
    size_t j = fnv1a(k, n) & (s->cap - 1);
    while (s->slot[j].used) j = (j + 1) & (s->cap - 1);
    s->slot[j].k = xmalloc(n ? n : 1);
    if (n) memcpy(s->slot[j].k, k, n);
    s->slot[j].n = n;
    s->slot[j].tag = tag;
    s->slot[j].used = true;
    s->count++;
    return true;
}

void sset_free(sset_t *s)
{
    for (size_t i = 0; i < s->cap; i++)
        if (s->slot[i].used) free(s->slot[i].k);
    free(s->slot);
    *s = (sset_t){0};
}

void hex_encode(const unsigned char *in, size_t n, char *out)
{
    static const char hx[] = "0123456789abcdef";
    for (size_t i = 0; i < n; i++) {
        out[2 * i] = hx[in[i] >> 4];
        out[2 * i + 1] = hx[in[i] & 15];
    }
    out[2 * n] = 0;
}

void put_escaped(void *file, const unsigned char *p, size_t n)
{
    FILE *f = file;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = p[i];
        if (c < 0x20 || c == 0x7f)
            fprintf(f, "\\x%02x", c);
        else
            fputc(c, f);
    }
}
