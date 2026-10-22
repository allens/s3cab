/* Small shared helpers: byte buffers, slices, a string set, hex. */
#ifndef S3CAB_UTIL_H
#define S3CAB_UTIL_H

#include <stddef.h>
#include <stdint.h>

/* A growable byte buffer, always NUL-terminated past `len` for convenience. */
typedef struct {
    unsigned char *p;
    size_t len, cap;
} buf_t;

void buf_reserve(buf_t *b, size_t extra);
void buf_add(buf_t *b, const void *data, size_t n);
void buf_adds(buf_t *b, const char *s);
void buf_addf(buf_t *b, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
void buf_free(buf_t *b);

/* A slice into someone else's memory.  Not NUL-terminated: paths may hold NUL. */
typedef struct {
    const unsigned char *p;
    size_t n;
} str_t;

bool str_eq(str_t a, str_t b);
bool str_eqz(str_t a, const char *z);
char *str_dup(str_t s); /* NUL-terminated copy; caller frees */

/* Set of byte strings (open addressing).  Values are an optional size_t tag. */
typedef struct {
    struct sset_slot { unsigned char *k; size_t n; size_t tag; bool used; } *slot;
    size_t cap, count;
} sset_t;

/* Returns true if inserted; false if already present (and *tag_out = existing tag). */
bool sset_add(sset_t *s, const void *k, size_t n, size_t tag, size_t *tag_out);
bool sset_has(const sset_t *s, const void *k, size_t n, size_t *tag_out);
void sset_free(sset_t *s);

void hex_encode(const unsigned char *in, size_t n, char *out); /* out: 2n+1 */

[[noreturn]] void die(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
void *xmalloc(size_t n);
void *xcalloc(size_t a, size_t b);
void *xrealloc(void *p, size_t n);
char *xstrdup(const char *s);

/* Print a byte string for a human, escaping control bytes so a report line stays one line. */
void put_escaped(void *file, const unsigned char *p, size_t n);

#endif
