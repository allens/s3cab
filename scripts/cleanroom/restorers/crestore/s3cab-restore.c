/*
 * s3cab-restore — a clean-room restorer for the s3cab repository format,
 * written from format.md (spec of 2026-10-23) and nothing else.
 *
 *   ./s3cab-restore <bucket> <set> <dir> [<snapshot>]
 *
 * Credentials and region come from the environment (AWS_ACCESS_KEY_ID,
 * AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AWS_REGION); the proxy from
 * HTTPS_PROXY. No AWS SDK: requests are signed here (SigV4) and sent with the
 * platform's libcurl; hashing is OpenSSL's libcrypto, gzip is zlib.
 *
 * Debug knobs (environment): S3CAB_RESTORE_DEBUG=1 (curl verbose + extra
 * logging on stderr), S3CAB_RESTORE_DUMP=<file> (write the decompressed
 * snapshot text there), S3CAB_RESTORE_LIST=1 (list the set's snapshot keys
 * and the deletion-record keys, then exit without restoring), S3CAB_RESTORE_LOCAL_SNAPSHOT=<file.tsv.gz>
 * (parser tests: snapshot bytes from disk, objects still from the bucket), S3CAB_RESTORE_DUMP_RECORDS=<dir>,
 * S3CAB_RESTORE_NO_TMPFILE=1 (force the memfd-and-copy write path).
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdarg.h>
#include <errno.h>
#include <time.h>
#include <wctype.h>
#include <locale.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/mman.h>
#include <sys/random.h>
#include <openssl/evp.h>
#include <openssl/core_names.h>
#include <openssl/params.h>
#include <zlib.h>

/* ------------------------------------------------------------------------ */
/* libcurl: the runtime (libcurl4t64) is packaged and installed; its header  */
/* package is not, so the handful of ABI-stable declarations used are here.  */
/* Option ids are verified against curl_easy_option_by_name() at startup.    */
/* ------------------------------------------------------------------------ */
typedef void CURL;
typedef int CURLcode;
typedef int CURLoption;
typedef int CURLINFO;
struct curl_slist;
CURLcode curl_global_init(long flags);
CURL *curl_easy_init(void);
CURLcode curl_easy_setopt(CURL *, CURLoption, ...);
CURLcode curl_easy_perform(CURL *);
CURLcode curl_easy_getinfo(CURL *, CURLINFO, ...);
void curl_easy_cleanup(CURL *);
void curl_easy_reset(CURL *);
struct curl_slist *curl_slist_append(struct curl_slist *, const char *);
void curl_slist_free_all(struct curl_slist *);
const char *curl_easy_strerror(CURLcode);
struct curl_easyoption { const char *name; CURLoption id; int type; unsigned int flags; };
const struct curl_easyoption *curl_easy_option_by_name(const char *name);
enum {
    CURLOPT_WRITEDATA = 10001, CURLOPT_URL = 10002, CURLOPT_PROXY = 10004,
    CURLOPT_ERRORBUFFER = 10010, CURLOPT_WRITEFUNCTION = 20011, CURLOPT_USERAGENT = 10018,
    CURLOPT_LOW_SPEED_LIMIT = 19, CURLOPT_LOW_SPEED_TIME = 20, CURLOPT_HTTPHEADER = 10023,
    CURLOPT_HEADERDATA = 10029, CURLOPT_VERBOSE = 41, CURLOPT_CONNECTTIMEOUT = 78,
    CURLOPT_HEADERFUNCTION = 20079, CURLOPT_HTTPGET = 80, CURLOPT_NOSIGNAL = 99,
    CURLOPT_HTTP_CONTENT_DECODING = 158, CURLOPT_FOLLOWLOCATION = 52,
};
enum { CURLINFO_RESPONSE_CODE = 0x200002 };
enum {
    CURLE_OK = 0, CURLE_COULDNT_RESOLVE_PROXY = 5, CURLE_COULDNT_RESOLVE_HOST = 6,
    CURLE_COULDNT_CONNECT = 7, CURLE_PARTIAL_FILE = 18, CURLE_WRITE_ERROR = 23,
    CURLE_OPERATION_TIMEDOUT = 28, CURLE_SSL_CONNECT_ERROR = 35, CURLE_GOT_NOTHING = 52,
    CURLE_SEND_ERROR = 55, CURLE_RECV_ERROR = 56,
};
#define CURL_GLOBAL_DEFAULT 3L
#define CURL_ERROR_SIZE 256

static bool g_debug = false;

static void die(const char *fmt, ...) {
    va_list ap; va_start(ap, fmt);
    fputs("s3cab-restore: fatal: ", stderr);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    va_end(ap);
    exit(1);
}
static void dbg(const char *fmt, ...) {
    if (!g_debug) return;
    va_list ap; va_start(ap, fmt);
    fputs("[debug] ", stderr);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    va_end(ap);
}
static void *xmalloc(size_t n) { void *p = malloc(n ? n : 1); if (!p) die("out of memory"); return p; }
static void *xrealloc(void *p, size_t n) { p = realloc(p, n ? n : 1); if (!p) die("out of memory"); return p; }
static char *xstrdup(const char *s) { size_t n = strlen(s) + 1; char *p = xmalloc(n); memcpy(p, s, n); return p; }
static char *xstrndup(const void *s, size_t n) { char *p = xmalloc(n + 1); memcpy(p, s, n); p[n] = 0; return p; }

typedef struct { unsigned char *p; size_t n, cap; } buf_t;
static void buf_push(buf_t *b, const void *d, size_t n) {
    if (b->n + n + 1 > b->cap) {
        size_t c = b->cap ? b->cap : 4096;
        while (c < b->n + n + 1) c *= 2;
        b->p = xrealloc(b->p, c); b->cap = c;
    }
    memcpy(b->p + b->n, d, n); b->n += n; b->p[b->n] = 0;
}
static void buf_puts(buf_t *b, const char *s) { buf_push(b, s, strlen(s)); }
static void buf_free(buf_t *b) { free(b->p); b->p = NULL; b->n = b->cap = 0; }

typedef struct { char **v; int n, cap; } strlist_t;
static void sl_push(strlist_t *l, char *s) {
    if (l->n == l->cap) { l->cap = l->cap ? l->cap * 2 : 16; l->v = xrealloc(l->v, sizeof(char *) * l->cap); }
    l->v[l->n++] = s;
}

/* ------------------------------------------------------------------------ */
/* Hashing                                                                   */
/* ------------------------------------------------------------------------ */
static const char HEX[] = "0123456789abcdef";
static void to_hex(const unsigned char *d, size_t n, char *out) {
    for (size_t i = 0; i < n; i++) { out[2 * i] = HEX[d[i] >> 4]; out[2 * i + 1] = HEX[d[i] & 15]; }
    out[2 * n] = 0;
}
static void sha256_hex(const void *d, size_t n, char out[65]) {
    unsigned char md[32]; unsigned int len = 32;
    EVP_MD_CTX *c = EVP_MD_CTX_new();
    if (!c || !EVP_DigestInit_ex(c, EVP_sha256(), NULL) || !EVP_DigestUpdate(c, d, n) || !EVP_DigestFinal_ex(c, md, &len))
        die("sha256 failed");
    EVP_MD_CTX_free(c);
    to_hex(md, 32, out);
}
static void hmac_sha256(const void *key, size_t klen, const void *d, size_t n, unsigned char out[32]) {
    static EVP_MAC *mac = NULL;
    if (!mac) { mac = EVP_MAC_fetch(NULL, "HMAC", NULL); if (!mac) die("HMAC unavailable"); }
    EVP_MAC_CTX *c = EVP_MAC_CTX_new(mac);
    OSSL_PARAM params[2];
    params[0] = OSSL_PARAM_construct_utf8_string(OSSL_MAC_PARAM_DIGEST, (char *)"SHA256", 0);
    params[1] = OSSL_PARAM_construct_end();
    size_t outl = 0;
    if (!c || !EVP_MAC_init(c, key, klen, params) || !EVP_MAC_update(c, d, n) || !EVP_MAC_final(c, out, &outl, 32) || outl != 32)
        die("hmac failed");
    EVP_MAC_CTX_free(c);
}

/* ------------------------------------------------------------------------ */
/* AWS Signature Version 4 and the HTTP transport                            */
/* ------------------------------------------------------------------------ */
typedef struct {
    CURL *curl;
    const char *bucket, *region, *akid, *secret, *token, *proxy;
    char host[600];
    char errbuf[CURL_ERROR_SIZE];
} s3_t;

typedef struct {
    long status;              /* status code of the response being received */
    buf_t errbody;            /* body of a non-200 response (bounded) */
    int fd;                   /* -1, or a file the 200 body is streamed into */
    buf_t *mem;               /* or a buffer it is collected in */
    EVP_MD_CTX *md;           /* optional running SHA-256 of the 200 body */
    int write_err;
    size_t body_len;
} resp_t;

static void resp_reset_sink(resp_t *r) {
    if (r->fd >= 0) { if (ftruncate(r->fd, 0) != 0 || lseek(r->fd, 0, SEEK_SET) < 0) r->write_err = errno; }
    if (r->mem) r->mem->n = 0;
    if (r->md) EVP_DigestInit_ex(r->md, EVP_sha256(), NULL);
    r->errbody.n = 0;
    r->body_len = 0;
}
static size_t hdr_cb(char *b, size_t sz, size_t nm, void *ud) {
    resp_t *r = ud; size_t n = sz * nm;
    if (n >= 5 && memcmp(b, "HTTP/", 5) == 0) {
        const char *sp = memchr(b, ' ', n);
        r->status = sp ? strtol(sp + 1, NULL, 10) : 0;
        resp_reset_sink(r);
    }
    return n;
}
static size_t write_cb(char *b, size_t sz, size_t nm, void *ud) {
    resp_t *r = ud; size_t n = sz * nm;
    if (r->status == 200) {
        if (r->md && !EVP_DigestUpdate(r->md, b, n)) { r->write_err = EIO; return 0; }
        if (r->mem) buf_push(r->mem, b, n);
        if (r->fd >= 0) {
            size_t off = 0;
            while (off < n) {
                ssize_t w = write(r->fd, b + off, n - off);
                if (w < 0) { if (errno == EINTR) continue; r->write_err = errno; return 0; }
                off += (size_t)w;
            }
        }
        r->body_len += n;
    } else if (r->errbody.n < 65536) {
        size_t room = 65536 - r->errbody.n;
        buf_push(&r->errbody, b, n < room ? n : room);
    }
    return n;
}

/* URI-encode as SigV4 wants: unreserved bytes kept, '/' kept only in a path. */
static char *aws_encode(const char *s, bool is_path) {
    buf_t b = {0};
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        unsigned char c = *p;
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~' || (is_path && c == '/'))
            buf_push(&b, &c, 1);
        else {
            char e[4] = { '%', "0123456789ABCDEF"[c >> 4], "0123456789ABCDEF"[c & 15], 0 };
            buf_puts(&b, e);
        }
    }
    if (!b.p) buf_puts(&b, "");
    return (char *)b.p;
}

static bool is_conn_error(CURLcode rc) {
    switch (rc) {
    case CURLE_COULDNT_RESOLVE_PROXY: case CURLE_COULDNT_RESOLVE_HOST: case CURLE_COULDNT_CONNECT:
    case CURLE_PARTIAL_FILE: case CURLE_OPERATION_TIMEDOUT: case CURLE_SSL_CONNECT_ERROR:
    case CURLE_GOT_NOTHING: case CURLE_SEND_ERROR: case CURLE_RECV_ERROR:
        return true;
    default: return false;
    }
}
static double now_s(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec + t.tv_nsec / 1e9; }
static void sleep_random_under(double ceiling) {
    uint32_t r = 0; if (getrandom(&r, sizeof r, 0) != (ssize_t)sizeof r) r = (uint32_t)time(NULL);
    double d = ceiling * ((double)r / 4294967296.0);
    struct timespec t = { (time_t)d, (long)((d - (time_t)d) * 1e9) };
    nanosleep(&t, NULL);
}
/* <Code>…</Code> from an S3 error body, or "". */
static void s3_error_code(const resp_t *r, char *out, size_t outsz) {
    out[0] = 0;
    if (!r->errbody.p) return;
    const char *a = strstr((const char *)r->errbody.p, "<Code>");
    if (!a) return;
    a += 6;
    const char *b = strstr(a, "</Code>");
    if (!b) return;
    size_t n = (size_t)(b - a); if (n >= outsz) n = outsz - 1;
    memcpy(out, a, n); out[n] = 0;
}

/*
 * One signed GET of /<key>?<query>. Returns 0 when an HTTP response was
 * received (r->status says which), -1 when the transport gave up.
 * Retries: dropped connections for two minutes (ceiling 0.5 s doubling to 2),
 * 5xx up to three attempts (ceiling 0.1 s, 0.5 when throttled, doubling to 20).
 */
static int s3_request(s3_t *s, const char *key, int nq, const char **qk, const char **qv, resp_t *r) {
    static const char EMPTY_SHA[] = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    char *enc_path = aws_encode(key, true);
    /* canonical query: encoded pairs, sorted by encoded key */
    char *ek[8], *ev[8];
    if (nq > 8) die("too many query parameters");
    for (int i = 0; i < nq; i++) { ek[i] = aws_encode(qk[i], false); ev[i] = aws_encode(qv[i], false); }
    for (int i = 1; i < nq; i++) for (int j = i; j > 0 && strcmp(ek[j - 1], ek[j]) > 0; j--) {
        char *t = ek[j]; ek[j] = ek[j - 1]; ek[j - 1] = t; t = ev[j]; ev[j] = ev[j - 1]; ev[j - 1] = t;
    }
    buf_t cq = {0};
    for (int i = 0; i < nq; i++) { if (i) buf_puts(&cq, "&"); buf_puts(&cq, ek[i]); buf_puts(&cq, "="); buf_puts(&cq, ev[i]); }
    if (!cq.p) buf_puts(&cq, "");
    buf_t url = {0};
    buf_puts(&url, "https://"); buf_puts(&url, s->host); buf_puts(&url, "/"); buf_puts(&url, enc_path);
    if (nq) { buf_puts(&url, "?"); buf_puts(&url, (char *)cq.p); }

    double first_fail = 0; bool failing = false; double conn_ceiling = 0.5;
    int srv_attempts = 0; double srv_ceiling = 0;
    int result = -1;
    for (;;) {
        r->status = 0; r->write_err = 0; resp_reset_sink(r);
        /* date and signature */
        time_t t = time(NULL); struct tm tm; gmtime_r(&t, &tm);
        char amzdate[32], date[16];
        strftime(amzdate, sizeof amzdate, "%Y%m%dT%H%M%SZ", &tm);
        memcpy(date, amzdate, 8); date[8] = 0;
        buf_t creq = {0};
        buf_puts(&creq, "GET\n/"); buf_puts(&creq, enc_path); buf_puts(&creq, "\n"); buf_puts(&creq, (char *)cq.p); buf_puts(&creq, "\n");
        buf_puts(&creq, "host:"); buf_puts(&creq, s->host); buf_puts(&creq, "\n");
        buf_puts(&creq, "x-amz-content-sha256:"); buf_puts(&creq, EMPTY_SHA); buf_puts(&creq, "\n");
        buf_puts(&creq, "x-amz-date:"); buf_puts(&creq, amzdate); buf_puts(&creq, "\n");
        if (s->token) { buf_puts(&creq, "x-amz-security-token:"); buf_puts(&creq, s->token); buf_puts(&creq, "\n"); }
        buf_puts(&creq, "\n");
        const char *signed_headers = s->token ? "host;x-amz-content-sha256;x-amz-date;x-amz-security-token" : "host;x-amz-content-sha256;x-amz-date";
        buf_puts(&creq, signed_headers); buf_puts(&creq, "\n"); buf_puts(&creq, EMPTY_SHA);
        char creq_hash[65]; sha256_hex(creq.p, creq.n, creq_hash);
        char scope[256]; snprintf(scope, sizeof scope, "%s/%s/s3/aws4_request", date, s->region);
        buf_t sts = {0};
        buf_puts(&sts, "AWS4-HMAC-SHA256\n"); buf_puts(&sts, amzdate); buf_puts(&sts, "\n"); buf_puts(&sts, scope); buf_puts(&sts, "\n"); buf_puts(&sts, creq_hash);
        unsigned char k[32]; char kinit[300]; snprintf(kinit, sizeof kinit, "AWS4%s", s->secret);
        hmac_sha256(kinit, strlen(kinit), date, 8, k);
        hmac_sha256(k, 32, s->region, strlen(s->region), k);
        hmac_sha256(k, 32, "s3", 2, k);
        hmac_sha256(k, 32, "aws4_request", 12, k);
        unsigned char sig[32]; hmac_sha256(k, 32, sts.p, sts.n, sig);
        char sighex[65]; to_hex(sig, 32, sighex);
        char auth[1024];
        snprintf(auth, sizeof auth, "Authorization: AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s", s->akid, scope, signed_headers, sighex);
        if (g_debug) { dbg("canonical request:\n%s", (char *)creq.p); dbg("string to sign:\n%s", (char *)sts.p); }
        buf_free(&creq); buf_free(&sts);

        struct curl_slist *hdrs = NULL;
        char h1[128], h2[64], *h3 = NULL;
        snprintf(h1, sizeof h1, "x-amz-content-sha256: %s", EMPTY_SHA); hdrs = curl_slist_append(hdrs, h1);
        snprintf(h2, sizeof h2, "x-amz-date: %s", amzdate); hdrs = curl_slist_append(hdrs, h2);
        if (s->token) { size_t n = strlen(s->token) + 32; h3 = xmalloc(n); snprintf(h3, n, "x-amz-security-token: %s", s->token); hdrs = curl_slist_append(hdrs, h3); }
        hdrs = curl_slist_append(hdrs, auth);
        hdrs = curl_slist_append(hdrs, "Accept:");           /* nothing unsigned worth sending */
        hdrs = curl_slist_append(hdrs, "Accept-Encoding:");  /* stored bytes, never transcoded */

        CURL *c = s->curl;
        curl_easy_reset(c);
        s->errbuf[0] = 0;
        curl_easy_setopt(c, CURLOPT_URL, (char *)url.p);
        curl_easy_setopt(c, CURLOPT_HTTPGET, 1L);
        curl_easy_setopt(c, CURLOPT_HTTPHEADER, hdrs);
        curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, write_cb);
        curl_easy_setopt(c, CURLOPT_WRITEDATA, r);
        curl_easy_setopt(c, CURLOPT_HEADERFUNCTION, hdr_cb);
        curl_easy_setopt(c, CURLOPT_HEADERDATA, r);
        curl_easy_setopt(c, CURLOPT_ERRORBUFFER, s->errbuf);
        curl_easy_setopt(c, CURLOPT_NOSIGNAL, 1L);
        curl_easy_setopt(c, CURLOPT_FOLLOWLOCATION, 0L);
        curl_easy_setopt(c, CURLOPT_HTTP_CONTENT_DECODING, 0L);
        curl_easy_setopt(c, CURLOPT_CONNECTTIMEOUT, 10L);
        curl_easy_setopt(c, CURLOPT_LOW_SPEED_LIMIT, 1L);
        curl_easy_setopt(c, CURLOPT_LOW_SPEED_TIME, 30L);
        curl_easy_setopt(c, CURLOPT_USERAGENT, "s3cab-restore-cleanroom/0.1");
        if (s->proxy) curl_easy_setopt(c, CURLOPT_PROXY, s->proxy);
        if (g_debug) curl_easy_setopt(c, CURLOPT_VERBOSE, 1L);
        CURLcode rc = curl_easy_perform(c);
        curl_slist_free_all(hdrs); free(h3);

        if (rc != CURLE_OK) {
            if (rc == CURLE_WRITE_ERROR && r->write_err) { fprintf(stderr, "s3cab-restore: local write failed: %s\n", strerror(r->write_err)); break; }
            if (is_conn_error(rc)) {
                double now = now_s();
                if (!failing) { failing = true; first_fail = now; }
                fprintf(stderr, "s3cab-restore: connection problem (%s%s%s), retrying\n", curl_easy_strerror(rc), s->errbuf[0] ? ": " : "", s->errbuf);
                if (now - first_fail > 120.0) { fprintf(stderr, "s3cab-restore: giving up after two minutes\n"); break; }
                sleep_random_under(conn_ceiling); conn_ceiling *= 2; if (conn_ceiling > 2.0) conn_ceiling = 2.0;
                continue;
            }
            fprintf(stderr, "s3cab-restore: request failed: %s%s%s\n", curl_easy_strerror(rc), s->errbuf[0] ? ": " : "", s->errbuf);
            break;
        }
        if (r->status >= 500 && r->status <= 599) {
            char code[64]; s3_error_code(r, code, sizeof code);
            srv_attempts++;
            fprintf(stderr, "s3cab-restore: HTTP %ld %s on %s (attempt %d of 3)\n", r->status, code, key, srv_attempts);
            if (srv_attempts >= 3) { result = 0; break; }
            if (srv_ceiling == 0) srv_ceiling = (r->status == 503 && strcmp(code, "SlowDown") == 0) ? 0.5 : 0.1;
            sleep_random_under(srv_ceiling); srv_ceiling *= 2; if (srv_ceiling > 20.0) srv_ceiling = 20.0;
            continue;
        }
        result = 0;
        break;
    }
    buf_free(&url); buf_free(&cq); free(enc_path);
    for (int i = 0; i < nq; i++) { free(ek[i]); free(ev[i]); }
    return result;
}

/* Fetch a whole key into memory. Returns the HTTP status, or -1. */
static long s3_get_mem(s3_t *s, const char *key, buf_t *out, char errcode[64]) {
    resp_t r = { .fd = -1, .mem = out };
    out->n = 0;
    int rc = s3_request(s, key, 0, NULL, NULL, &r);
    errcode[0] = 0;
    if (rc < 0) { buf_free(&r.errbody); return -1; }
    if (r.status != 200) s3_error_code(&r, errcode, 64);
    buf_free(&r.errbody);
    return r.status;
}

/* Minimal XML helpers for ListObjectsV2 output. */
static char *xml_unescape(const char *s, size_t n) {
    buf_t b = {0};
    for (size_t i = 0; i < n; i++) {
        if (s[i] != '&') { buf_push(&b, s + i, 1); continue; }
        const char *semi = memchr(s + i, ';', n - i);
        if (!semi) { buf_push(&b, s + i, 1); continue; }
        size_t el = (size_t)(semi - (s + i)) - 1; const char *e = s + i + 1;
        uint32_t cp = 0; bool ok = true;
        if (el == 2 && !memcmp(e, "lt", 2)) cp = '<';
        else if (el == 2 && !memcmp(e, "gt", 2)) cp = '>';
        else if (el == 3 && !memcmp(e, "amp", 3)) cp = '&';
        else if (el == 4 && !memcmp(e, "quot", 4)) cp = '"';
        else if (el == 4 && !memcmp(e, "apos", 4)) cp = '\'';
        else if (el > 1 && e[0] == '#') cp = (e[1] == 'x') ? (uint32_t)strtoul(e + 2, NULL, 16) : (uint32_t)strtoul(e + 1, NULL, 10);
        else ok = false;
        if (!ok) { buf_push(&b, s + i, 1); continue; }
        unsigned char u[4]; int ul;
        if (cp < 0x80) { u[0] = cp; ul = 1; }
        else if (cp < 0x800) { u[0] = 0xC0 | (cp >> 6); u[1] = 0x80 | (cp & 63); ul = 2; }
        else if (cp < 0x10000) { u[0] = 0xE0 | (cp >> 12); u[1] = 0x80 | ((cp >> 6) & 63); u[2] = 0x80 | (cp & 63); ul = 3; }
        else { u[0] = 0xF0 | (cp >> 18); u[1] = 0x80 | ((cp >> 12) & 63); u[2] = 0x80 | ((cp >> 6) & 63); u[3] = 0x80 | (cp & 63); ul = 4; }
        buf_push(&b, u, ul);
        i = (size_t)(semi - s);
    }
    if (!b.p) buf_puts(&b, "");
    return (char *)b.p;
}
/* Text of the first <tag>…</tag> at or after *cur within [cur, end); advances *cur past it. */
static char *xml_next(const char **cur, const char *end, const char *tag) {
    char open[64], close[64];
    snprintf(open, sizeof open, "<%s>", tag); snprintf(close, sizeof close, "</%s>", tag);
    const char *a = memmem(*cur, (size_t)(end - *cur), open, strlen(open));
    if (!a) return NULL;
    a += strlen(open);
    const char *b = memmem(a, (size_t)(end - a), close, strlen(close));
    if (!b) return NULL;
    *cur = b + strlen(close);
    return xml_unescape(a, (size_t)(b - a));
}

/* ListObjectsV2 under a prefix; with delimiter "/" only keys directly there. */
static void s3_list(s3_t *s, const char *prefix, bool delimited, strlist_t *keys, strlist_t *prefixes) {
    char *token = NULL;
    do {
        const char *qk[4], *qv[4]; int nq = 0;
        if (token) { qk[nq] = "continuation-token"; qv[nq++] = token; }
        if (delimited) { qk[nq] = "delimiter"; qv[nq++] = "/"; }
        qk[nq] = "list-type"; qv[nq++] = "2";
        qk[nq] = "prefix"; qv[nq++] = prefix;
        buf_t body = {0};
        resp_t r = { .fd = -1, .mem = &body };
        if (s3_request(s, "", nq, qk, qv, &r) < 0) die("listing %s failed", prefix);
        if (r.status != 200) {
            char code[64]; s3_error_code(&r, code, sizeof code);
            die("listing %s: HTTP %ld %s", prefix, r.status, code);
        }
        free(token); token = NULL;
        const char *cur = (const char *)body.p, *end = cur + body.n;
        for (;;) {
            const char *c0 = cur;
            const char *cs = memmem(cur, (size_t)(end - cur), "<Contents>", 10);
            if (!cs) break;
            const char *ce = memmem(cs, (size_t)(end - cs), "</Contents>", 11);
            if (!ce) break;
            const char *k = cs;
            char *key = xml_next(&k, ce, "Key");
            if (key) sl_push(keys, key);
            cur = ce + 11;
            (void)c0;
        }
        if (prefixes) {
            cur = (const char *)body.p;
            for (;;) {
                const char *cs = memmem(cur, (size_t)(end - cur), "<CommonPrefixes>", 16);
                if (!cs) break;
                const char *ce = memmem(cs, (size_t)(end - cs), "</CommonPrefixes>", 17);
                if (!ce) break;
                const char *k = cs; char *p = xml_next(&k, ce, "Prefix");
                if (p) sl_push(prefixes, p);
                cur = ce + 17;
            }
        }
        cur = (const char *)body.p;
        char *trunc = xml_next(&cur, end, "IsTruncated");
        if (trunc && strcmp(trunc, "true") == 0) {
            cur = (const char *)body.p;
            token = xml_next(&cur, end, "NextContinuationToken");
            if (!token) die("listing %s: truncated without a continuation token", prefix);
        }
        free(trunc);
        buf_free(&body); buf_free(&r.errbody);
    } while (token);
}

/* ------------------------------------------------------------------------ */
/* gzip: every stream in turn; bytes after the last stream are damage unless */
/* the first of them is a zero byte (then it and everything after is ignored)*/
/* ------------------------------------------------------------------------ */
static int gunzip_all(const unsigned char *in, size_t n, buf_t *out, char *why, size_t whysz) {
    out->n = 0;
    if (n < 2 || in[0] != 0x1f || in[1] != 0x8b) { snprintf(why, whysz, "not gzip (no 1f 8b magic)"); return -1; }
    z_stream z; memset(&z, 0, sizeof z);
    if (inflateInit2(&z, 15 + 16) != Z_OK) die("inflateInit2 failed");
    size_t pos = 0;
    unsigned char tmp[65536];
    for (;;) {
        /* one stream */
        z.next_in = (unsigned char *)in + pos; z.avail_in = (uInt)(n - pos);
        int ret;
        do {
            z.next_out = tmp; z.avail_out = sizeof tmp;
            ret = inflate(&z, Z_NO_FLUSH);
            if (ret != Z_OK && ret != Z_STREAM_END && ret != Z_BUF_ERROR) {
                snprintf(why, whysz, "gzip error: %s", z.msg ? z.msg : "data error");
                inflateEnd(&z); return -1;
            }
            buf_push(out, tmp, sizeof tmp - z.avail_out);
            if (ret == Z_BUF_ERROR && z.avail_in == 0) { snprintf(why, whysz, "gzip stream cut short"); inflateEnd(&z); return -1; }
        } while (ret != Z_STREAM_END);
        pos = n - z.avail_in;
        if (pos >= n) break;
        if (in[pos] == 0) { dbg("zero byte after gzip stream at offset %zu; ignoring the rest", pos); break; }
        if (n - pos >= 2 && in[pos] == 0x1f && in[pos + 1] == 0x8b) { inflateReset(&z); continue; }
        snprintf(why, whysz, "%zu byte(s) after the last gzip stream that are not another stream", n - pos);
        inflateEnd(&z); return -1;
    }
    inflateEnd(&z);
    if (!out->p) buf_puts(out, "");
    return 0;
}

/* ------------------------------------------------------------------------ */
/* UTF-8, the trim set, lines and fields                                     */
/* ------------------------------------------------------------------------ */
/* Strict decode of one code point; returns its length or 0 if malformed. */
static int utf8_decode(const unsigned char *s, size_t n, uint32_t *cp) {
    if (n == 0) return 0;
    unsigned char c = s[0];
    if (c < 0x80) { *cp = c; return 1; }
    int len; uint32_t v; unsigned char lo = 0x80, hi = 0xBF;
    if (c >= 0xC2 && c <= 0xDF) { len = 2; v = c & 0x1F; }
    else if (c >= 0xE0 && c <= 0xEF) { len = 3; v = c & 0x0F; if (c == 0xE0) lo = 0xA0; if (c == 0xED) hi = 0x9F; }
    else if (c >= 0xF0 && c <= 0xF4) { len = 4; v = c & 0x07; if (c == 0xF0) lo = 0x90; if (c == 0xF4) hi = 0x8F; }
    else return 0;
    if ((size_t)len > n) return 0;
    if (s[1] < lo || s[1] > hi) return 0;
    v = (v << 6) | (s[1] & 0x3F);
    for (int i = 2; i < len; i++) { if ((s[i] & 0xC0) != 0x80) return 0; v = (v << 6) | (s[i] & 0x3F); }
    *cp = v; return len;
}
static int utf8_encode(uint32_t cp, unsigned char *u) {
    if (cp < 0x80) { u[0] = cp; return 1; }
    if (cp < 0x800) { u[0] = 0xC0 | (cp >> 6); u[1] = 0x80 | (cp & 63); return 2; }
    if (cp < 0x10000) { u[0] = 0xE0 | (cp >> 12); u[1] = 0x80 | ((cp >> 6) & 63); u[2] = 0x80 | (cp & 63); return 3; }
    u[0] = 0xF0 | (cp >> 18); u[1] = 0x80 | ((cp >> 12) & 63); u[2] = 0x80 | ((cp >> 6) & 63); u[3] = 0x80 | (cp & 63); return 4;
}
/* -1 when valid, else the offset of the first bad byte. */
static long utf8_check(const unsigned char *s, size_t n) {
    size_t i = 0; uint32_t cp;
    while (i < n) { int l = utf8_decode(s + i, n - i, &cp); if (!l) return (long)i; i += l; }
    return -1;
}
/* JavaScript's trim() set, exactly as the spec lists it. */
static bool is_trim_cp(uint32_t c) {
    return (c >= 0x09 && c <= 0x0D) || c == 0x20 || c == 0xA0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200A) ||
           c == 0x202F || c == 0x205F || c == 0x3000 || c == 0x2028 || c == 0x2029 || c == 0xFEFF;
}
static void trim_span(const unsigned char *s, size_t n, const unsigned char **ts, size_t *tn) {
    size_t a = 0, b = n; uint32_t cp;
    while (a < b) { int l = utf8_decode(s + a, b - a, &cp); if (!l || !is_trim_cp(cp)) break; a += l; }
    while (b > a) {
        size_t st = b - 1; int back = 0;
        while (st > a && (s[st] & 0xC0) == 0x80 && back < 3) { st--; back++; }
        int l = utf8_decode(s + st, b - st, &cp);
        if ((size_t)l != b - st || !is_trim_cp(cp)) break;
        b = st;
    }
    *ts = s + a; *tn = b - a;
}
static bool is_blank_line(const unsigned char *s, size_t n) { const unsigned char *t; size_t tn; trim_span(s, n, &t, &tn); return tn == 0; }

typedef struct { const unsigned char *f[5]; size_t len[5]; int nfields; } fields_t;
/* Split at the first four tabs; a fifth tab is part of the last field. */
static void split_fields(const unsigned char *line, size_t n, fields_t *F) {
    size_t pos = 0; int i = 0;
    for (; i < 5; i++) {
        F->f[i] = line + pos;
        if (i == 4) { F->len[i] = n - pos; i++; break; }
        const unsigned char *t = memchr(line + pos, '\t', n - pos);
        if (!t) { F->len[i] = n - pos; i++; break; }
        F->len[i] = (size_t)(t - (line + pos)); pos = (size_t)(t - line) + 1;
    }
    F->nfields = i;
    for (int j = F->nfields; j < 5; j++) { F->f[j] = line + n; F->len[j] = 0; }
}
static char *field_trimmed(const fields_t *F, int i) { const unsigned char *t; size_t tn; trim_span(F->f[i], F->len[i], &t, &tn); return xstrndup(t, tn); }
static bool eq_trimmed(const fields_t *F, int i, const char *want) { const unsigned char *t; size_t tn; trim_span(F->f[i], F->len[i], &t, &tn); return tn == strlen(want) && memcmp(t, want, tn) == 0; }

/* ------------------------------------------------------------------------ */
/* Instants and the row grammar                                              */
/* ------------------------------------------------------------------------ */
static bool all_digits(const char *s, size_t n) { if (n == 0) return false; for (size_t i = 0; i < n; i++) if (s[i] < '0' || s[i] > '9') return false; return true; }
static bool is_hash(const char *s) { if (strlen(s) != 64) return false; for (int i = 0; i < 64; i++) if (!((s[i] >= '0' && s[i] <= '9') || (s[i] >= 'a' && s[i] <= 'f'))) return false; return true; }
static int64_t days_from_civil(int64_t y, unsigned m, unsigned d) {
    y -= m <= 2;
    int64_t era = (y >= 0 ? y : y - 399) / 400;
    unsigned yoe = (unsigned)(y - era * 400);
    unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + (int64_t)doe - 719468;
}
/* Exactly YYYY-MM-DDTHH:MM:SS.sssZ and a real instant. */
static bool parse_instant(const char *s, int64_t *secs, int *ms) {
    if (strlen(s) != 24) return false;
    static const char shape[] = "dddd-dd-ddTdd:dd:dd.dddZ";
    for (int i = 0; i < 24; i++) { if (shape[i] == 'd') { if (s[i] < '0' || s[i] > '9') return false; } else if (s[i] != shape[i]) return false; }
    int y = atoi(xstrndup(s, 4)), mo = (s[5] - '0') * 10 + s[6] - '0', d = (s[8] - '0') * 10 + s[9] - '0';
    int h = (s[11] - '0') * 10 + s[12] - '0', mi = (s[14] - '0') * 10 + s[15] - '0', se = (s[17] - '0') * 10 + s[18] - '0';
    int f = (s[20] - '0') * 100 + (s[21] - '0') * 10 + s[22] - '0';
    if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || se > 59) return false;
    static const int dim[] = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
    int md = dim[mo - 1];
    if (mo == 2 && ((y % 4 == 0 && y % 100 != 0) || y % 400 == 0)) md = 29;
    if (d > md) return false;
    if (secs) *secs = days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60 + se;
    if (ms) *ms = f;
    return true;
}

enum { KIND_POSIX = 0, KIND_DRIVE = 1, KIND_UNC = 2 };
static bool is_sep_win(char c) { return c == '\\' || c == '/'; }
/* A Windows path is told by its first characters alone; everything else is POSIX. Returns -1 if not absolute. */
static int path_kind(const char *p) {
    size_t n = strlen(p);
    if (n >= 3 && ((p[0] >= 'A' && p[0] <= 'Z') || (p[0] >= 'a' && p[0] <= 'z')) && p[1] == ':' && is_sep_win(p[2])) return KIND_DRIVE;
    if (n >= 2 && is_sep_win(p[0]) && is_sep_win(p[1])) return KIND_UNC;
    if (n >= 1 && p[0] == '/') return KIND_POSIX;
    return -1;
}
/* Split the part past the root into segments (possibly empty strings). */
static void split_segments(const char *p, int kind, strlist_t *segs) {
    const char *s = p + (kind == KIND_DRIVE ? 3 : kind == KIND_UNC ? 2 : 1);
    if (!*s) return;
    const char *start = s;
    for (const char *c = s;; c++) {
        bool sep = kind == KIND_POSIX ? (*c == '/') : is_sep_win(*c);
        if (*c == 0 || sep) { sl_push(segs, xstrndup(start, (size_t)(c - start))); start = c + 1; if (*c == 0) break; }
    }
}

/* Full default lowercase mapping, as JavaScript's toLowerCase(): towlower per
 * code point in a UTF-8 locale, plus the two full-mapping cases that differ
 * from the simple one (U+0130, and Final_Sigma for U+03A3). Case-ignorable
 * is approximated by the common ranges. */
static bool is_cased(uint32_t c) { return iswupper((wint_t)c) || iswlower((wint_t)c) || towlower((wint_t)c) != (wint_t)c || towupper((wint_t)c) != (wint_t)c; }
static bool is_case_ignorable(uint32_t c) {
    return c == 0x27 || c == 0x2E || c == 0x3A || c == 0x5E || c == 0x60 || c == 0xA8 || c == 0xAD || c == 0xAF || c == 0xB4 || c == 0xB7 || c == 0xB8 ||
           c == 0x2018 || c == 0x2019 || c == 0x2024 || c == 0x2027 || c == 0xFEFF ||
           (c >= 0x2B0 && c <= 0x2FF) || (c >= 0x300 && c <= 0x36F) || (c >= 0x483 && c <= 0x489) || (c >= 0x591 && c <= 0x5BD) ||
           (c >= 0x610 && c <= 0x61A) || (c >= 0x64B && c <= 0x65F) || (c >= 0x1D2C && c <= 0x1D6A) || (c >= 0x1DC0 && c <= 0x1DFF) ||
           (c >= 0x200B && c <= 0x200F) || (c >= 0x202A && c <= 0x202E) || (c >= 0x2060 && c <= 0x2064) || (c >= 0x20D0 && c <= 0x20F0) ||
           (c >= 0x3099 && c <= 0x309A) || (c >= 0xFE00 && c <= 0xFE0F) || (c >= 0xFE20 && c <= 0xFE2F) || (c >= 0xE0100 && c <= 0xE01EF);
}
static char *full_lower(const char *s) {
    size_t n = strlen(s), cnt = 0, i = 0; uint32_t *cps = xmalloc(sizeof(uint32_t) * (n + 1)); uint32_t cp;
    while (i < n) { int l = utf8_decode((const unsigned char *)s + i, n - i, &cp); if (!l) { cp = 0xFFFD; l = 1; } cps[cnt++] = cp; i += l; }
    buf_t b = {0}; unsigned char u[4];
    for (size_t k = 0; k < cnt; k++) {
        uint32_t c = cps[k];
        if (c == 0x130) { buf_puts(&b, "i"); buf_push(&b, u, utf8_encode(0x307, u)); continue; }
        if (c == 0x3A3) {
            long j = (long)k - 1; while (j >= 0 && is_case_ignorable(cps[j])) j--;
            bool before = j >= 0 && is_cased(cps[j]);
            size_t m = k + 1; while (m < cnt && is_case_ignorable(cps[m])) m++;
            bool after = m < cnt && is_cased(cps[m]);
            buf_push(&b, u, utf8_encode(before && !after ? 0x3C2 : 0x3C3, u)); continue;
        }
        buf_push(&b, u, utf8_encode((uint32_t)towlower((wint_t)c), u));
    }
    free(cps);
    if (!b.p) buf_puts(&b, "");
    return (char *)b.p;
}
static bool seg_eq(const char *a, const char *b, int kind) {
    if (kind == KIND_POSIX) return strcmp(a, b) == 0;
    char *la = full_lower(a), *lb = full_lower(b); bool r = strcmp(la, lb) == 0; free(la); free(lb); return r;
}

/* ------------------------------------------------------------------------ */
/* Snapshot model                                                            */
/* ------------------------------------------------------------------------ */
typedef struct {
    char *value;          /* as written */
    int kind;             /* -1 when not absolute (matches nothing) */
    bool usable;          /* absolute and no empty segment */
    strlist_t segs;
    char *name;           /* folder name under <output>, or NULL for "/" */
    int lineno;
    int first;            /* index of the first equal DIR (itself if unique) */
    bool reached;
} dir_t;

typedef struct {
    int lineno;
    char *hash, *size, *mtime;
    char *path;           /* NUL-terminated copy; NUL inside is checked before */
    size_t pathlen;
    const char *refuse;   /* reason, or NULL when the row restores */
    int kind;
    strlist_t segs;
    int dir;              /* matched DIR or -1 */
    char *dest;           /* destination relative to <output> */
    int64_t secs; int ms;
} row_t;

typedef struct {
    const char *refuse_whole;
    char whole_detail[256];
    dir_t *dirs; int ndirs, dcap;
    row_t *rows; int nrows, rcap;
    int lines;
} snap_t;

static const char HEADING[5][64] = { "@S3CAB", "FORMAT", "size", "time", "https://s3cab.plantegral.com/guide/format" };

static bool is_heading(const unsigned char *line, size_t n) {
    fields_t F; split_fields(line, n, &F);
    for (int i = 0; i < 4; i++) if (!eq_trimmed(&F, i, HEADING[i])) return false;
    return F.len[4] == strlen(HEADING[4]) && memcmp(F.f[4], HEADING[4], F.len[4]) == 0;
}

static void add_dir(snap_t *S, const fields_t *F, int lineno) {
    if (S->ndirs == S->dcap) { S->dcap = S->dcap ? S->dcap * 2 : 8; S->dirs = xrealloc(S->dirs, sizeof(dir_t) * S->dcap); }
    dir_t *d = &S->dirs[S->ndirs]; memset(d, 0, sizeof *d);
    d->lineno = lineno;
    /* value verbatim; a NUL inside would end it early, so treat one as unusable */
    d->value = xstrndup(F->f[4], F->len[4]);
    d->usable = memchr(F->f[4], 0, F->len[4]) == NULL;
    d->kind = path_kind(d->value);
    if (d->kind < 0) d->usable = false;
    if (d->usable) {
        /* ignore the separators it ends with */
        char *v = xstrdup(d->value); size_t n = strlen(v);
        size_t rootlen = d->kind == KIND_DRIVE ? 3 : d->kind == KIND_UNC ? 2 : 1;
        while (n > rootlen && (d->kind == KIND_POSIX ? v[n - 1] == '/' : is_sep_win(v[n - 1]))) v[--n] = 0;
        split_segments(v, d->kind, &d->segs);
        for (int i = 0; i < d->segs.n; i++) if (d->segs.v[i][0] == 0) d->usable = false;
        if (d->kind == KIND_UNC && d->segs.n == 0) d->usable = false;
        if (d->usable) {
            if (d->segs.n > 0) d->name = xstrdup(d->segs.v[d->segs.n - 1]);
            else if (d->kind == KIND_DRIVE) d->name = xstrndup(v, 1);
            else d->name = NULL; /* POSIX root: no folder of its own */
        }
        free(v);
    }
    d->first = S->ndirs;
    if (d->usable) for (int i = 0; i < S->ndirs; i++) {
        dir_t *e = &S->dirs[i];
        if (!e->usable || e->kind != d->kind || e->segs.n != d->segs.n) continue;
        if (d->kind == KIND_DRIVE && towlower((unsigned char)e->value[0]) != towlower((unsigned char)d->value[0])) continue;
        bool same = true;
        for (int k = 0; k < d->segs.n && same; k++) same = seg_eq(e->segs.v[k], d->segs.v[k], d->kind);
        if (same) { d->first = e->first; break; }
    }
    S->ndirs++;
}

static row_t *add_row(snap_t *S) {
    if (S->nrows == S->rcap) { S->rcap = S->rcap ? S->rcap * 2 : 64; S->rows = xrealloc(S->rows, sizeof(row_t) * S->rcap); }
    row_t *r = &S->rows[S->nrows++]; memset(r, 0, sizeof *r); r->dir = -1; return r;
}

static void refuse_whole(snap_t *S, const char *why, const char *fmt, ...) {
    if (S->refuse_whole) return;
    S->refuse_whole = why;
    va_list ap; va_start(ap, fmt); vsnprintf(S->whole_detail, sizeof S->whole_detail, fmt, ap); va_end(ap);
}

/*
 * Read a snapshot's decompressed text into rows, applying the whole-file
 * rules: strict UTF-8 (a leading BOM forgiven), LF-split, heading row first,
 * `.` last, nothing but blank lines after it, unknown non-@/# types refused.
 */
static void parse_snapshot(const unsigned char *text, size_t n, snap_t *S) {
    memset(S, 0, sizeof *S);
    if (n >= 3 && text[0] == 0xEF && text[1] == 0xBB && text[2] == 0xBF) { text += 3; n -= 3; }
    long bad = utf8_check(text, n);
    if (bad >= 0) { refuse_whole(S, "not UTF-8", "byte 0x%02x at offset %ld", text[bad], bad); return; }
    size_t pos = 0; int lineno = 0; bool seen_dot = false;
    bool first = true;
    while (pos < n) {
        const unsigned char *nl = memchr(text + pos, '\n', n - pos);
        size_t len = nl ? (size_t)(nl - (text + pos)) : n - pos;
        const unsigned char *line = text + pos;
        bool terminated = nl != NULL;
        lineno++;
        pos += len + (terminated ? 1 : 0);
        if (!terminated) {
            /* unterminated trailing bytes: a blank is no row; anything else is a cut */
            if (is_blank_line(line, len)) break;
            if (first) refuse_whole(S, "no heading row", "first line is not the heading row");
            else if (len == 1 && line[0] == '.') refuse_whole(S, "cut short", "the final `.` has no LF, so the file was cut there");
            else refuse_whole(S, "cut short", "line %d is not terminated by LF", lineno);
            return;
        }
        if (first) {
            first = false;
            if (!is_heading(line, len)) { refuse_whole(S, "no heading row", "line 1 is not the heading row"); return; }
            continue;
        }
        if (is_blank_line(line, len)) continue;
        if (seen_dot) { refuse_whole(S, "rows after the `.`", "line %d follows the `.`", lineno); return; }
        if (len == 1 && line[0] == '.') { seen_dot = true; continue; }
        fields_t F; split_fields(line, len, &F);
        const unsigned char *t; size_t tn; trim_span(F.f[0], F.len[0], &t, &tn);
        if (tn == 1 && t[0] == '-') {
            row_t *r = add_row(S);
            r->lineno = lineno;
            r->hash = field_trimmed(&F, 1); r->size = field_trimmed(&F, 2); r->mtime = field_trimmed(&F, 3);
            r->pathlen = F.len[4]; r->path = xstrndup(F.f[4], F.len[4]);
            if (F.nfields < 5) r->refuse = "malformed row: fewer than five fields";
            continue;
        }
        if (tn >= 1 && (t[0] == '@' || t[0] == '#')) {
            if (tn == 4 && memcmp(t, "@SET", 4) == 0 && eq_trimmed(&F, 1, "DIR")) {
                if (F.nfields == 5) add_dir(S, &F, lineno);
                else dbg("line %d: @SET DIR with fewer than five fields has no value; ignored", lineno);
            }
            continue;
        }
        { char ty[64]; size_t m = tn < 63 ? tn : 63; memcpy(ty, t, m); ty[m] = 0;
          refuse_whole(S, "unknown row type", "line %d has type '%s', which starts with neither @ nor #", lineno, ty); return; }
    }
    S->lines = lineno;
    if (!seen_dot) refuse_whole(S, "no `.` last", "the file does not end with the `.` line, so it was cut short");
}

/* Match a path (kind + segments) against the DIRs: longest wins, first of equals. */
static int match_dir(const snap_t *S, int kind, const strlist_t *segs, const char *path) {
    int best = -1, bestn = -1;
    for (int i = 0; i < S->ndirs; i++) {
        const dir_t *d = &S->dirs[i];
        if (!d->usable || d->kind != kind || d->segs.n > segs->n) continue;
        if (kind == KIND_DRIVE && towlower((unsigned char)d->value[0]) != towlower((unsigned char)path[0])) continue;
        bool ok = true;
        for (int k = 0; k < d->segs.n && ok; k++) ok = seg_eq(d->segs.v[k], segs->v[k], kind);
        if (ok && d->segs.n > bestn) { best = d->first; bestn = d->segs.n; }
    }
    return best;
}

/* B runs through A as a folder: B == A + one separator of B's kind + more (prefix compared exactly). */
static bool runs_through(const row_t *a, const row_t *b) {
    size_t la = a->pathlen;
    if (b->pathlen <= la + 1 || memcmp(a->path, b->path, la) != 0) return false;
    char c = b->path[la];
    return b->kind == KIND_POSIX ? c == '/' : is_sep_win(c);
}

static void validate_rows(snap_t *S) {
    for (int i = 0; i < S->nrows; i++) {
        row_t *r = &S->rows[i];
        if (r->refuse) continue;
        if (!is_hash(r->hash)) { r->refuse = "malformed row: hash is not 64 lowercase hex characters"; continue; }
        if (!all_digits(r->size, strlen(r->size))) { r->refuse = "malformed row: size is not decimal digits"; continue; }
        if (!parse_instant(r->mtime, &r->secs, &r->ms)) { r->refuse = "malformed row: modification time is not a real instant in the 24-character form"; continue; }
        if (memchr(r->path, 0, r->pathlen)) { r->refuse = "path holds a NUL"; continue; }
        if (strchr(r->path, '\t')) { r->refuse = "path holds a tab"; continue; }
        if (strchr(r->path, '\r')) { r->refuse = "path holds a carriage return"; continue; }
        r->kind = path_kind(r->path);
        if (r->kind < 0) { r->refuse = "path is not absolute"; continue; }
        split_segments(r->path, r->kind, &r->segs);
        bool segok = r->segs.n > 0;
        for (int k = 0; k < r->segs.n && segok; k++) {
            const char *s = r->segs.v[k];
            if (s[0] == 0) { r->refuse = "path has an empty segment (doubled or trailing separator)"; segok = false; }
            else if (strcmp(s, ".") == 0 || strcmp(s, "..") == 0) { r->refuse = "path has a `.` or `..` segment"; segok = false; }
        }
        if (!segok) { if (!r->refuse) r->refuse = "path has no segment past its root"; continue; }
        r->dir = match_dir(S, r->kind, &r->segs, r->path);
        if (r->dir < 0) { r->refuse = "path is under no @SET DIR"; continue; }
        const dir_t *d = &S->dirs[r->dir];
        if (d->segs.n == r->segs.n) { r->refuse = "path is a @SET DIR itself, not a file inside one"; continue; }
        buf_t dest = {0};
        if (d->name) { buf_puts(&dest, d->name); }
        for (int k = d->segs.n; k < r->segs.n; k++) { if (dest.n) buf_puts(&dest, "/"); buf_puts(&dest, r->segs.v[k]); }
        r->dest = (char *)dest.p;
    }
    /* one path in two rows: both refused, malformed rows included */
    for (int i = 0; i < S->nrows; i++) for (int j = i + 1; j < S->nrows; j++) {
        row_t *a = &S->rows[i], *b = &S->rows[j];
        if (a->pathlen == b->pathlen && memcmp(a->path, b->path, a->pathlen) == 0) {
            if (!a->refuse) a->refuse = "path appears in more than one file row";
            if (!b->refuse) b->refuse = "path appears in more than one file row";
        }
    }
    /* one path running through another's, checked last among the survivors */
    bool *thru = xmalloc(sizeof(bool) * (S->nrows + 1)); memset(thru, 0, S->nrows + 1);
    for (int i = 0; i < S->nrows; i++) for (int j = 0; j < S->nrows; j++) {
        if (i == j || S->rows[i].refuse || S->rows[j].refuse) continue;
        if (runs_through(&S->rows[i], &S->rows[j])) { thru[i] = thru[j] = true; }
    }
    for (int i = 0; i < S->nrows; i++) if (thru[i]) S->rows[i].refuse = "path runs through another file row's path as a folder, or is run through";
    free(thru);
    for (int i = 0; i < S->nrows; i++) if (!S->rows[i].refuse) S->dirs[S->rows[i].dir].reached = true;
}

/* ------------------------------------------------------------------------ */
/* Deletion records: every objects.deleted-<n>.tsv read as one set            */
/* ------------------------------------------------------------------------ */
typedef struct { char hash[65]; char date[25]; } delrow_t;
typedef struct { delrow_t *v; int n, cap; bool loaded; int files, invalid_files; } delset_t;

static void delset_add(delset_t *D, const char *hash, const char *date) {
    for (int i = 0; i < D->n; i++) if (strcmp(D->v[i].hash, hash) == 0) { if (strcmp(date, D->v[i].date) > 0) strcpy(D->v[i].date, date); return; }
    if (D->n == D->cap) { D->cap = D->cap ? D->cap * 2 : 64; D->v = xrealloc(D->v, sizeof(delrow_t) * D->cap); }
    strcpy(D->v[D->n].hash, hash); strcpy(D->v[D->n].date, date); D->n++;
}
static const char *delset_find(const delset_t *D, const char *hash) {
    for (int i = 0; i < D->n; i++) if (strcmp(D->v[i].hash, hash) == 0) return D->v[i].date;
    return NULL;
}
static bool is_record_key(const char *k) {
    static const char pre[] = "objects.deleted-";
    if (strncmp(k, pre, sizeof pre - 1) != 0) return false;
    const char *d = k + sizeof pre - 1; const char *dot = strstr(d, ".tsv");
    if (!dot || strcmp(dot, ".tsv") != 0 || dot == d || d[0] == '0') return false;
    return all_digits(d, (size_t)(dot - d));
}
/* Well-formed #deleted rows count even in an invalid record. */
static void parse_record(const unsigned char *text, size_t n, const char *key, delset_t *D) {
    if (n >= 3 && text[0] == 0xEF && text[1] == 0xBB && text[2] == 0xBF) { text += 3; n -= 3; }
    bool valid = true; size_t pos = 0; int lineno = 0; bool seen_dot = false, first = true;
    if (utf8_check(text, n) >= 0) valid = false;
    while (pos < n) {
        const unsigned char *nl = memchr(text + pos, '\n', n - pos);
        size_t len = nl ? (size_t)(nl - (text + pos)) : n - pos;
        const unsigned char *line = text + pos; lineno++;
        pos += len + (nl ? 1 : 0);
        if (!nl) { if (!is_blank_line(line, len)) valid = false; break; }
        if (first) { first = false; if (!is_heading(line, len)) valid = false; else continue; }
        if (is_blank_line(line, len)) continue;
        if (seen_dot) { valid = false; continue; }
        if (len == 1 && line[0] == '.') { seen_dot = true; continue; }
        if (utf8_check(line, len) >= 0) { valid = false; continue; }
        fields_t F; split_fields(line, len, &F);
        const unsigned char *t; size_t tn; trim_span(F.f[0], F.len[0], &t, &tn);
        if (tn == 8 && memcmp(t, "#deleted", 8) == 0) {
            char *h = field_trimmed(&F, 1), *sz = field_trimmed(&F, 2), *when = field_trimmed(&F, 3);
            if (is_hash(h) && all_digits(sz, strlen(sz)) && parse_instant(when, NULL, NULL)) delset_add(D, h, when);
            else { valid = false; dbg("%s line %d: malformed #deleted row, refused", key, lineno); }
            free(h); free(sz); free(when);
            continue;
        }
        if (tn >= 1 && (t[0] == '@' || t[0] == '#')) continue;
        valid = false; /* a `-` row, or any other type, makes the record invalid; its good rows still count */
    }
    if (!seen_dot) valid = false;
    D->files++;
    if (!valid) { D->invalid_files++; fprintf(stderr, "s3cab-restore: note: deletion record %s is not valid; its well-formed rows still count\n", key); }
}
static void load_records(s3_t *s, delset_t *D) {
    if (D->loaded) return;
    D->loaded = true;
    strlist_t keys = {0};
    s3_list(s, "objects.deleted-", true, &keys, NULL);
    for (int i = 0; i < keys.n; i++) {
        if (!is_record_key(keys.v[i])) { dbg("ignoring root key %s (not a deletion record)", keys.v[i]); continue; }
        buf_t body = {0}; char code[64];
        long st = s3_get_mem(s, keys.v[i], &body, code);
        if (st < 0) die("fetching %s failed", keys.v[i]);
        if (st != 200) {
            /* compacted away between the list and the fetch: a missed row is the safe direction */
            fprintf(stderr, "s3cab-restore: note: %s: HTTP %ld %s; skipped\n", keys.v[i], st, code);
            continue;
        }
        if (getenv("S3CAB_RESTORE_DUMP_RECORDS") && *getenv("S3CAB_RESTORE_DUMP_RECORDS")) {
            char p[1200]; snprintf(p, sizeof p, "%s/%s", getenv("S3CAB_RESTORE_DUMP_RECORDS"), keys.v[i]);
            FILE *f = fopen(p, "wb"); if (f) { fwrite(body.p, 1, body.n, f); fclose(f); }
        }
        parse_record(body.p, body.n, keys.v[i], D);
        buf_free(&body);
    }
    dbg("deletion records: %d file(s), %d invalid, %d hash(es)", D->files, D->invalid_files, D->n);
}

/* ------------------------------------------------------------------------ */
/* Writing the restored files                                                */
/* ------------------------------------------------------------------------ */
typedef struct { dev_t dev; ino_t ino; } ident_t;
typedef struct { ident_t *v; int n, cap; } identset_t;
static bool ident_has(const identset_t *S, dev_t dev, ino_t ino) { for (int i = 0; i < S->n; i++) if (S->v[i].dev == dev && S->v[i].ino == ino) return true; return false; }
static void ident_add(identset_t *S, dev_t dev, ino_t ino) {
    if (ident_has(S, dev, ino)) return;
    if (S->n == S->cap) { S->cap = S->cap ? S->cap * 2 : 64; S->v = xrealloc(S->v, sizeof(ident_t) * S->cap); }
    S->v[S->n].dev = dev; S->v[S->n].ino = ino; S->n++;
}

typedef struct {
    const char *outdir;
    int tmp_dirfd;            /* nearest existing ancestor of outdir at start */
    bool tmpfile_ok;
    identset_t written, made;
    int restored, skipped, deleted, missing, corrupt, refused, collisions, inway, failed, timebad, rounded;
} fs_t;

static int open_tmp(fs_t *fs) {
    if (fs->tmpfile_ok && !getenv("S3CAB_RESTORE_NO_TMPFILE")) {   /* the env knob forces the memfd + copy path, for testing */
        int fd = openat(fs->tmp_dirfd, ".", O_TMPFILE | O_RDWR | O_CLOEXEC, 0644);
        if (fd >= 0) return fd;
        if (errno != EOPNOTSUPP && errno != EISDIR && errno != EINVAL) return -1;
        fs->tmpfile_ok = false;
        dbg("O_TMPFILE unsupported here (%s); using memfd and a copy", strerror(errno));
    }
    return memfd_create("s3cab-restore", MFD_CLOEXEC);
}

/* Find the nearest existing ancestor of outdir (outdir itself if it exists). */
static int nearest_existing_dir(const char *outdir) {
    char *p = xstrdup(outdir);
    for (;;) {
        int fd = open(p[0] ? p : ".", O_DIRECTORY | O_PATH | O_CLOEXEC);
        if (fd >= 0) { free(p); return fd; }
        if (errno != ENOENT) die("%s: %s", p, strerror(errno));
        char *sl = strrchr(p, '/');
        if (!sl) { free(p); return open(".", O_DIRECTORY | O_PATH | O_CLOEXEC); }
        if (sl == p) { free(p); return open("/", O_DIRECTORY | O_PATH | O_CLOEXEC); }
        *sl = 0;
    }
}

/* mkdir -p for the output directory itself (the user named it, so links in it are followed). */
static int open_outdir(fs_t *fs, strlist_t *created) {
    int fd = open(fs->outdir, O_DIRECTORY | O_PATH | O_CLOEXEC);
    if (fd >= 0) return fd;
    if (errno != ENOENT) return -1;
    char *p = xstrdup(fs->outdir); size_t n = strlen(p);
    for (size_t i = 1; i <= n; i++) {
        if (p[i] == '/' || p[i] == 0) {
            char save = p[i]; p[i] = 0;
            struct stat st;
            if (stat(p, &st) != 0) {
                if (errno != ENOENT) { free(p); return -1; }
                if (mkdir(p, 0755) != 0 && errno != EEXIST) { free(p); return -1; }
                sl_push(created, xstrdup(p));
                if (stat(p, &st) == 0) ident_add(&fs->made, st.st_dev, st.st_ino);
            }
            p[i] = save;
        }
    }
    free(p);
    return open(fs->outdir, O_DIRECTORY | O_PATH | O_CLOEXEC);
}

static void rollback_dirs(strlist_t *created) {
    for (int i = created->n - 1; i >= 0; i--) { rmdir(created->v[i]); free(created->v[i]); }
    created->n = 0;
}

static int copy_fd(int from, int to) {
    char b[65536]; off_t off = 0;
    for (;;) {
        ssize_t r = pread(from, b, sizeof b, off);
        if (r < 0) { if (errno == EINTR) continue; return -1; }
        if (r == 0) return 0;
        ssize_t w = 0; while (w < r) { ssize_t k = write(to, b + w, (size_t)(r - w)); if (k < 0) { if (errno == EINTR) continue; return -1; } w += k; }
        off += r;
    }
}

enum { PL_RESTORED = 0, PL_SKIPPED, PL_COLLISION, PL_INWAY, PL_FAILED };
/*
 * Put the downloaded, verified bytes in tmpfd at <output>/<dest>, making
 * folders only now, never following a link below <output>, never replacing
 * what is there, and setting both times to the stored instant.
 */
static int place_file(fs_t *fs, const row_t *r, int tmpfd, char *why, size_t whysz) {
    strlist_t created = {0};
    int result = PL_FAILED; why[0] = 0;
    /* components */
    strlist_t comps = {0};
    { const char *s = r->dest, *st = s; for (;; s++) { if (*s == '/' || *s == 0) { sl_push(&comps, xstrndup(st, (size_t)(s - st))); st = s + 1; if (!*s) break; } } }
    const char *name = comps.v[comps.n - 1];
    int fd = open_outdir(fs, &created);
    if (fd < 0) { snprintf(why, whysz, "cannot make output directory %s: %s", fs->outdir, strerror(errno)); goto out; }
    buf_t sofar = {0}; buf_puts(&sofar, fs->outdir);
    for (int i = 0; i < comps.n - 1; i++) {
        buf_puts(&sofar, "/"); buf_puts(&sofar, comps.v[i]);
        int nfd = openat(fd, comps.v[i], O_DIRECTORY | O_NOFOLLOW | O_PATH | O_CLOEXEC);
        if (nfd < 0 && errno == ENOENT) {
            if (mkdirat(fd, comps.v[i], 0755) == 0) {
                sl_push(&created, xstrdup((char *)sofar.p));
                struct stat st; if (fstatat(fd, comps.v[i], &st, AT_SYMLINK_NOFOLLOW) == 0) ident_add(&fs->made, st.st_dev, st.st_ino);
            } else if (errno != EEXIST) {
                snprintf(why, whysz, "cannot create folder %s: %s", (char *)sofar.p, strerror(errno)); close(fd); buf_free(&sofar); goto out;
            }
            nfd = openat(fd, comps.v[i], O_DIRECTORY | O_NOFOLLOW | O_PATH | O_CLOEXEC);
        }
        if (nfd < 0) {
            if (errno == ENOTDIR) { result = PL_INWAY; snprintf(why, whysz, "a file is in the way where folder %s should be", (char *)sofar.p); }
            else if (errno == ELOOP) { result = PL_INWAY; snprintf(why, whysz, "a link is in the way at %s; not writing through it", (char *)sofar.p); }
            else snprintf(why, whysz, "cannot open folder %s: %s", (char *)sofar.p, strerror(errno));
            close(fd); buf_free(&sofar); goto out;
        }
        close(fd); fd = nfd;
    }
    buf_free(&sofar);
    /* times first, then the name */
    struct timespec ts[2]; ts[0].tv_sec = ts[1].tv_sec = (time_t)r->secs; ts[0].tv_nsec = ts[1].tv_nsec = (long)r->ms * 1000000L;
    bool timeset = futimens(tmpfd, ts) == 0;
    int rc = linkat(tmpfd, "", fd, name, AT_EMPTY_PATH);
    if (rc != 0 && errno != EEXIST && errno != ENAMETOOLONG) {
        char proc[64]; snprintf(proc, sizeof proc, "/proc/self/fd/%d", tmpfd);
        rc = linkat(AT_FDCWD, proc, fd, name, AT_SYMLINK_FOLLOW);
    }
    if (rc != 0 && errno != EEXIST && errno != ENAMETOOLONG) {
        /* not linkable here (memfd, or another filesystem): copy into a fresh file instead */
        int nfd = openat(fd, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0644);
        if (nfd >= 0) {
            if (copy_fd(tmpfd, nfd) != 0) { snprintf(why, whysz, "writing %s: %s", name, strerror(errno)); close(nfd); unlinkat(fd, name, 0); close(fd); goto out; }
            timeset = futimens(nfd, ts) == 0; close(nfd); rc = 0;
        }
    }
    if (rc != 0) {
        if (errno == EEXIST) {
            struct stat st;
            if (fstatat(fd, name, &st, AT_SYMLINK_NOFOLLOW) == 0 && S_ISDIR(st.st_mode)) { result = PL_INWAY; snprintf(why, whysz, "a folder is in the way where the file should land"); }
            else if (fstatat(fd, name, &st, AT_SYMLINK_NOFOLLOW) == 0 && ident_has(&fs->written, st.st_dev, st.st_ino)) { result = PL_COLLISION; snprintf(why, whysz, "another row of this snapshot already restored to this destination"); }
            else { result = PL_SKIPPED; snprintf(why, whysz, "already there before the restore; left alone"); }
        } else if (errno == ENAMETOOLONG) snprintf(why, whysz, "the destination won't create this name: %s", strerror(errno));
        else snprintf(why, whysz, "cannot create %s: %s", name, strerror(errno));
        close(fd); goto out;
    }
    /* written: remember its identity and read the time back */
    struct stat st;
    if (fstatat(fd, name, &st, AT_SYMLINK_NOFOLLOW) == 0) {
        ident_add(&fs->written, st.st_dev, st.st_ino);
        int64_t want_ns = r->secs * 1000000000LL + (int64_t)r->ms * 1000000LL;
        int64_t got_ns = (int64_t)st.st_mtim.tv_sec * 1000000000LL + st.st_mtim.tv_nsec;
        int64_t d = got_ns > want_ns ? got_ns - want_ns : want_ns - got_ns;
        if (!timeset || d > 500000) {
            if (d < 2000000000LL) { fs->rounded++; snprintf(why, whysz, "time kept rounded by %lld ns", (long long)d); }
            else { fs->timebad++; snprintf(why, whysz, "the destination did not keep the time: wanted %s, holds %lld.%09ld", r->mtime, (long long)st.st_mtim.tv_sec, st.st_mtim.tv_nsec); }
        }
    }
    close(fd);
    result = PL_RESTORED;
out:
    if (result != PL_RESTORED) rollback_dirs(&created);
    for (int i = 0; i < comps.n; i++) free(comps.v[i]);
    free(comps.v); free(created.v);
    return result;
}

/* ------------------------------------------------------------------------ */
/* main                                                                      */
/* ------------------------------------------------------------------------ */
static void print_escaped(const char *s) {
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        if (*p < 0x20 || *p == 0x7f) printf("\\x%02x", *p); else putchar(*p);
    }
}
static void report(const char *status, const char *subject, const char *detail) {
    printf("%-10s\t", status); print_escaped(subject);
    if (detail && *detail) { putchar('\t'); print_escaped(detail); }
    putchar('\n'); fflush(stdout);
}
/* A per-row outcome: status, destination or path, "line N", detail. */
static void report_row(const char *status, const char *subject, int lineno, const char *detail) {
    printf("%-10s\t", status); print_escaped(subject); printf("\tline %d", lineno);
    if (detail && *detail) { putchar('\t'); print_escaped(detail); }
    putchar('\n'); fflush(stdout);
}
static bool is_snapshot_name(const char *n) {
    static const char shape[] = "dddd-dd-ddTdddd";
    if (strlen(n) != 15) return false;
    for (int i = 0; i < 15; i++) { if (shape[i] == 'd') { if (n[i] < '0' || n[i] > '9') return false; } else if (n[i] != shape[i]) return false; }
    return true;
}
static void check_curl_abi(void) {
    struct { const char *name; int id; } want[] = {
        { "WRITEDATA", CURLOPT_WRITEDATA }, { "URL", CURLOPT_URL }, { "PROXY", CURLOPT_PROXY }, { "ERRORBUFFER", CURLOPT_ERRORBUFFER },
        { "WRITEFUNCTION", CURLOPT_WRITEFUNCTION }, { "USERAGENT", CURLOPT_USERAGENT }, { "LOW_SPEED_LIMIT", CURLOPT_LOW_SPEED_LIMIT },
        { "LOW_SPEED_TIME", CURLOPT_LOW_SPEED_TIME }, { "HTTPHEADER", CURLOPT_HTTPHEADER }, { "HEADERDATA", CURLOPT_HEADERDATA },
        { "VERBOSE", CURLOPT_VERBOSE }, { "CONNECTTIMEOUT", CURLOPT_CONNECTTIMEOUT }, { "HEADERFUNCTION", CURLOPT_HEADERFUNCTION },
        { "HTTPGET", CURLOPT_HTTPGET }, { "NOSIGNAL", CURLOPT_NOSIGNAL }, { "HTTP_CONTENT_DECODING", CURLOPT_HTTP_CONTENT_DECODING },
        { "FOLLOWLOCATION", CURLOPT_FOLLOWLOCATION },
    };
    for (size_t i = 0; i < sizeof want / sizeof want[0]; i++) {
        const struct curl_easyoption *o = curl_easy_option_by_name(want[i].name);
        if (!o || o->id != want[i].id) die("libcurl ABI check failed for CURLOPT_%s", want[i].name);
    }
}

int main(int argc, char **argv) {
    if (!setlocale(LC_CTYPE, "C.UTF-8") && !setlocale(LC_CTYPE, "en_US.UTF-8")) setlocale(LC_CTYPE, "");
    if (argc != 4 && argc != 5) { fprintf(stderr, "usage: %s <bucket> <set> <dir> [<snapshot>]\n", argv[0]); return 2; }
    const char *bucket = argv[1], *set = argv[2], *outdir = argv[3];
    char *snapname = argc == 5 ? xstrdup(argv[4]) : NULL;
    g_debug = getenv("S3CAB_RESTORE_DEBUG") && *getenv("S3CAB_RESTORE_DEBUG");
    if (!*set || strchr(set, '/')) die("set name '%s' is not a set name", set);
    if (!*outdir) die("empty output directory");
    { struct stat st; if (stat(outdir, &st) == 0 && !S_ISDIR(st.st_mode)) die("%s exists and is not a directory", outdir); }

    s3_t s = {0};
    s.bucket = bucket;
    s.akid = getenv("AWS_ACCESS_KEY_ID"); s.secret = getenv("AWS_SECRET_ACCESS_KEY"); s.token = getenv("AWS_SESSION_TOKEN");
    if (s.token && !*s.token) s.token = NULL;
    s.region = getenv("AWS_REGION"); if (!s.region || !*s.region) s.region = getenv("AWS_DEFAULT_REGION"); if (!s.region || !*s.region) s.region = "us-east-1";
    if (!s.akid || !s.secret || !*s.akid || !*s.secret) die("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set");
    s.proxy = getenv("HTTPS_PROXY"); if (!s.proxy || !*s.proxy) s.proxy = getenv("https_proxy"); if (s.proxy && !*s.proxy) s.proxy = NULL;
    snprintf(s.host, sizeof s.host, "%s.s3.%s.amazonaws.com", bucket, s.region);
    if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) die("curl_global_init failed");
    check_curl_abi();
    s.curl = curl_easy_init(); if (!s.curl) die("curl_easy_init failed");

    /* which snapshot */
    char prefix[1024]; snprintf(prefix, sizeof prefix, "snapshots/%s/", set);
    bool listmode = getenv("S3CAB_RESTORE_LIST") && *getenv("S3CAB_RESTORE_LIST");
    if (listmode && strcmp(set, "-") == 0) {
        /* discover the sets: folders and .info keys directly under snapshots/ */
        strlist_t keys = {0}, pre = {0};
        s3_list(&s, "snapshots/", true, &keys, &pre);
        for (int i = 0; i < pre.n; i++) printf("set-folder\t%s\n", pre.v[i]);
        for (int i = 0; i < keys.n; i++) printf("set-key   \t%s\n", keys.v[i]);
        return 0;
    }
    if (!snapname || listmode) {
        strlist_t keys = {0};
        s3_list(&s, prefix, true, &keys, NULL);
        char *best = NULL;
        for (int i = 0; i < keys.n; i++) {
            const char *k = keys.v[i] + strlen(prefix);
            size_t kl = strlen(k);
            bool ok = kl == 15 + 7 && strcmp(k + 15, ".tsv.gz") == 0;
            char nm[16] = {0}; if (ok) { memcpy(nm, k, 15); ok = is_snapshot_name(nm); }
            if (listmode) printf("%s\t%s\n", ok ? "snapshot" : "ignored ", keys.v[i]);
            if (ok && (!best || strcmp(nm, best) > 0)) { free(best); best = xstrdup(nm); }
        }
        if (listmode) {
            strlist_t rk = {0}; s3_list(&s, "objects.deleted-", true, &rk, NULL);
            for (int i = 0; i < rk.n; i++) printf("%s\t%s\n", is_record_key(rk.v[i]) ? "record  " : "ignored ", rk.v[i]);
            printf("latest  \t%s\n", best ? best : "(none)");
            return 0;
        }
        if (!best) die("no snapshot under %s", prefix);
        snapname = best;
    } else {
        size_t l = strlen(snapname);
        if (l > 7 && strcmp(snapname + l - 7, ".tsv.gz") == 0) snapname[l - 7] = 0;
        if (!is_snapshot_name(snapname)) die("'%s' is not a snapshot name (YYYY-MM-DDTHHMM)", snapname);
    }
    char key[1200]; snprintf(key, sizeof key, "%s%s.tsv.gz", prefix, snapname);
    report("snapshot", key, NULL);

    /* fetch and decompress */
    buf_t gz = {0}; char code[64];
    const char *local = getenv("S3CAB_RESTORE_LOCAL_SNAPSHOT");
    if (local && *local) {
        /* parser testing: take the snapshot bytes from a file on disk; objects still come from the bucket */
        FILE *f = fopen(local, "rb"); if (!f) die("%s: %s", local, strerror(errno));
        unsigned char b[65536]; size_t k; while ((k = fread(b, 1, sizeof b, f)) > 0) buf_push(&gz, b, k); fclose(f);
        if (!gz.p) buf_puts(&gz, "");
        report("local", local, "snapshot bytes read from disk, not the bucket");
    } else {
        long st = s3_get_mem(&s, key, &gz, code);
        if (st < 0) die("fetching %s failed", key);
        if (st == 404) die("%s: HTTP 404 %s", key, code);
        if (st != 200) die("%s: HTTP %ld %s", key, st, code);
    }
    buf_t text = {0}; char why[256];
    if (gunzip_all(gz.p, gz.n, &text, why, sizeof why) != 0) { report("refused", key, why); fprintf(stderr, "s3cab-restore: snapshot refused: %s\n", why); return 1; }
    dbg("snapshot: %zu bytes compressed, %zu bytes of text", gz.n, text.n);
    if (getenv("S3CAB_RESTORE_DUMP") && *getenv("S3CAB_RESTORE_DUMP")) {
        FILE *f = fopen(getenv("S3CAB_RESTORE_DUMP"), "wb"); if (f) { fwrite(text.p, 1, text.n, f); fclose(f); }
    }

    /* read and check */
    snap_t S; parse_snapshot(text.p, text.n, &S);
    if (S.refuse_whole) {
        char d[400]; snprintf(d, sizeof d, "%s: %s", S.refuse_whole, S.whole_detail);
        report("refused", key, d); fprintf(stderr, "s3cab-restore: snapshot refused whole, nothing restored: %s\n", d); return 1;
    }
    validate_rows(&S);
    for (int i = 0; i < S.ndirs; i++) {
        const dir_t *d = &S.dirs[i];
        char info[128]; snprintf(info, sizeof info, "line %d%s%s", d->lineno, d->usable ? "" : ", matches nothing", d->first != i ? ", repeats an earlier DIR" : "");
        report("dir", d->value, info);
    }
    /* two reached DIRs whose folder names collide, or `/` beside another: refuse before writing */
    {
        bool bad = false;
        for (int i = 0; i < S.ndirs; i++) {
            if (!S.dirs[i].reached) continue;
            for (int j = i + 1; j < S.ndirs; j++) {
                if (!S.dirs[j].reached) continue;
                const dir_t *a = &S.dirs[i], *b = &S.dirs[j];
                bool clash;
                if (!a->name || !b->name) clash = true;
                else { char *la = full_lower(a->name), *lb = full_lower(b->name); clash = strcmp(la, lb) == 0; free(la); free(lb); }
                if (clash) {
                    bad = true;
                    char d[600]; snprintf(d, sizeof d, "@SET DIR on line %d and on line %d both land in the same folder%s", a->lineno, b->lineno, (!a->name || !b->name) ? " (one is `/`, whose files land straight in the output)" : "");
                    report("refused", "restore", d);
                }
            }
        }
        if (bad) { fprintf(stderr, "s3cab-restore: restore refused before writing anything: member directories collide under the output directory\n"); return 1; }
    }

    fs_t fs = { .outdir = outdir, .tmpfile_ok = true };
    fs.tmp_dirfd = nearest_existing_dir(outdir);
    if (fs.tmp_dirfd < 0) die("%s: %s", outdir, strerror(errno));
    delset_t D = {0};
    EVP_MD_CTX *md = EVP_MD_CTX_new();

    for (int i = 0; i < S.nrows; i++) {
        row_t *r = &S.rows[i];
        if (r->refuse) { fs.refused++; report_row("refused", r->path, r->lineno, r->refuse); continue; }
        char okey[80]; snprintf(okey, sizeof okey, "objects/%s", r->hash);
        int tmpfd = open_tmp(&fs);
        if (tmpfd < 0) die("cannot open a temporary file: %s", strerror(errno));
        resp_t resp = { .fd = tmpfd, .md = md };
        if (s3_request(&s, okey, 0, NULL, NULL, &resp) < 0) die("fetching %s for %s failed; stopping", okey, r->path);
        if (resp.status == 200) {
            unsigned char dg[32]; unsigned int dl = 32; EVP_DigestFinal_ex(md, dg, &dl);
            char hex[65]; to_hex(dg, 32, hex);
            if (strcmp(hex, r->hash) != 0) {
                fs.corrupt++; char d[200]; snprintf(d, sizeof d, "damage: %s downloaded but hashes to %s; withheld", okey, hex);
                report_row("corrupt", r->path, r->lineno, d);
            } else {
                int pr = place_file(&fs, r, tmpfd, why, sizeof why);
                switch (pr) {
                case PL_RESTORED: fs.restored++; report_row("restored", r->dest, r->lineno, why); break;
                case PL_SKIPPED: fs.skipped++; report_row("skipped", r->dest, r->lineno, why); break;
                case PL_COLLISION: fs.collisions++; report_row("collision", r->dest, r->lineno, why); break;
                case PL_INWAY: fs.inway++; report_row("in-the-way", r->dest, r->lineno, why); break;
                default: fs.failed++; report_row("failed", r->dest, r->lineno, why); break;
                }
            }
        } else if (resp.status == 404) {
            s3_error_code(&resp, code, sizeof code);
            if (strcmp(code, "NoSuchKey") != 0 && strcmp(code, "NotFound") != 0) die("%s: HTTP 404 %s says nothing about the file; stopping", okey, code);
            load_records(&s, &D);
            const char *when = delset_find(&D, r->hash);
            if (when) { fs.deleted++; char d[128]; snprintf(d, sizeof d, "deliberately deleted %s; skipped", when); report_row("deleted", r->path, r->lineno, d); }
            else { fs.missing++; char d[160]; snprintf(d, sizeof d, "damage: %s is not in the store and no deletion record lists it", okey); report_row("missing", r->path, r->lineno, d); }
        } else if (resp.status == 403) {
            s3_error_code(&resp, code, sizeof code);
            die("%s: HTTP 403 %s: a permissions fault, or a missing key the caller may not list; stopping", okey, code);
        } else {
            s3_error_code(&resp, code, sizeof code);
            die("%s: HTTP %ld %s; stopping", okey, resp.status, code);
        }
        close(tmpfd); buf_free(&resp.errbody);
    }
    int bad = fs.missing + fs.corrupt + fs.refused + fs.collisions + fs.inway + fs.failed + fs.timebad;
    printf("summary   \trows=%d restored=%d skipped=%d deleted=%d missing=%d corrupt=%d refused=%d collisions=%d in-the-way=%d failed=%d time-rounded=%d time-not-kept=%d\n",
           S.nrows, fs.restored, fs.skipped, fs.deleted, fs.missing, fs.corrupt, fs.refused, fs.collisions, fs.inway, fs.failed, fs.rounded, fs.timebad);
    printf("exit      \t%d\n", bad ? 1 : 0);
    return bad ? 1 : 0;
}
