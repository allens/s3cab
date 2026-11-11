/* s3cab-restore: an independent restorer for the s3cab format, written from
 * format.md alone.  Dependencies: OpenSSL (TLS, SHA-256, HMAC) and zlib. */
#ifndef S3CAB_COMMON_H
#define S3CAB_COMMON_H
#define _GNU_SOURCE 1
#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* A growable byte buffer. */
typedef struct {
    unsigned char *p;
    size_t len, cap;
} buf_t;

void buf_init(buf_t *b);
void buf_free(buf_t *b);
void buf_reserve(buf_t *b, size_t extra);
void buf_append(buf_t *b, const void *data, size_t n);
void buf_appendstr(buf_t *b, const char *s);
void buf_appendf(buf_t *b, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
static inline const char *buf_cstr(const buf_t *b) { return b->p ? (const char *)b->p : ""; }

void *xmalloc(size_t n);
void *xrealloc(void *p, size_t n);
char *xstrdup(const char *s);
char *xstrndup(const char *s, size_t n);
__attribute__((noreturn)) void die(const char *fmt, ...) __attribute__((format(printf, 1, 2)));

/* Hashing helpers (OpenSSL). */
void sha256_hex(const void *data, size_t n, char out[65]);
void hmac_sha256(const void *key, size_t klen, const void *data, size_t n, unsigned char out[32]);
void hex_encode(const unsigned char *in, size_t n, char *out); /* out: 2n+1 */

/* ---- HTTP transport (http.c) ---- */
typedef struct http_conn http_conn;

typedef struct {
    const char *name;
    const char *value;
} http_header;

/* Callback receiving body bytes; return false to abort. */
typedef bool (*http_body_cb)(void *ud, const unsigned char *data, size_t n);

typedef struct {
    int status;              /* HTTP status, or -1 for a transport failure */
    char *status_line;       /* malloc'd */
    buf_t headers;           /* raw header block */
    buf_t body;              /* body, when no callback was given */
    char err[512];           /* transport error text */
    bool dropped;            /* the connection failed (reset, timeout, ...) */
} http_response;

/* Open a connection to host:port, through the HTTP proxy named by the
 * proxy URL when one is given (http://user:pass@host:port). */
http_conn *http_open(const char *host, int port, const char *proxy_url, char *err, size_t errlen);
void http_close(http_conn *c);
/* Send a request and read the reply.  Returns false on a transport failure
 * (the response's err and dropped are set).  The connection is left ready for
 * another request unless the server closed it, in which case *reusable is set
 * to false. */
bool http_request(http_conn *c, const char *method, const char *path_and_query,
                  const http_header *hdrs, size_t nhdrs,
                  http_body_cb cb, void *ud, http_response *resp, bool *reusable);
void http_response_init(http_response *r);
void http_response_free(http_response *r);
/* Find a header value (case-insensitive name) in a response; returns a
 * malloc'd copy, trimmed, or NULL. */
char *http_header_get(const http_response *r, const char *name);

/* ---- S3 over plain HTTPS with SigV4 (s3.c) ---- */
typedef struct s3_client s3_client;

typedef struct {
    char **keys;
    size_t n, cap;
} s3_keylist;

s3_client *s3_new(const char *bucket, const char *region, const char *access_key,
                  const char *secret_key, const char *session_token, const char *proxy_url);
void s3_free(s3_client *c);
/* Result of a GET. */
typedef enum { S3_OK, S3_MISS, S3_ERROR } s3_status;
/* GET an object.  Body goes to cb (or into *body when cb is NULL).  On
 * S3_ERROR, *errmsg is a malloc'd description.  S3_MISS is a 404 whose error
 * code is NoSuchKey or NotFound. */
s3_status s3_get(s3_client *c, const char *key, http_body_cb cb, void *ud, buf_t *body, char **errmsg);
/* List the keys directly under a prefix (delimiter "/").  Returns false and
 * sets *errmsg on failure. */
bool s3_list(s3_client *c, const char *prefix, s3_keylist *out, char **errmsg);
void s3_keylist_free(s3_keylist *l);

/* ---- gzip (gz.c) ---- */
/* Decompress a snapshot per the format's rules: every stream in turn; a zero
 * byte after a stream ends the file; any other byte there, or any gzip
 * error, is damage.  Returns false with *err set (static text). */
bool gunzip_all(const unsigned char *in, size_t n, buf_t *out, const char **err);

/* ---- text rules (text.c) ---- */
bool utf8_valid(const unsigned char *s, size_t n);
/* Decode one UTF-8 code point; returns its length or 0 on error. */
size_t utf8_decode(const unsigned char *s, size_t n, uint32_t *cp);
size_t utf8_encode(uint32_t cp, unsigned char out[4]);
bool is_trim_cp(uint32_t cp);
/* Trim the format's trim set from both ends of a UTF-8 field (in place view). */
void trim_field(const unsigned char **s, size_t *n);
/* Split a line at its first four tabs into five fields (missing ones empty). */
typedef struct { const unsigned char *p; size_t n; } span_t;
void split_fields(const unsigned char *line, size_t n, span_t f[5]);
bool span_eq(span_t a, const char *s);
/* Lowercase a UTF-8 string by Unicode's full default case mapping, Final_Sigma
 * included (approximated from the C library's tables).  malloc'd result. */
unsigned char *unicode_lower(const unsigned char *s, size_t n, size_t *outn);
/* Validate the 24-character instant form; returns ms since the epoch in *ms. */
bool parse_instant(const unsigned char *s, size_t n, int64_t *ms);
bool is_hex64_lower(span_t s);
bool is_digits(span_t s);
/* Print a path with control characters spelled out. */
void print_path(FILE *f, const unsigned char *s, size_t n);

#endif
