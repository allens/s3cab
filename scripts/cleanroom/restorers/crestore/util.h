// Small shared helpers: growable byte buffer, checked allocation, fatal errors.
#ifndef UTIL_H
#define UTIL_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
    char *p;
    size_t n, cap;
} buf;

void buf_reserve(buf *b, size_t extra);
void buf_add(buf *b, const void *p, size_t n);
void buf_puts(buf *b, const char *s);
void buf_putc(buf *b, char c);
[[gnu::format(printf, 2, 3)]] void buf_printf(buf *b, const char *fmt, ...);
char *buf_cstr(buf *b); // keeps a NUL after the data (not counted in n)
void buf_free(buf *b);

void *xmalloc(size_t n);
void *xcalloc(size_t n, size_t m);
void *xrealloc(void *p, size_t n);
char *xstrdup(const char *s);
char *xmemdup0(const void *p, size_t n);

[[noreturn, gnu::format(printf, 1, 2)]] void die(const char *fmt, ...);

void hex_encode(const unsigned char *in, size_t n, char *out); // writes 2n chars + NUL

#endif
