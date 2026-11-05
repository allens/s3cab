/*
 * s3cab-restore — an independent, clean-room restorer for the s3cab repository
 * format, written from format.md alone.
 *
 *     ./s3cab-restore <bucket> <set> <dir> [<snapshot>]
 *
 * Credentials and region come from the environment (AWS_ACCESS_KEY_ID,
 * AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AWS_REGION); the HTTPS_PROXY
 * variable is honoured.  No AWS SDK and no S3 client library: requests are
 * signed here (SigV4) and sent with libcurl, hashing is OpenSSL, gzip is zlib.
 *
 * libcurl is declared below by hand because this platform packages the runtime
 * library (libcurl4t64) but not its header; the ABI is stable and the constants
 * were checked against the platform's PHP curl extension.
 *
 * C23 as gcc 13 provides it (-std=c2x).
 */
#define _GNU_SOURCE
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <locale.h>
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>
#include <wchar.h>
#include <wctype.h>

#include <openssl/core_names.h>
#include <openssl/evp.h>
#include <openssl/params.h>
#include <zlib.h>

/* ------------------------------------------------------------------------ */
/* libcurl, declared by hand (no header packaged on this platform)          */
/* ------------------------------------------------------------------------ */
typedef void CURL;
typedef int CURLcode;
struct curl_slist { char *data; struct curl_slist *next; };
enum {
    CURLOPT_WRITEDATA = 10001, CURLOPT_URL = 10002, CURLOPT_PROXY = 10004,
    CURLOPT_ERRORBUFFER = 10010, CURLOPT_USERAGENT = 10018,
    CURLOPT_HTTPHEADER = 10023, CURLOPT_HEADERDATA = 10029,
    CURLOPT_WRITEFUNCTION = 20011, CURLOPT_HEADERFUNCTION = 20079,
    CURLOPT_LOW_SPEED_LIMIT = 19, CURLOPT_LOW_SPEED_TIME = 20,
    CURLOPT_VERBOSE = 41, CURLOPT_CONNECTTIMEOUT = 78, CURLOPT_HTTPGET = 80,
    CURLOPT_HTTP_VERSION = 84, CURLOPT_NOSIGNAL = 99,
    CURLOPT_HTTP_CONTENT_DECODING = 158, CURLOPT_SUPPRESS_CONNECT_HEADERS = 265,
    CURLINFO_RESPONSE_CODE = 2097154,
    CURL_HTTP_VERSION_1_1 = 2, CURL_GLOBAL_ALL = 3,
    CURLE_OK = 0, CURLE_COULDNT_RESOLVE_PROXY = 5, CURLE_COULDNT_RESOLVE_HOST = 6,
    CURLE_COULDNT_CONNECT = 7, CURLE_PARTIAL_FILE = 18, CURLE_WRITE_ERROR = 23,
    CURLE_OPERATION_TIMEDOUT = 28, CURLE_SSL_CONNECT_ERROR = 35,
    CURLE_GOT_NOTHING = 52, CURLE_SEND_ERROR = 55, CURLE_RECV_ERROR = 56,
};
extern CURLcode curl_global_init(long flags);
extern CURL *curl_easy_init(void);
extern CURLcode curl_easy_setopt(CURL *, int option, ...);
extern CURLcode curl_easy_perform(CURL *);
extern CURLcode curl_easy_getinfo(CURL *, int info, ...);
extern void curl_easy_reset(CURL *);
extern void curl_easy_cleanup(CURL *);
extern const char *curl_easy_strerror(CURLcode);
extern struct curl_slist *curl_slist_append(struct curl_slist *, const char *);
extern void curl_slist_free_all(struct curl_slist *);

/* ------------------------------------------------------------------------ */
/* small utilities                                                          */
/* ------------------------------------------------------------------------ */
static void die(const char *fmt, ...) {
    va_list ap; va_start(ap, fmt);
    fputs("s3cab-restore: fatal: ", stderr);
    vfprintf(stderr, fmt, ap); fputc('\n', stderr);
    va_end(ap);
    exit(2);
}
static void *xmalloc(size_t n) { void *p = malloc(n ? n : 1); if (!p) die("out of memory"); return p; }
static void *xrealloc(void *p, size_t n) { p = realloc(p, n ? n : 1); if (!p) die("out of memory"); return p; }
static char *xstrdup(const char *s) { size_t n = strlen(s) + 1; char *d = xmalloc(n); memcpy(d, s, n); return d; }

typedef struct { uint8_t *p; size_t n, cap; } buf;
static void buf_reserve(buf *b, size_t extra) {
    if (b->n + extra + 1 > b->cap) {
        size_t c = b->cap ? b->cap : 4096;
        while (c < b->n + extra + 1) c *= 2;
        b->p = xrealloc(b->p, c); b->cap = c;
    }
}
static void buf_push(buf *b, const void *d, size_t n) { buf_reserve(b, n); memcpy(b->p + b->n, d, n); b->n += n; b->p[b->n] = 0; }
static void buf_puts(buf *b, const char *s) { buf_push(b, s, strlen(s)); }
static void buf_putc(buf *b, char c) { buf_push(b, &c, 1); }
static void buf_printf(buf *b, const char *fmt, ...) {
    va_list ap; va_start(ap, fmt);
    va_list ap2; va_copy(ap2, ap);
    int n = vsnprintf(nullptr, 0, fmt, ap); va_end(ap);
    if (n < 0) die("vsnprintf");
    buf_reserve(b, (size_t)n);
    vsnprintf((char *)b->p + b->n, (size_t)n + 1, fmt, ap2); va_end(ap2);
    b->n += (size_t)n;
}
static void buf_clear(buf *b) { b->n = 0; if (b->p) b->p[0] = 0; }
static void buf_free(buf *b) { free(b->p); b->p = nullptr; b->n = b->cap = 0; }

typedef struct { const uint8_t *p; size_t n; } sv;   /* a view onto bytes */
static bool sv_eq(sv a, const char *s) { size_t n = strlen(s); return a.n == n && (n == 0 || memcmp(a.p, s, n) == 0); }
static bool sv_eqv(sv a, sv b) { return a.n == b.n && (a.n == 0 || memcmp(a.p, b.p, a.n) == 0); }
static char *sv_dup(sv a) { char *d = xmalloc(a.n + 1); if (a.n) memcpy(d, a.p, a.n); d[a.n] = 0; return d; }

/* Print bytes for people: control bytes escaped, everything else (UTF-8, backslashes) kept. */
static void print_escaped(FILE *out, sv s) {
    for (size_t i = 0; i < s.n; i++) {
        uint8_t c = s.p[i];
        if (c == '\t') fputs("\\t", out);
        else if (c == '\n') fputs("\\n", out);
        else if (c == '\r') fputs("\\r", out);
        else if (c < 0x20 || c == 0x7f) fprintf(out, "\\x%02X", c);
        else fputc(c, out);
    }
}
static void print_escaped_str(FILE *out, const char *s) { print_escaped(out, (sv){(const uint8_t *)s, strlen(s)}); }

/* ------------------------------------------------------------------------ */
/* UTF-8                                                                    */
/* ------------------------------------------------------------------------ */
/* Strict decode of one code point: no overlongs, no surrogates, max U+10FFFF.
 * Returns the byte length, or 0 when the bytes are not UTF-8. */
static size_t utf8_decode(const uint8_t *p, size_t n, uint32_t *cp) {
    if (n == 0) return 0;
    uint8_t c = p[0];
    if (c < 0x80) { *cp = c; return 1; }
    size_t len; uint32_t v, min;
    if ((c & 0xE0) == 0xC0) { len = 2; v = c & 0x1F; min = 0x80; }
    else if ((c & 0xF0) == 0xE0) { len = 3; v = c & 0x0F; min = 0x800; }
    else if ((c & 0xF8) == 0xF0) { len = 4; v = c & 0x07; min = 0x10000; }
    else return 0;
    if (n < len) return 0;
    for (size_t i = 1; i < len; i++) { if ((p[i] & 0xC0) != 0x80) return 0; v = (v << 6) | (p[i] & 0x3F); }
    if (v < min || v > 0x10FFFF || (v >= 0xD800 && v <= 0xDFFF)) return 0;
    *cp = v; return len;
}
static bool utf8_valid(sv s) {
    size_t i = 0;
    while (i < s.n) { uint32_t cp; size_t l = utf8_decode(s.p + i, s.n - i, &cp); if (!l) return false; i += l; }
    return true;
}
static void utf8_encode(buf *b, uint32_t cp) {
    uint8_t t[4]; size_t n;
    if (cp < 0x80) { t[0] = (uint8_t)cp; n = 1; }
    else if (cp < 0x800) { t[0] = 0xC0 | (cp >> 6); t[1] = 0x80 | (cp & 0x3F); n = 2; }
    else if (cp < 0x10000) { t[0] = 0xE0 | (cp >> 12); t[1] = 0x80 | ((cp >> 6) & 0x3F); t[2] = 0x80 | (cp & 0x3F); n = 3; }
    else { t[0] = 0xF0 | (cp >> 18); t[1] = 0x80 | ((cp >> 12) & 0x3F); t[2] = 0x80 | ((cp >> 6) & 0x3F); t[3] = 0x80 | (cp & 0x3F); n = 4; }
    buf_push(b, t, n);
}

/* The trim set for the leading fields: JavaScript's trim() set, exactly. */
static bool is_trim_cp(uint32_t c) {
    return (c >= 0x09 && c <= 0x0D) || c == 0x20 || c == 0xA0 || c == 0x1680 ||
           (c >= 0x2000 && c <= 0x200A) || c == 0x2028 || c == 0x2029 ||
           c == 0x202F || c == 0x205F || c == 0x3000 || c == 0xFEFF;
}
static sv trim(sv s) {
    for (;;) {
        if (!s.n) break;
        uint32_t c; size_t l = utf8_decode(s.p, s.n, &c);
        if (!l || !is_trim_cp(c)) break;
        s.p += l; s.n -= l;
    }
    for (;;) {
        if (!s.n) break;
        size_t k = s.n - 1;
        while (k > 0 && (s.p[k] & 0xC0) == 0x80) k--;
        uint32_t c = 0; size_t l = utf8_decode(s.p + k, s.n - k, &c);
        if (l != s.n - k || !is_trim_cp(c)) break;
        s.n = k;
    }
    return s;
}

/* Five fields, split at the first four tabs; 1-4 trimmed, the fifth verbatim.
 * A line with fewer fields reads the missing ones as empty. */
typedef struct { sv f[5]; int nf; } fields;
static fields split_fields(sv line) {
    fields r = {0};
    size_t start = 0; int i = 0;
    for (size_t k = 0; k < line.n && i < 4; k++)
        if (line.p[k] == '\t') { r.f[i++] = (sv){line.p + start, k - start}; start = k + 1; }
    r.f[i++] = (sv){line.p + start, line.n - start};
    r.nf = i;
    for (int j = 0; j < i && j < 4; j++) r.f[j] = trim(r.f[j]);
    for (int j = i; j < 5; j++) r.f[j] = (sv){(const uint8_t *)"", 0};
    return r;
}

/* ------------------------------------------------------------------------ */
/* instants: exactly YYYY-MM-DDTHH:MM:SS.sssZ, a real proleptic-Gregorian day */
/* ------------------------------------------------------------------------ */
static bool is_leap(int64_t y) { return (y % 4 == 0) && (y % 100 != 0 || y % 400 == 0); }
static int64_t days_from_civil(int64_t y, int m, int d) {
    y -= m <= 2;
    int64_t era = (y >= 0 ? y : y - 399) / 400;
    int64_t yoe = y - era * 400;
    int64_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + doe - 719468;
}
static int digits(const uint8_t *p, int n) { int v = 0; for (int i = 0; i < n; i++) v = v * 10 + (p[i] - '0'); return v; }
static bool parse_instant(sv s, int64_t *ms_out) {
    if (s.n != 24) return false;
    static const char pat[] = "dddd-dd-ddTdd:dd:dd.dddZ";
    for (int i = 0; i < 24; i++) {
        if (pat[i] == 'd') { if (s.p[i] < '0' || s.p[i] > '9') return false; }
        else if (s.p[i] != (uint8_t)pat[i]) return false;
    }
    int Y = digits(s.p, 4), M = digits(s.p + 5, 2), D = digits(s.p + 8, 2);
    int h = digits(s.p + 11, 2), mi = digits(s.p + 14, 2), se = digits(s.p + 17, 2), f = digits(s.p + 20, 3);
    if (M < 1 || M > 12 || D < 1 || h > 23 || mi > 59 || se > 59) return false;
    static const int dim[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    int md = dim[M - 1]; if (M == 2 && is_leap(Y)) md = 29;
    if (D > md) return false;
    int64_t days = days_from_civil(Y, M, D);
    if (ms_out) *ms_out = (days * 86400 + h * 3600 + mi * 60 + se) * 1000 + f;
    return true;
}
static void format_ms(int64_t ms, char out[64]) {
    /* back to the 24-character form, for messages */
    int64_t days = ms / 86400000; int64_t rem = ms % 86400000;
    if (rem < 0) { rem += 86400000; days--; }
    /* civil_from_days */
    int64_t z = days + 719468;
    int64_t era = (z >= 0 ? z : z - 146096) / 146097;
    int64_t doe = z - era * 146097;
    int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    int64_t y = yoe + era * 400;
    int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    int64_t mp = (5 * doy + 2) / 153;
    int64_t d = doy - (153 * mp + 2) / 5 + 1;
    int64_t m = mp + (mp < 10 ? 3 : -9);
    y += m <= 2;
    int64_t s = rem / 1000, f = rem % 1000;
    snprintf(out, 64, "%04" PRId64 "-%02" PRId64 "-%02" PRId64 "T%02" PRId64 ":%02" PRId64 ":%02" PRId64 ".%03" PRId64 "Z",
             y, m, d, s / 3600, (s / 60) % 60, s % 60, f);
}

/* ------------------------------------------------------------------------ */
/* hashing                                                                  */
/* ------------------------------------------------------------------------ */
static const char HEX[] = "0123456789abcdef";
static void to_hex(const uint8_t *d, size_t n, char *out) { for (size_t i = 0; i < n; i++) { out[2 * i] = HEX[d[i] >> 4]; out[2 * i + 1] = HEX[d[i] & 15]; } out[2 * n] = 0; }
static void sha256_hex(const void *d, size_t n, char out[65]) {
    uint8_t md[32]; unsigned int len = 32;
    if (!EVP_Digest(d, n, md, &len, EVP_sha256(), nullptr)) die("EVP_Digest failed");
    to_hex(md, 32, out);
}
static void hmac_sha256(const uint8_t *key, size_t klen, const void *d, size_t n, uint8_t out[32]) {
    static EVP_MAC *mac = nullptr;
    if (!mac) { mac = EVP_MAC_fetch(nullptr, "HMAC", nullptr); if (!mac) die("EVP_MAC_fetch(HMAC) failed"); }
    EVP_MAC_CTX *ctx = EVP_MAC_CTX_new(mac); if (!ctx) die("EVP_MAC_CTX_new failed");
    char digest[] = "SHA256";
    OSSL_PARAM params[] = { OSSL_PARAM_construct_utf8_string(OSSL_MAC_PARAM_DIGEST, digest, 0), OSSL_PARAM_construct_end() };
    size_t outl = 0;
    if (!EVP_MAC_init(ctx, key, klen, params) || !EVP_MAC_update(ctx, d, n) || !EVP_MAC_final(ctx, out, &outl, 32) || outl != 32)
        die("HMAC failed");
    EVP_MAC_CTX_free(ctx);
}
static const char EMPTY_SHA256[] = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/* ------------------------------------------------------------------------ */
/* S3 over plain HTTPS with SigV4                                           */
/* ------------------------------------------------------------------------ */
typedef struct {
    const char *bucket, *region, *akid, *secret, *token, *proxy;
    char host[512];
    CURL *curl;
    bool verbose;
    unsigned long requests;
} s3ctx;

static void uri_encode(buf *b, sv s, bool keep_slash) {
    for (size_t i = 0; i < s.n; i++) {
        uint8_t c = s.p[i];
        if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~' || (keep_slash && c == '/')) buf_putc(b, (char)c);
        else buf_printf(b, "%%%02X", c);
    }
}

typedef struct {
    long status;
    buf body;               /* response body when kept in memory, or an error body */
    int fd;                 /* when >= 0 and status is 200, the body streams here */
    EVP_MD_CTX *md;         /* and is hashed as it streams */
    uint64_t nbytes;
    bool routed, io_error;
    CURL *curl;
    char errbuf[256];
    char code[64];          /* S3 error <Code> when the status is an error */
} response;

static size_t on_body(char *p, size_t s, size_t n, void *u) {
    response *r = u; size_t len = s * n;
    if (!r->routed) { curl_easy_getinfo(r->curl, CURLINFO_RESPONSE_CODE, &r->status); r->routed = true; }
    if (r->fd >= 0 && r->status == 200) {
        size_t off = 0;
        while (off < len) {
            ssize_t w = write(r->fd, p + off, len - off);
            if (w < 0) { if (errno == EINTR) continue; r->io_error = true; return 0; }
            off += (size_t)w;
        }
        if (r->md && !EVP_DigestUpdate(r->md, p, len)) die("EVP_DigestUpdate failed");
        r->nbytes += len;
    } else {
        if (r->body.n < (64u << 20)) buf_push(&r->body, p, len);   /* bounded; error bodies are small */
    }
    return len;
}
static size_t on_header(char *p, size_t s, size_t n, void *u) { (void)p; (void)u; return s * n; }

static void amz_date(char out[17], char day[9]) {
    time_t now = time(nullptr); struct tm tm; gmtime_r(&now, &tm);
    strftime(out, 17, "%Y%m%dT%H%M%SZ", &tm); memcpy(day, out, 8); day[8] = 0;
}

static void sleep_ms(long ms) { struct timespec ts = { ms / 1000, (ms % 1000) * 1000000L }; nanosleep(&ts, nullptr); }
static long rand_under(double ceiling_s) { return (long)((double)rand() / ((double)RAND_MAX + 1) * ceiling_s * 1000); }
static bool is_dropped(CURLcode rc) {
    switch (rc) {
    case CURLE_COULDNT_RESOLVE_PROXY: case CURLE_COULDNT_RESOLVE_HOST: case CURLE_COULDNT_CONNECT:
    case CURLE_PARTIAL_FILE: case CURLE_OPERATION_TIMEDOUT: case CURLE_SSL_CONNECT_ERROR:
    case CURLE_GOT_NOTHING: case CURLE_SEND_ERROR: case CURLE_RECV_ERROR: return true;
    default: return false;
    }
}
static void xml_text(const char *xml, const char *tag, char *out, size_t outsz);

/* One signed GET.  `key` is the raw object key; `query` is the canonical
 * query string (sorted, encoded) or "".  The body goes to r->fd when that is
 * set and the status is 200, else to r->body.  Retries as the spec lists.
 * Returns false when the request failed after its retries (message in r->errbuf). */
static bool s3_get(s3ctx *c, const char *key, const char *query, response *r) {
    buf uri = {0}; buf_putc(&uri, '/'); uri_encode(&uri, (sv){(const uint8_t *)key, strlen(key)}, true);
    buf url = {0}; buf_printf(&url, "https://%s%s", c->host, (char *)uri.p); if (query && *query) buf_printf(&url, "?%s", query);

    double ceil_drop = 0.5, ceil_5xx = 0.1; time_t first_drop = 0; int attempts_5xx = 0;
    bool ok = false;
    for (;;) {
        char date[17], day[9]; amz_date(date, day);
        /* canonical request */
        buf cr = {0};
        buf_printf(&cr, "GET\n%s\n%s\n", (char *)uri.p, query ? query : "");
        buf_printf(&cr, "host:%s\nx-amz-content-sha256:%s\nx-amz-date:%s\n", c->host, EMPTY_SHA256, date);
        if (c->token) buf_printf(&cr, "x-amz-security-token:%s\n", c->token);
        const char *signed_headers = c->token ? "host;x-amz-content-sha256;x-amz-date;x-amz-security-token" : "host;x-amz-content-sha256;x-amz-date";
        buf_printf(&cr, "\n%s\n%s", signed_headers, EMPTY_SHA256);
        char crhash[65]; sha256_hex(cr.p, cr.n, crhash);
        char scope[256]; snprintf(scope, sizeof scope, "%s/%s/s3/aws4_request", day, c->region);
        buf sts = {0}; buf_printf(&sts, "AWS4-HMAC-SHA256\n%s\n%s\n%s", date, scope, crhash);
        /* signing key */
        uint8_t k[32]; buf k0 = {0}; buf_puts(&k0, "AWS4"); buf_puts(&k0, c->secret);
        hmac_sha256(k0.p, k0.n, day, 8, k);
        hmac_sha256(k, 32, c->region, strlen(c->region), k);
        hmac_sha256(k, 32, "s3", 2, k);
        hmac_sha256(k, 32, "aws4_request", 12, k);
        uint8_t sig[32]; hmac_sha256(k, 32, sts.p, sts.n, sig); char sighex[65]; to_hex(sig, 32, sighex);
        buf_free(&k0); buf_free(&sts); buf_free(&cr);

        struct curl_slist *hdrs = nullptr; buf h = {0};
        buf_printf(&h, "x-amz-content-sha256: %s", EMPTY_SHA256); hdrs = curl_slist_append(hdrs, (char *)h.p); buf_clear(&h);
        buf_printf(&h, "x-amz-date: %s", date); hdrs = curl_slist_append(hdrs, (char *)h.p); buf_clear(&h);
        if (c->token) { buf_printf(&h, "x-amz-security-token: %s", c->token); hdrs = curl_slist_append(hdrs, (char *)h.p); buf_clear(&h); }
        buf_printf(&h, "Authorization: AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s", c->akid, scope, signed_headers, sighex);
        hdrs = curl_slist_append(hdrs, (char *)h.p); buf_clear(&h);
        hdrs = curl_slist_append(hdrs, "Accept:");          /* send no Accept, no Accept-Encoding */
        buf_free(&h);

        /* reset per attempt */
        r->status = 0; r->routed = false; r->io_error = false; r->nbytes = 0; r->code[0] = 0; buf_clear(&r->body);
        if (r->fd >= 0) { if (ftruncate(r->fd, 0) != 0 || lseek(r->fd, 0, SEEK_SET) < 0) die("temp file reset: %s", strerror(errno)); }
        if (r->md && !EVP_DigestInit_ex(r->md, EVP_sha256(), nullptr)) die("EVP_DigestInit_ex failed");
        r->curl = c->curl; r->errbuf[0] = 0;

        CURL *e = c->curl; curl_easy_reset(e);
        curl_easy_setopt(e, CURLOPT_URL, (char *)url.p);
        curl_easy_setopt(e, CURLOPT_HTTPGET, 1L);
        curl_easy_setopt(e, CURLOPT_HTTPHEADER, hdrs);
        curl_easy_setopt(e, CURLOPT_WRITEFUNCTION, on_body);
        curl_easy_setopt(e, CURLOPT_WRITEDATA, r);
        curl_easy_setopt(e, CURLOPT_HEADERFUNCTION, on_header);
        curl_easy_setopt(e, CURLOPT_HEADERDATA, r);
        curl_easy_setopt(e, CURLOPT_HTTP_CONTENT_DECODING, 0L);   /* hand back the stored bytes, never decoded */
        curl_easy_setopt(e, CURLOPT_SUPPRESS_CONNECT_HEADERS, 1L);
        curl_easy_setopt(e, CURLOPT_HTTP_VERSION, (long)CURL_HTTP_VERSION_1_1);
        curl_easy_setopt(e, CURLOPT_NOSIGNAL, 1L);
        curl_easy_setopt(e, CURLOPT_CONNECTTIMEOUT, 10L);
        curl_easy_setopt(e, CURLOPT_LOW_SPEED_LIMIT, 1L);
        curl_easy_setopt(e, CURLOPT_LOW_SPEED_TIME, 30L);
        curl_easy_setopt(e, CURLOPT_USERAGENT, "s3cab-restore-cleanroom/0.1");
        curl_easy_setopt(e, CURLOPT_ERRORBUFFER, r->errbuf);
        if (c->proxy) curl_easy_setopt(e, CURLOPT_PROXY, c->proxy);
        if (c->verbose) curl_easy_setopt(e, CURLOPT_VERBOSE, 1L);

        c->requests++;
        CURLcode rc = curl_easy_perform(e);
        curl_slist_free_all(hdrs);
        if (rc == CURLE_OK) curl_easy_getinfo(e, CURLINFO_RESPONSE_CODE, &r->status);

        if (rc != CURLE_OK) {
            if (r->io_error) { snprintf(r->errbuf, sizeof r->errbuf, "writing the download: %s", strerror(errno)); break; }
            if (!is_dropped(rc)) { if (!r->errbuf[0]) snprintf(r->errbuf, sizeof r->errbuf, "%s", curl_easy_strerror(rc)); break; }
            time_t now = time(nullptr);
            if (!first_drop) first_drop = now;
            if (now - first_drop >= 120) { snprintf(r->errbuf, sizeof r->errbuf, "connection kept dropping for two minutes: %s", curl_easy_strerror(rc)); break; }
            fprintf(stderr, "s3cab-restore: connection dropped (%s), retrying\n", curl_easy_strerror(rc));
            sleep_ms(rand_under(ceil_drop)); ceil_drop = ceil_drop * 2 > 2 ? 2 : ceil_drop * 2;
            continue;
        }
        if (r->status >= 500) {
            attempts_5xx++;
            xml_text((const char *)(r->body.p ? r->body.p : (uint8_t *)""), "Code", r->code, sizeof r->code);
            if (attempts_5xx >= 3) { snprintf(r->errbuf, sizeof r->errbuf, "HTTP %ld %s after 3 attempts", r->status, r->code); break; }
            if (r->status == 503 && attempts_5xx == 1) ceil_5xx = 0.5;
            fprintf(stderr, "s3cab-restore: HTTP %ld %s, retrying\n", r->status, r->code);
            sleep_ms(rand_under(ceil_5xx)); ceil_5xx = ceil_5xx * 2 > 20 ? 20 : ceil_5xx * 2;
            continue;
        }
        if (r->status >= 300) xml_text((const char *)(r->body.p ? r->body.p : (uint8_t *)""), "Code", r->code, sizeof r->code);
        ok = true; break;
    }
    buf_free(&uri); buf_free(&url);
    return ok;
}

/* ------------------------------------------------------------------------ */
/* the little XML that ListObjectsV2 and error bodies need                  */
/* ------------------------------------------------------------------------ */
static void xml_unescape(buf *out, const char *s, size_t n) {
    for (size_t i = 0; i < n; i++) {
        if (s[i] != '&') { buf_putc(out, s[i]); continue; }
        const char *semi = memchr(s + i, ';', n - i); if (!semi) { buf_putc(out, s[i]); continue; }
        size_t el = (size_t)(semi - (s + i)) - 1; const char *e = s + i + 1;
        if (el == 3 && !memcmp(e, "amp", 3)) buf_putc(out, '&');
        else if (el == 2 && !memcmp(e, "lt", 2)) buf_putc(out, '<');
        else if (el == 2 && !memcmp(e, "gt", 2)) buf_putc(out, '>');
        else if (el == 4 && !memcmp(e, "quot", 4)) buf_putc(out, '"');
        else if (el == 4 && !memcmp(e, "apos", 4)) buf_putc(out, '\'');
        else if (el > 1 && e[0] == '#') { uint32_t cp = (uint32_t)(e[1] == 'x' ? strtoul(e + 2, nullptr, 16) : strtoul(e + 1, nullptr, 10)); utf8_encode(out, cp); }
        else { buf_push(out, s + i, el + 2); }
        i += el + 1;
    }
}
/* Find the next <tag>…</tag> at or after *pos; returns the unescaped text. */
static bool xml_next(const char *xml, size_t *pos, const char *tag, buf *out) {
    char open[80], close[80]; snprintf(open, sizeof open, "<%s>", tag); snprintf(close, sizeof close, "</%s>", tag);
    const char *s = strstr(xml + *pos, open); if (!s) return false;
    s += strlen(open); const char *e = strstr(s, close); if (!e) return false;
    buf_clear(out); xml_unescape(out, s, (size_t)(e - s));
    *pos = (size_t)(e - xml) + strlen(close);
    return true;
}
static void xml_text(const char *xml, const char *tag, char *out, size_t outsz) {
    size_t pos = 0; buf b = {0}; out[0] = 0;
    if (xml_next(xml, &pos, tag, &b)) snprintf(out, outsz, "%s", (char *)b.p);
    buf_free(&b);
}

/* ListObjectsV2 of the keys directly under `prefix` (delimiter "/").
 * Appends each key (as a malloc'd string) to *keys.  Stops the restore on failure. */
static void s3_list_direct(s3ctx *c, const char *prefix, char ***keys, size_t *nkeys) {
    char *token = nullptr;
    for (;;) {
        buf q = {0};
        if (token) { buf_puts(&q, "continuation-token="); uri_encode(&q, (sv){(const uint8_t *)token, strlen(token)}, false); buf_putc(&q, '&'); }
        buf_puts(&q, "delimiter=%2F&list-type=2&prefix="); uri_encode(&q, (sv){(const uint8_t *)prefix, strlen(prefix)}, false);
        response r = { .fd = -1 };
        if (!s3_get(c, "", (char *)q.p, &r)) die("listing %s: %s", prefix, r.errbuf);
        if (r.status != 200) die("listing %s: HTTP %ld %s", prefix, r.status, r.code);
        const char *xml = (const char *)r.body.p; size_t pos = 0; buf t = {0};
        /* every <Key> belongs to a <Contents>; <CommonPrefixes> hold <Prefix> only */
        while (xml_next(xml, &pos, "Key", &t)) { *keys = xrealloc(*keys, (*nkeys + 1) * sizeof **keys); (*keys)[(*nkeys)++] = xstrdup((char *)t.p); }
        pos = 0; bool more = xml_next(xml, &pos, "IsTruncated", &t) && strcmp((char *)t.p, "true") == 0;
        free(token); token = nullptr;
        if (more) { pos = 0; if (xml_next(xml, &pos, "NextContinuationToken", &t)) token = xstrdup((char *)t.p); else more = false; }
        buf_free(&t); buf_free(&r.body); buf_free(&q);
        if (!more) break;
    }
}

/* ------------------------------------------------------------------------ */
/* gzip: every stream in turn; a zero byte after a stream ends the file;    */
/* any other byte there, or any gzip error, makes the file damaged.          */
/* ------------------------------------------------------------------------ */
static bool gunzip_all(const uint8_t *in, size_t n, buf *out, char *why, size_t whysz) {
    if (n < 2 || in[0] != 0x1f || in[1] != 0x8b) { snprintf(why, whysz, "not a gzip file"); return false; }
    z_stream z = {0};
    if (inflateInit2(&z, 15 + 16) != Z_OK) die("inflateInit2 failed");
    z.next_in = (Bytef *)in; z.avail_in = (uInt)n;
    bool ok = true;
    for (;;) {
        int rc;
        do {
            buf_reserve(out, 1 << 16);
            z.next_out = out->p + out->n; z.avail_out = (uInt)(out->cap - out->n - 1);
            rc = inflate(&z, Z_NO_FLUSH);
            out->n = out->cap - 1 - z.avail_out; out->p[out->n] = 0;
            if (rc == Z_BUF_ERROR && z.avail_in == 0) { snprintf(why, whysz, "gzip stream cut short"); ok = false; break; }
            if (rc != Z_OK && rc != Z_STREAM_END && rc != Z_BUF_ERROR) { snprintf(why, whysz, "gzip error: %s", z.msg ? z.msg : "data error"); ok = false; break; }
        } while (rc != Z_STREAM_END);
        if (!ok) break;
        if (z.avail_in == 0) break;                                  /* clean end */
        if (z.next_in[0] == 0x00) break;                             /* a zero byte ends the file */
        if (z.avail_in >= 2 && z.next_in[0] == 0x1f && z.next_in[1] == 0x8b) { if (inflateReset(&z) != Z_OK) die("inflateReset"); continue; }
        snprintf(why, whysz, "%u byte(s) after the gzip stream that don't start another", (unsigned)z.avail_in); ok = false; break;
    }
    inflateEnd(&z);
    return ok;
}

/* ------------------------------------------------------------------------ */
/* paths                                                                    */
/* ------------------------------------------------------------------------ */
enum kind { K_POSIX, K_WIN };
typedef struct {
    enum kind kind;
    bool absolute, share;
    char drive;             /* uppercase drive letter, or 0 */
    sv *seg; size_t nseg;   /* segments after the root (a share's server and share name included) */
} ppath;
static bool is_sep(uint8_t ch, enum kind k) { return ch == '/' || (k == K_WIN && ch == '\\'); }
static enum kind path_kind(sv p) {
    if (p.n >= 3 && isalpha(p.p[0]) && p.p[1] == ':' && (p.p[2] == '\\' || p.p[2] == '/')) return K_WIN;
    if (p.n >= 2 && (p.p[0] == '\\' || p.p[0] == '/') && (p.p[1] == '\\' || p.p[1] == '/')) return K_WIN;
    return K_POSIX;
}
/* Split a path into root and segments.  When strip_trailing is set (a DIR),
 * the separators it ends with are ignored first. Empty segments are kept so
 * the caller can judge them. */
static ppath parse_path(sv p, bool strip_trailing) {
    ppath r = {0}; r.kind = path_kind(p); size_t rootlen = 0;
    if (r.kind == K_WIN) {
        if (p.p[1] == ':') { r.drive = (char)toupper(p.p[0]); rootlen = 3; } else { r.share = true; rootlen = 2; }
        r.absolute = true;
    } else if (p.n >= 1 && p.p[0] == '/') { rootlen = 1; r.absolute = true; }
    else { r.absolute = false; return r; }
    size_t end = p.n;
    if (strip_trailing) while (end > rootlen && is_sep(p.p[end - 1], r.kind)) end--;
    size_t start = rootlen;
    if (end > rootlen || !strip_trailing) {
        if (end == rootlen) return r;   /* root only: no segments */
        for (size_t i = rootlen; i <= end; i++) {
            if (i == end || is_sep(p.p[i], r.kind)) {
                r.seg = xrealloc(r.seg, (r.nseg + 1) * sizeof *r.seg);
                r.seg[r.nseg++] = (sv){p.p + start, i - start};
                start = i + 1;
            }
        }
    }
    return r;
}

/* Lowercase a segment to code points by Unicode's default full mapping, as
 * JavaScript's toLowerCase() does: towlower under C.UTF-8 for the one-to-one
 * part, plus the two special cases that change length or need context. */
static bool is_case_ignorable(uint32_t c) { return c == '.' || c == '\'' || c == 0x2019 || c == ':' || c == 0xB7 || c == 0x387 || (c >= 0x300 && c <= 0x36F) || c == 0xAD || c == 0x2018; }
static void lower_cps(sv s, uint32_t **out, size_t *n) {
    uint32_t *cps = nullptr; size_t ncp = 0, i = 0;
    while (i < s.n) { uint32_t c; size_t l = utf8_decode(s.p + i, s.n - i, &c); if (!l) { c = 0xFFFD; l = 1; } cps = xrealloc(cps, (ncp + 1) * sizeof *cps); cps[ncp++] = c; i += l; }
    uint32_t *res = xmalloc((ncp * 2 + 1) * sizeof *res); size_t nres = 0;
    for (size_t k = 0; k < ncp; k++) {
        uint32_t c = cps[k];
        if (c == 0x130) { res[nres++] = 'i'; res[nres++] = 0x307; continue; }
        if (c == 0x3A3) {   /* Final_Sigma: preceded by a cased letter, not followed by one */
            bool before = false, after = false;
            for (size_t j = k; j-- > 0;) { if (is_case_ignorable(cps[j])) continue; before = iswalpha((wint_t)cps[j]); break; }
            for (size_t j = k + 1; j < ncp; j++) { if (is_case_ignorable(cps[j])) continue; after = iswalpha((wint_t)cps[j]); break; }
            res[nres++] = (before && !after) ? 0x3C2 : 0x3C3; continue;
        }
        res[nres++] = (uint32_t)towlower((wint_t)c);
    }
    free(cps); *out = res; *n = nres;
}
static bool seg_eq(sv a, sv b, enum kind k) {
    if (k == K_POSIX) return sv_eqv(a, b);
    uint32_t *la, *lb; size_t na, nb; lower_cps(a, &la, &na); lower_cps(b, &lb, &nb);
    bool eq = na == nb && (na == 0 || memcmp(la, lb, na * sizeof *la) == 0);
    free(la); free(lb); return eq;
}

/* ------------------------------------------------------------------------ */
/* the snapshot                                                             */
/* ------------------------------------------------------------------------ */
typedef struct {
    sv raw; size_t lineno;
    bool valid;                 /* a usable DIR; else matches nothing */
    ppath pp;
} dirrow;

enum rowstate { R_PENDING, R_REFUSED, R_RESTORED, R_EXISTS, R_DELETED, R_DAMAGE, R_COLLISION, R_INWAY, R_TIME_ROUNDED, R_TIME_LOST, R_FAILED };
typedef struct {
    size_t lineno;
    fields f;
    sv path, hash;
    int64_t mtime_ms;
    bool wellformed;            /* hash, size, time and path all pass their own checks */
    ppath pp;
    enum rowstate state;
    char *why;                  /* for people */
    char *dest;                 /* where it landed, or would */
} filerow;

typedef struct {
    buf text;                   /* decompressed snapshot */
    dirrow *dirs; size_t ndirs;
    filerow *rows; size_t nrows;
    bool has_start; char start[25];
} snapshot;

static void set_why(filerow *r, const char *fmt, ...) {
    va_list ap; va_start(ap, fmt); char tmp[1024]; vsnprintf(tmp, sizeof tmp, fmt, ap); va_end(ap);
    free(r->why); r->why = xstrdup(tmp);
}
static void refuse(filerow *r, const char *fmt, ...) {
    va_list ap; va_start(ap, fmt); char tmp[1024]; vsnprintf(tmp, sizeof tmp, fmt, ap); va_end(ap);
    if (r->state == R_REFUSED) return;   /* keep the first reason */
    r->state = R_REFUSED; free(r->why); r->why = xstrdup(tmp);
}

static bool is_heading(fields f) {
    return f.nf == 5 && sv_eq(f.f[0], "@S3CAB") && sv_eq(f.f[1], "FORMAT") && sv_eq(f.f[2], "size") && sv_eq(f.f[3], "time") &&
           sv_eq(f.f[4], "https://s3cab.plantegral.com/guide/format");
}
static bool all_digits(sv s) { if (!s.n) return false; for (size_t i = 0; i < s.n; i++) if (s.p[i] < '0' || s.p[i] > '9') return false; return true; }
static bool is_hash(sv s) { if (s.n != 64) return false; for (size_t i = 0; i < 64; i++) { uint8_t c = s.p[i]; if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false; } return true; }
static bool has_byte(sv s, uint8_t b) { return s.n && memchr(s.p, b, s.n) != nullptr; }

/* Parse the decompressed text.  Returns nullptr when the whole file is refused
 * (reason in why); the snapshot otherwise, with per-row verdicts set. */
static snapshot *parse_snapshot(buf *text, char *why, size_t whysz) {
    sv all = { text->p, text->n };
    if (all.n >= 3 && all.p[0] == 0xEF && all.p[1] == 0xBB && all.p[2] == 0xBF) { all.p += 3; all.n -= 3; }   /* forgive a BOM */
    if (!utf8_valid(all)) { snprintf(why, whysz, "not UTF-8"); return nullptr; }
    if (all.n == 0 || all.p[all.n - 1] != '\n') { snprintf(why, whysz, "cut short: the last line has no LF"); return nullptr; }
    /* lines */
    sv *lines = nullptr; size_t nlines = 0, start = 0;
    for (size_t i = 0; i < all.n; i++) if (all.p[i] == '\n') { lines = xrealloc(lines, (nlines + 1) * sizeof *lines); lines[nlines++] = (sv){all.p + start, i - start}; start = i + 1; }
    if (nlines < 2) { snprintf(why, whysz, "too short to hold a heading row and the `.`"); free(lines); return nullptr; }
    if (!sv_eq(lines[nlines - 1], ".")) { snprintf(why, whysz, "the last line is not `.`: the file was cut short or isn't a snapshot"); free(lines); return nullptr; }
    if (!is_heading(split_fields(lines[0]))) { snprintf(why, whysz, "the first line is not the heading row"); free(lines); return nullptr; }

    snapshot *s = xmalloc(sizeof *s); memset(s, 0, sizeof *s);
    for (size_t i = 1; i + 1 < nlines; i++) {
        sv line = lines[i];
        if (line.n == 0) { snprintf(why, whysz, "line %zu is blank", i + 1); goto refuse_whole; }
        fields f = split_fields(line);
        sv type = f.f[0];
        if (sv_eq(type, "-")) {
            s->rows = xrealloc(s->rows, (s->nrows + 1) * sizeof *s->rows);
            filerow *r = &s->rows[s->nrows++]; memset(r, 0, sizeof *r);
            r->lineno = i + 1; r->f = f; r->path = f.f[4]; r->hash = f.f[1]; r->state = R_PENDING;
        } else if (type.n && type.p[0] == '@') {
            sv prop = f.f[1];
            if (sv_eq(type, "@SET") && sv_eq(prop, "DIR")) {
                if (f.nf < 5 || f.f[4].n == 0) { fprintf(stderr, "s3cab-restore: line %zu: @SET DIR with no value is no directory; ignored\n", i + 1); continue; }
                s->dirs = xrealloc(s->dirs, (s->ndirs + 1) * sizeof *s->dirs);
                dirrow *d = &s->dirs[s->ndirs++]; memset(d, 0, sizeof *d);
                d->raw = f.f[4]; d->lineno = i + 1;
                d->pp = parse_path(d->raw, true);
                d->valid = d->pp.absolute && !has_byte(d->raw, 0);
                for (size_t k = 0; k < d->pp.nseg; k++) if (d->pp.seg[k].n == 0) d->valid = false;      /* doubled separator */
                if (d->pp.share && d->pp.nseg < 2) d->valid = false;                                      /* no server or no share */
                if (!d->valid) { fprintf(stderr, "s3cab-restore: line %zu: @SET DIR `", i + 1); print_escaped(stderr, d->raw); fputs("` matches nothing\n", stderr); }
            } else if (sv_eq(type, "@SNAPSHOT") && sv_eq(prop, "START")) {
                if (!s->has_start && parse_instant(f.f[3], nullptr)) { memcpy(s->start, f.f[3].p, 24); s->start[24] = 0; s->has_start = true; }
            }
            /* every other @ row and property: skipped */
        } else if (type.n && type.p[0] == '#') {
            /* a path a restore doesn't act on */
        } else {
            snprintf(why, whysz, "line %zu has an unknown row type `%.*s`", i + 1, (int)(type.n > 40 ? 40 : type.n), (const char *)type.p);
            goto refuse_whole;
        }
    }
    free(lines);
    return s;
refuse_whole:
    free(lines); free(s->rows); free(s->dirs); free(s);
    return nullptr;
}

/* Per-row checks, then the two-row checks. */
static int cmp_rowpath(const void *a, const void *b) {
    const filerow *const *ra = a, *const *rb = b;
    size_t n = (*ra)->path.n < (*rb)->path.n ? (*ra)->path.n : (*rb)->path.n;
    int c = n ? memcmp((*ra)->path.p, (*rb)->path.p, n) : 0;
    if (c) return c;
    return (*ra)->path.n < (*rb)->path.n ? -1 : (*ra)->path.n > (*rb)->path.n;
}
static void check_rows(snapshot *s) {
    for (size_t i = 0; i < s->nrows; i++) {
        filerow *r = &s->rows[i]; fields *f = &r->f;
        r->wellformed = true;
        if (f->nf < 5) { refuse(r, "malformed: fewer than five fields"); r->wellformed = false; }
        if (!is_hash(f->f[1])) { refuse(r, "malformed: the hash is not 64 lowercase hex characters"); r->wellformed = false; }
        if (!all_digits(f->f[2])) { refuse(r, "malformed: the size is not decimal digits"); r->wellformed = false; }
        if (!parse_instant(f->f[3], &r->mtime_ms)) { refuse(r, "malformed: the time is not a real instant in the 24-character form"); r->wellformed = false; }
        sv p = r->path;
        if (p.n == 0) { refuse(r, "malformed: no path"); r->wellformed = false; continue; }
        if (has_byte(p, '\t')) { refuse(r, "the path holds a tab"); r->wellformed = false; }
        if (has_byte(p, '\r')) { refuse(r, "the path holds a CR"); r->wellformed = false; }
        if (has_byte(p, 0)) { refuse(r, "the path holds a NUL"); r->wellformed = false; }
        r->pp = parse_path(p, false);
        if (!r->pp.absolute) { refuse(r, "the path is not absolute"); r->wellformed = false; continue; }
        for (size_t k = 0; k < r->pp.nseg; k++) {
            sv g = r->pp.seg[k];
            if (g.n == 0) { refuse(r, "the path has an empty segment (a doubled or trailing separator)"); r->wellformed = false; break; }
            if (sv_eq(g, ".") || sv_eq(g, "..")) { refuse(r, "the path has a `%s` segment", sv_eq(g, ".") ? "." : ".."); r->wellformed = false; break; }
        }
        if (r->pp.nseg == 0) { refuse(r, "the path is only a root"); r->wellformed = false; }
        if (r->state == R_REFUSED) continue;
        /* strictly inside a @SET DIR, matched by whole segments */
        bool inside = false;
        for (size_t d = 0; d < s->ndirs && !inside; d++) {
            dirrow *D = &s->dirs[d]; if (!D->valid || D->pp.kind != r->pp.kind) continue;
            if (D->pp.kind == K_WIN && (D->pp.share != r->pp.share || D->pp.drive != r->pp.drive)) continue;
            if (D->pp.nseg >= r->pp.nseg) continue;                        /* equal to the DIR, or shorter: not strictly inside */
            bool m = true;
            for (size_t k = 0; k < D->pp.nseg && m; k++) m = seg_eq(D->pp.seg[k], r->pp.seg[k], D->pp.kind);
            inside = m;
        }
        if (!inside) refuse(r, "not strictly inside any @SET DIR");
    }
    /* one path in two rows: every file row takes part, malformed ones included */
    if (s->nrows > 1) {
        filerow **idx = xmalloc(s->nrows * sizeof *idx);
        for (size_t i = 0; i < s->nrows; i++) idx[i] = &s->rows[i];
        qsort(idx, s->nrows, sizeof *idx, cmp_rowpath);
        for (size_t i = 0; i + 1 < s->nrows; i++) {
            if (sv_eqv(idx[i]->path, idx[i + 1]->path)) {
                filerow *a = idx[i], *b = idx[i + 1];
                if (a->state != R_REFUSED) refuse(a, "the same path is in another row (line %zu)", b->lineno); else set_why(a, "%s; the same path is also in line %zu", a->why, b->lineno);
                if (b->state != R_REFUSED) refuse(b, "the same path is in another row (line %zu)", a->lineno); else set_why(b, "%s; the same path is also in line %zu", b->why, a->lineno);
            }
        }
        /* one path running through another as a folder, among the rows still standing */
        for (size_t i = 0; i < s->nrows; i++) {
            filerow *a = idx[i]; if (a->state == R_REFUSED) continue;
            for (size_t j = i + 1; j < s->nrows; j++) {
                filerow *b = idx[j];
                if (b->path.n <= a->path.n || memcmp(b->path.p, a->path.p, a->path.n) != 0) break;   /* prefix block ended */
                if (b->state == R_REFUSED) continue;
                if (is_sep(b->path.p[a->path.n], a->pp.kind)) {
                    refuse(a, "another row's path runs through this one as a folder (line %zu)", b->lineno);
                    refuse(b, "this path runs through another row's file (line %zu)", a->lineno);
                }
            }
        }
        free(idx);
    }
}

/* ------------------------------------------------------------------------ */
/* deletion records                                                         */
/* ------------------------------------------------------------------------ */
typedef struct { char hash[65]; char when[25]; char *who; } delrow;
typedef struct { delrow *rows; size_t n; bool loaded; } delset;

static bool is_record_key(const char *k) {
    const char pre[] = "objects.deleted-"; size_t pl = sizeof pre - 1;
    if (strncmp(k, pre, pl) != 0) return false;
    const char *d = k + pl; if (*d < '1' || *d > '9') return false;
    while (*d >= '0' && *d <= '9') d++;
    return strcmp(d, ".tsv") == 0;
}
static void parse_record(delset *ds, const uint8_t *p, size_t n) {
    size_t start = 0; bool first = true;
    for (size_t i = 0; i <= n; i++) {
        if (i < n && p[i] != '\n') continue;
        if (i == n && start == n) break;                     /* nothing after the last LF */
        sv line = { p + start, i - start }; start = i + 1;
        if (first && line.n >= 3 && line.p[0] == 0xEF && line.p[1] == 0xBB && line.p[2] == 0xBF) { line.p += 3; line.n -= 3; }
        first = false;
        if (!utf8_valid(line)) continue;                     /* one wrong line */
        fields f = split_fields(line);
        if (!sv_eq(f.f[0], "#deleted")) continue;
        if (!is_hash(f.f[1]) || !all_digits(f.f[2]) || !parse_instant(f.f[3], nullptr)) continue;   /* malformed: counts as not deleted */
        ds->rows = xrealloc(ds->rows, (ds->n + 1) * sizeof *ds->rows);
        delrow *d = &ds->rows[ds->n++];
        memcpy(d->hash, f.f[1].p, 64); d->hash[64] = 0; memcpy(d->when, f.f[3].p, 24); d->when[24] = 0; d->who = sv_dup(f.f[4]);
    }
}
static void load_records(s3ctx *c, delset *ds) {
    if (ds->loaded) return;
    ds->loaded = true;
    char **keys = nullptr; size_t nkeys = 0;
    s3_list_direct(c, "objects.deleted-", &keys, &nkeys);
    size_t nrec = 0;
    for (size_t i = 0; i < nkeys; i++) {
        if (!is_record_key(keys[i])) continue;
        nrec++;
        response r = { .fd = -1 };
        if (!s3_get(c, keys[i], "", &r)) die("reading %s: %s", keys[i], r.errbuf);
        if (r.status == 404 && (strcmp(r.code, "NoSuchKey") == 0 || strcmp(r.code, "NotFound") == 0)) {
            fprintf(stderr, "s3cab-restore: %s was listed but is gone: it explains nothing\n", keys[i]); buf_free(&r.body); continue;
        }
        if (r.status != 200) die("reading %s: HTTP %ld %s", keys[i], r.status, r.code);
        parse_record(ds, r.body.p ? r.body.p : (const uint8_t *)"", r.body.n);
        buf_free(&r.body);
    }
    fprintf(stderr, "s3cab-restore: read %zu deletion record(s), %zu well-formed #deleted row(s)\n", nrec, ds->n);
    for (size_t i = 0; i < nkeys; i++) free(keys[i]);
    free(keys);
}
/* The newest row for the hash, or nullptr. */
static const delrow *find_deleted(const delset *ds, sv hash) {
    const delrow *best = nullptr;
    for (size_t i = 0; i < ds->n; i++) {
        if (hash.n != 64 || memcmp(ds->rows[i].hash, hash.p, 64) != 0) continue;
        if (!best || strcmp(ds->rows[i].when, best->when) > 0) best = &ds->rows[i];
    }
    return best;
}

/* ------------------------------------------------------------------------ */
/* the destination                                                          */
/* ------------------------------------------------------------------------ */
typedef struct { dev_t dev; ino_t ino; } ident;
typedef struct {
    const char *root;           /* <output> as given */
    int anchor_fd;              /* nearest existing ancestor of <output>: where temp files are born */
    ident *written; size_t nwritten;
    char **badhash; size_t nbadhash;   /* downloads that didn't hash to their key: never fetched again */
} dest;

static bool was_written(const dest *d, const struct stat *st) {
    for (size_t i = 0; i < d->nwritten; i++) if (d->written[i].dev == st->st_dev && d->written[i].ino == st->st_ino) return true;
    return false;
}
static void dest_path(const dest *d, const filerow *r, buf *out) {
    buf_clear(out); buf_puts(out, d->root);
    if (r->pp.kind == K_WIN) { buf_putc(out, '/'); if (r->pp.share) buf_puts(out, "UNC"); else buf_putc(out, r->pp.drive); }
    for (size_t k = 0; k < r->pp.nseg; k++) { buf_putc(out, '/'); buf_push(out, r->pp.seg[k].p, r->pp.seg[k].n); }
}
/* Look at every folder between <output> and the file, and at the file's own
 * name, without following links.  Returns 0 to proceed, else sets the row's
 * state (R_INWAY, R_EXISTS or R_COLLISION). */
static int precheck(dest *d, filerow *r, const char *path) {
    size_t rootlen = strlen(d->root);
    char *tmp = xstrdup(path);
    for (size_t i = rootlen + 1; tmp[i]; i++) {
        if (tmp[i] != '/') continue;
        tmp[i] = 0;
        struct stat st;
        if (lstat(tmp, &st) == 0) {
            if (S_ISLNK(st.st_mode)) { r->state = R_INWAY; set_why(r, "a link where a folder should be: %s", tmp); free(tmp); return 1; }
            if (!S_ISDIR(st.st_mode)) { r->state = R_INWAY; set_why(r, "a file where a folder should be: %s", tmp); free(tmp); return 1; }
        } else if (errno != ENOENT) { r->state = R_FAILED; set_why(r, "lstat %s: %s", tmp, strerror(errno)); free(tmp); return 1; }
        else { free(tmp); return 0; }    /* nothing from here down: all folders will be made */
        tmp[i] = '/';
    }
    free(tmp);
    struct stat st;
    if (lstat(path, &st) == 0) {
        if (S_ISDIR(st.st_mode)) { r->state = R_INWAY; set_why(r, "a folder where the file should land"); return 1; }
        if (was_written(d, &st)) { r->state = R_COLLISION; set_why(r, "another row of this restore already landed here"); return 1; }
        r->state = R_EXISTS; set_why(r, "a file was already there before the restore; left alone"); return 1;
    }
    if (errno != ENOENT) { r->state = R_FAILED; set_why(r, "lstat: %s", strerror(errno)); return 1; }
    return 0;
}
/* Make the folders the file needs, from the nearest existing ancestor of
 * <output> down (so <output> itself and anything missing above it is made too);
 * remember which were made for rollback.  Returns 0 made, 1 in the way, 2 failed. */
static int make_folders(dest *d, const char *path, char ***made, size_t *nmade, char *err, size_t errsz) {
    size_t rootlen = strlen(d->root);
    char *tmp = xstrdup(path);
    for (size_t i = 1; tmp[i]; i++) {
        if (tmp[i] != '/') continue;
        tmp[i] = 0;
        struct stat st;
        /* inside <output> a link at a folder position is in the way (lstat); <output> itself and
         * everything above it is the user's path, and a link there is followed (stat) */
        int src = i > rootlen ? lstat(tmp, &st) : stat(tmp, &st);
        if (src == 0) {
            if (i > rootlen && S_ISLNK(st.st_mode)) { snprintf(err, errsz, "a link where a folder should be: %s", tmp); free(tmp); return 1; }
            if (!S_ISDIR(st.st_mode)) { snprintf(err, errsz, "a file where a folder should be: %s", tmp); free(tmp); return 1; }
        } else if (errno == ENOENT) {
            if (mkdir(tmp, 0777) != 0) {
                int e = errno; snprintf(err, errsz, "mkdir %s: %s", tmp, strerror(e)); free(tmp);
                return (e == EEXIST || e == ENOTDIR) ? 1 : 2;
            }
            *made = xrealloc(*made, (*nmade + 1) * sizeof **made); (*made)[(*nmade)++] = xstrdup(tmp);
        } else { snprintf(err, errsz, "lstat %s: %s", tmp, strerror(errno)); free(tmp); return 2; }
        tmp[i] = '/';
    }
    free(tmp);
    return 0;
}
static void free_made(char **made, size_t nmade) { for (size_t i = 0; i < nmade; i++) free(made[i]); free(made); }
static void unmake_folders(char **made, size_t nmade) { for (size_t i = nmade; i-- > 0;) rmdir(made[i]); free_made(made, nmade); }

static int open_anchor(const char *root) {
    char *p = xstrdup(root);
    for (;;) {
        int fd = open(p[0] ? p : ".", O_RDONLY | O_DIRECTORY);
        if (fd >= 0) { free(p); return fd; }
        if (errno != ENOENT) die("opening %s: %s", p, strerror(errno));
        char *slash = strrchr(p, '/');
        if (!slash) { free(p); return open(".", O_RDONLY | O_DIRECTORY); }
        if (slash == p) { p[1] = 0; } else *slash = 0;
    }
}

/* ------------------------------------------------------------------------ */
/* restoring one row                                                        */
/* ------------------------------------------------------------------------ */
static int64_t round_ms(const struct timespec *ts) { return (int64_t)ts->tv_sec * 1000 + (ts->tv_nsec + 500000) / 1000000; }

static void restore_row(s3ctx *c, dest *d, delset *ds, const snapshot *s, filerow *r) {
    buf dp = {0}; dest_path(d, r, &dp); r->dest = xstrdup((char *)dp.p); buf_free(&dp);
    if (precheck(d, r, r->dest)) return;
    for (size_t i = 0; i < d->nbadhash; i++) if (memcmp(d->badhash[i], r->hash.p, 64) == 0) { r->state = R_DAMAGE; set_why(r, "an earlier download of this object didn't hash to its key; not fetched again"); return; }

    /* fetch into a file with no name yet, on the destination's filesystem */
    int fd = openat(d->anchor_fd, ".", O_TMPFILE | O_RDWR, 0666);
    bool named_tmp = false; char tmpname[64] = "";
    if (fd < 0) {
        snprintf(tmpname, sizeof tmpname, ".s3cab-restore.%ld.tmp", (long)getpid());
        fd = openat(d->anchor_fd, tmpname, O_CREAT | O_EXCL | O_RDWR, 0666);
        if (fd < 0) { r->state = R_FAILED; set_why(r, "creating a temporary file: %s", strerror(errno)); return; }
        named_tmp = true;
    }
    char key[80]; snprintf(key, sizeof key, "objects/%.64s", (const char *)r->hash.p);
    response resp = { .fd = fd, .md = EVP_MD_CTX_new() };
    if (!resp.md) die("EVP_MD_CTX_new");
    bool got = s3_get(c, key, "", &resp);
    if (!got) {
        r->state = R_FAILED; set_why(r, "fetching %s: %s", key, resp.errbuf);
        die("%s: the request failed after its retries; stopping the restore", r->why);
    }
    if (resp.status == 404 && (strcmp(resp.code, "NoSuchKey") == 0 || strcmp(resp.code, "NotFound") == 0)) {
        load_records(c, ds);
        const delrow *dr = find_deleted(ds, r->hash);
        if (dr && s->has_start && strcmp(dr->when, s->start) > 0) { r->state = R_DELETED; set_why(r, "deliberately deleted %s by %s", dr->when, dr->who[0] ? dr->who : "(nobody named)"); }
        else if (dr) { r->state = R_DAMAGE; set_why(r, "object missing; the only deletion record row (%s) is not later than the snapshot's START%s", dr->when, s->has_start ? "" : " (which the snapshot lacks)"); }
        else { r->state = R_DAMAGE; set_why(r, "object missing, and no deletion record explains it"); }
        goto out;
    }
    if (resp.status == 404) die("fetching %s: HTTP 404 %s, which says nothing about the file; stopping", key, resp.code);
    if (resp.status == 403) die("fetching %s: HTTP 403 %s (a permissions fault, or a missing key the caller may not list); stopping", key, resp.code);
    if (resp.status != 200) die("fetching %s: HTTP %ld %s; stopping", key, resp.status, resp.code);

    uint8_t md[32]; unsigned int mdlen = 32; char hex[65];
    if (!EVP_DigestFinal_ex(resp.md, md, &mdlen)) die("EVP_DigestFinal_ex");
    to_hex(md, 32, hex);
    if (memcmp(hex, r->hash.p, 64) != 0) {
        r->state = R_DAMAGE; set_why(r, "download of %" PRIu64 " bytes hashes to %s, not its key; withheld", resp.nbytes, hex);
        d->badhash = xrealloc(d->badhash, (d->nbadhash + 1) * sizeof *d->badhash); d->badhash[d->nbadhash++] = sv_dup(r->hash);
        goto out;
    }
    /* the stored instant, to the millisecond, on both times */
    {
        int64_t ms = r->mtime_ms; int64_t sec = ms / 1000, frac = ms % 1000; if (frac < 0) { frac += 1000; sec--; }
        struct timespec ts[2] = { { (time_t)sec, (long)frac * 1000000L }, { (time_t)sec, (long)frac * 1000000L } };
        if (futimens(fd, ts) != 0) { r->state = R_TIME_LOST; set_why(r, "setting the modification time: %s", strerror(errno)); }
    }
    /* folders, then the name */
    char **made = nullptr; size_t nmade = 0; char err[512];
    { int mf = make_folders(d, r->dest, &made, &nmade, err, sizeof err);
      if (mf) { r->state = mf == 1 ? R_INWAY : R_FAILED; set_why(r, "%s", err); unmake_folders(made, nmade); goto out; } }
    int lrc;
    if (named_tmp) lrc = linkat(d->anchor_fd, tmpname, AT_FDCWD, r->dest, 0);
    else {
        lrc = linkat(fd, "", AT_FDCWD, r->dest, AT_EMPTY_PATH);
        if (lrc != 0 && (errno == ENOENT || errno == EPERM)) { char proc[64]; snprintf(proc, sizeof proc, "/proc/self/fd/%d", fd); lrc = linkat(AT_FDCWD, proc, AT_FDCWD, r->dest, AT_SYMLINK_FOLLOW); }
    }
    if (lrc != 0) {
        int e = errno;
        if (e == EEXIST) { struct stat st; if (lstat(r->dest, &st) == 0 && was_written(d, &st)) { r->state = R_COLLISION; set_why(r, "another row of this restore landed here first"); } else { r->state = R_INWAY; set_why(r, "something appeared at the destination during the restore"); } }
        else if (e == ENAMETOOLONG) { r->state = R_FAILED; set_why(r, "a name the destination won't create: too long (Linux allows 255 bytes)"); }
        else { r->state = R_FAILED; set_why(r, "placing the file: %s", strerror(e)); }
        unmake_folders(made, nmade); goto out;
    }
    free_made(made, nmade);
    {
        struct stat st; if (fstat(fd, &st) != 0) die("fstat: %s", strerror(errno));
        d->written = xrealloc(d->written, (d->nwritten + 1) * sizeof *d->written); d->written[d->nwritten++] = (ident){ st.st_dev, st.st_ino };
        if (r->state != R_TIME_LOST) {
            int64_t have = round_ms(&st.st_mtim), want = r->mtime_ms, diff = have > want ? have - want : want - have;
            char hs[64]; format_ms(have, hs);
            if (diff == 0) { r->state = R_RESTORED; set_why(r, "%" PRIu64 " bytes", resp.nbytes); }
            else if (diff < 2000) { r->state = R_TIME_ROUNDED; set_why(r, "the disk rounded the time to %s (off by %" PRId64 " ms)", hs, diff); }
            else { r->state = R_TIME_LOST; set_why(r, "the destination can't hold the time: it has %s", hs); }
        }
    }
out:
    if (named_tmp) unlinkat(d->anchor_fd, tmpname, 0);
    EVP_MD_CTX_free(resp.md); buf_free(&resp.body); close(fd);
}

/* ------------------------------------------------------------------------ */
/* main                                                                     */
/* ------------------------------------------------------------------------ */
static bool valid_set_name(const char *s) {
    if (!*s) return false;
    bool prev_hyphen = true;   /* a leading hyphen is refused */
    for (; *s; s++) {
        if ((*s >= 'a' && *s <= 'z') || (*s >= '0' && *s <= '9')) prev_hyphen = false;
        else if (*s == '-' && !prev_hyphen) prev_hyphen = true;
        else return false;
    }
    return !prev_hyphen;
}
static bool is_snapshot_name(const char *n) {
    if (strlen(n) != 13 || n[8] != 'T') return false;
    for (int i = 0; i < 13; i++) if (i != 8 && (n[i] < '0' || n[i] > '9')) return false;
    return true;
}
static const char *state_name(enum rowstate st) {
    switch (st) {
    case R_RESTORED: return "restored"; case R_EXISTS: return "exists"; case R_DELETED: return "deleted"; case R_REFUSED: return "REFUSED";
    case R_DAMAGE: return "DAMAGE"; case R_COLLISION: return "COLLISION"; case R_INWAY: return "IN-THE-WAY"; case R_TIME_ROUNDED: return "restored~time";
    case R_TIME_LOST: return "TIME-NOT-HELD"; case R_FAILED: return "FAILED"; default: return "pending";
    }
}

int main(int argc, char **argv) {
    setlocale(LC_CTYPE, "C.UTF-8");
    if (argc != 4 && argc != 5) { fprintf(stderr, "usage: s3cab-restore <bucket> <set> <dir> [<snapshot>]\n"); return 2; }
    const char *bucket = argv[1], *set = argv[2], *root = argv[3];
    char snapname[32] = "";
    if (argc == 5) {
        snprintf(snapname, sizeof snapname, "%.31s", argv[4]);
        size_t L = strlen(snapname); if (L > 7 && strcmp(snapname + L - 7, ".tsv.gz") == 0) snapname[L - 7] = 0;
        if (!is_snapshot_name(snapname)) die("`%s` is not a snapshot name (YYYYMMDDTHHMM)", argv[4]);
    }
    if (!valid_set_name(set)) die("`%s` is not a set name: a-z, 0-9 and single hyphens between them", set);
    if (!*root) die("the output directory is empty");
    srand((unsigned)(time(nullptr) ^ getpid()));

    s3ctx c = {0};
    c.bucket = bucket;
    c.region = getenv("AWS_REGION"); if (!c.region || !*c.region) c.region = getenv("AWS_DEFAULT_REGION"); if (!c.region || !*c.region) c.region = "us-east-1";
    c.akid = getenv("AWS_ACCESS_KEY_ID"); c.secret = getenv("AWS_SECRET_ACCESS_KEY"); c.token = getenv("AWS_SESSION_TOKEN");
    if (c.token && !*c.token) c.token = nullptr;
    if (!c.akid || !c.secret || !*c.akid || !*c.secret) die("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set");
    c.proxy = getenv("HTTPS_PROXY"); if (!c.proxy || !*c.proxy) c.proxy = getenv("https_proxy"); if (c.proxy && !*c.proxy) c.proxy = nullptr;
    c.verbose = getenv("S3CAB_RESTORE_DEBUG") != nullptr;
    snprintf(c.host, sizeof c.host, "%s.s3.%s.amazonaws.com", bucket, c.region);
    if (curl_global_init(CURL_GLOBAL_ALL) != CURLE_OK) die("curl_global_init");
    c.curl = curl_easy_init(); if (!c.curl) die("curl_easy_init");

    /* 1. which snapshot */
    char prefix[600]; snprintf(prefix, sizeof prefix, "snapshots/%s/", set);
    if (!snapname[0]) {
        char **keys = nullptr; size_t nkeys = 0;
        s3_list_direct(&c, prefix, &keys, &nkeys);
        for (size_t i = 0; i < nkeys; i++) {
            const char *k = keys[i] + strlen(prefix);
            size_t L = strlen(k);
            if (L == 20 && strcmp(k + 13, ".tsv.gz") == 0) { char nm[32]; snprintf(nm, sizeof nm, "%.13s", k); if (is_snapshot_name(nm) && strcmp(nm, snapname) > 0) snprintf(snapname, sizeof snapname, "%s", nm); }
            free(keys[i]);
        }
        free(keys);
        if (!snapname[0]) die("set `%s` has no snapshot under %s", set, prefix);
    }
    char skey[700]; snprintf(skey, sizeof skey, "%s%s.tsv.gz", prefix, snapname);
    fprintf(stderr, "s3cab-restore: bucket %s, region %s, snapshot %s\n", bucket, c.region, skey);

    /* 2. fetch and decompress it */
    response sr = { .fd = -1 };
    const char *local = getenv("S3CAB_RESTORE_SNAPSHOT_FILE");   /* test aid: read the .tsv.gz from disk instead of the bucket */
    if (local) {
        FILE *fp = fopen(local, "rb"); if (!fp) die("opening %s: %s", local, strerror(errno));
        uint8_t chunk[65536]; size_t n; while ((n = fread(chunk, 1, sizeof chunk, fp)) > 0) buf_push(&sr.body, chunk, n);
        fclose(fp); sr.status = 200;
        fprintf(stderr, "s3cab-restore: (test aid) snapshot bytes read from %s\n", local);
    } else {
        if (!s3_get(&c, skey, "", &sr)) die("fetching %s: %s", skey, sr.errbuf);
        if (sr.status == 404) die("no such snapshot: %s (HTTP 404 %s)", skey, sr.code);
        if (sr.status != 200) die("fetching %s: HTTP %ld %s", skey, sr.status, sr.code);
    }
    buf text = {0}; char why[512];
    if (!gunzip_all(sr.body.p, sr.body.n, &text, why, sizeof why)) die("snapshot %s is damaged: %s; refusing to restore from it", skey, why);
    buf_free(&sr.body);

    /* 3. parse and check */
    snapshot *s = parse_snapshot(&text, why, sizeof why);
    if (!s) die("snapshot %s refused whole: %s", skey, why);
    check_rows(s);
    fprintf(stderr, "s3cab-restore: %zu file row(s), %zu @SET DIR row(s), START %s\n", s->nrows, s->ndirs, s->has_start ? s->start : "(none)");

    /* 4. restore */
    dest d = { .root = root };
    { struct stat st; if (stat(root, &st) == 0 && !S_ISDIR(st.st_mode)) die("%s exists and is not a directory", root); }
    d.anchor_fd = open_anchor(root); if (d.anchor_fd < 0) die("no existing ancestor of %s to work in", root);
    delset ds = {0};
    size_t counts[R_FAILED + 1] = {0};
    for (size_t i = 0; i < s->nrows; i++) {
        filerow *r = &s->rows[i];
        if (r->state == R_PENDING) restore_row(&c, &d, &ds, s, r);
        counts[r->state]++;
        printf("%-14s ", state_name(r->state)); print_escaped(stdout, r->path);
        if (r->dest && (r->state == R_RESTORED || r->state == R_TIME_ROUNDED || r->state == R_TIME_LOST || r->state == R_EXISTS || r->state == R_COLLISION)) { fputs("  -> ", stdout); print_escaped_str(stdout, r->dest); }
        if (r->why) { fputs("  (", stdout); print_escaped_str(stdout, r->why); fputs(")", stdout); }
        fputc('\n', stdout); fflush(stdout);
    }
    bool damage = counts[R_REFUSED] || counts[R_DAMAGE] || counts[R_COLLISION] || counts[R_INWAY] || counts[R_TIME_LOST] || counts[R_FAILED];
    printf("summary: %zu file rows: restored %zu (+%zu with the time rounded by the disk), already there %zu, deliberately deleted %zu, refused %zu, damaged %zu, collisions %zu, in the way %zu, time not held %zu, failed %zu; %lu request(s); exit %d\n",
           s->nrows, counts[R_RESTORED], counts[R_TIME_ROUNDED], counts[R_EXISTS], counts[R_DELETED], counts[R_REFUSED], counts[R_DAMAGE], counts[R_COLLISION], counts[R_INWAY], counts[R_TIME_LOST], counts[R_FAILED], c.requests, damage ? 1 : 0);
    curl_easy_cleanup(c.curl);
    return damage ? 1 : 0;
}
