/* S3 over plain HTTPS, signed with AWS Signature Version 4 by hand. */
#include "common.h"
#include <time.h>
#include <unistd.h>
#include <errno.h>

struct s3_client {
    char *bucket, *region, *akid, *secret, *token, *proxy;
    char *host;          /* virtual-hosted: <bucket>.s3.<region>.amazonaws.com */
    bool path_style;
    http_conn *conn;
};

static bool unreserved(unsigned char c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~';
}

/* RFC 3986 encoding as SigV4 wants it; keep_slash for the URI path. */
static void uri_encode(buf_t *out, const char *s, bool keep_slash) {
    static const char hx[] = "0123456789ABCDEF";
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        if (unreserved(*p) || (keep_slash && *p == '/')) buf_append(out, p, 1);
        else { char e[3] = { '%', hx[*p >> 4], hx[*p & 15] }; buf_append(out, e, 3); }
    }
}

s3_client *s3_new(const char *bucket, const char *region, const char *akid, const char *secret, const char *token, const char *proxy) {
    s3_client *c = xmalloc(sizeof *c);
    memset(c, 0, sizeof *c);
    c->bucket = xstrdup(bucket); c->region = xstrdup(region);
    c->akid = xstrdup(akid); c->secret = xstrdup(secret);
    c->token = token && *token ? xstrdup(token) : NULL;
    c->proxy = proxy && *proxy ? xstrdup(proxy) : NULL;
    /* A bucket name with a dot can't be a TLS host label chain under the
     * wildcard certificate, so use path-style for those. */
    c->path_style = strchr(bucket, '.') != NULL;
    buf_t h; buf_init(&h);
    if (c->path_style) buf_appendf(&h, "s3.%s.amazonaws.com", region);
    else buf_appendf(&h, "%s.s3.%s.amazonaws.com", bucket, region);
    c->host = (char *)h.p;
    return c;
}

void s3_free(s3_client *c) {
    if (!c) return;
    http_close(c->conn);
    free(c->bucket); free(c->region); free(c->akid); free(c->secret); free(c->token); free(c->proxy); free(c->host);
    free(c);
}

typedef struct { const char *k, *v; } qparam;
static int qcmp(const void *a, const void *b) { return strcmp(((const qparam *)a)->k, ((const qparam *)b)->k); }

/* Build the signed request and perform it, with retries per the spec's
 * reading checklist.  `key` is the object key (NULL for the bucket itself);
 * `params` the query parameters.  The response is returned in *resp. */
static bool s3_do(s3_client *c, const char *method, const char *key, qparam *params, size_t np,
                  http_body_cb cb, void *ud, http_response *resp, char **errmsg) {
    /* Canonical URI */
    buf_t curi; buf_init(&curi);
    buf_appendstr(&curi, "/");
    if (c->path_style) { uri_encode(&curi, c->bucket, false); buf_appendstr(&curi, "/"); }
    if (key) uri_encode(&curi, key, true);
    /* Canonical query string: sorted by name. */
    qsort(params, np, sizeof *params, qcmp);
    buf_t cqs; buf_init(&cqs);
    for (size_t i = 0; i < np; i++) {
        if (i) buf_appendstr(&cqs, "&");
        uri_encode(&cqs, params[i].k, false);
        buf_appendstr(&cqs, "=");
        uri_encode(&cqs, params[i].v, false);
    }
    static const char empty_sha[] = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    int attempts_5xx = 0;
    time_t first_drop = 0;
    double ceiling = 0.5;
    bool ok = false;
    for (;;) {
        /* Time stamps are taken per attempt so a retry is freshly signed. */
        time_t now = time(NULL);
        struct tm tmv; gmtime_r(&now, &tmv);
        char amzdate[17], datestamp[9];
        strftime(amzdate, sizeof amzdate, "%Y%m%dT%H%M%SZ", &tmv);
        memcpy(datestamp, amzdate, 8); datestamp[8] = 0;

        /* Canonical headers, sorted by lowercase name. */
        buf_t ch; buf_init(&ch);
        buf_appendf(&ch, "host:%s\n", c->host);
        buf_appendf(&ch, "x-amz-content-sha256:%s\n", empty_sha);
        buf_appendf(&ch, "x-amz-date:%s\n", amzdate);
        if (c->token) buf_appendf(&ch, "x-amz-security-token:%s\n", c->token);
        const char *signed_hdrs = c->token ? "host;x-amz-content-sha256;x-amz-date;x-amz-security-token" : "host;x-amz-content-sha256;x-amz-date";

        buf_t creq; buf_init(&creq);
        buf_appendf(&creq, "%s\n%s\n%s\n%s\n%s\n%s", method, buf_cstr(&curi), buf_cstr(&cqs), buf_cstr(&ch), signed_hdrs, empty_sha);
        char creq_hash[65]; sha256_hex(creq.p, creq.len, creq_hash);
        if (getenv("S3CAB_DEBUG")) fprintf(stderr, "--- canonical request ---\n%s\n--- end ---\n", buf_cstr(&creq));

        buf_t scope; buf_init(&scope);
        buf_appendf(&scope, "%s/%s/s3/aws4_request", datestamp, c->region);
        buf_t sts; buf_init(&sts);
        buf_appendf(&sts, "AWS4-HMAC-SHA256\n%s\n%s\n%s", amzdate, buf_cstr(&scope), creq_hash);

        unsigned char k[32];
        buf_t k0; buf_init(&k0); buf_appendf(&k0, "AWS4%s", c->secret);
        hmac_sha256(k0.p, k0.len, datestamp, 8, k);
        hmac_sha256(k, 32, c->region, strlen(c->region), k);
        hmac_sha256(k, 32, "s3", 2, k);
        hmac_sha256(k, 32, "aws4_request", 12, k);
        hmac_sha256(k, 32, sts.p, sts.len, k);
        char sig[65]; hex_encode(k, 32, sig);
        buf_t auth; buf_init(&auth);
        buf_appendf(&auth, "AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s", c->akid, buf_cstr(&scope), signed_hdrs, sig);

        http_header hdrs[6]; size_t nh = 0;
        hdrs[nh++] = (http_header){ "Host", c->host };
        hdrs[nh++] = (http_header){ "x-amz-content-sha256", empty_sha };
        hdrs[nh++] = (http_header){ "x-amz-date", amzdate };
        if (c->token) hdrs[nh++] = (http_header){ "x-amz-security-token", c->token };
        hdrs[nh++] = (http_header){ "Authorization", buf_cstr(&auth) };
        /* No Accept-Encoding: we want the stored bytes, never a decoded form. */

        buf_t pq; buf_init(&pq);
        buf_appendstr(&pq, buf_cstr(&curi));
        if (cqs.len) { buf_appendstr(&pq, "?"); buf_appendstr(&pq, buf_cstr(&cqs)); }

        /* Open or reuse the connection; one reconnect on a stale keep-alive. */
        bool reusable = false;
        bool transport_ok = false;
        for (int pass = 0; pass < 2; pass++) {
            http_response_free(resp); http_response_init(resp);
            char err[256] = "";
            if (!c->conn) {
                c->conn = http_open(c->host, 443, c->proxy, err, sizeof err);
                if (!c->conn) { snprintf(resp->err, sizeof resp->err, "%s", err); resp->dropped = true; break; }
                pass = 1; /* a fresh connection gets one try */
            }
            transport_ok = http_request(c->conn, method, buf_cstr(&pq), hdrs, nh, cb, ud, resp, &reusable);
            if (transport_ok) break;
            http_close(c->conn); c->conn = NULL;
            /* A reused connection the server had closed: retry once, unless
             * the body callback has already received bytes (not idempotent to
             * replay then without the caller's say). */
            if (resp->body.len || (cb && ud && pass == 0 && resp->status != -1)) break;
        }
        if (!reusable && c->conn) { http_close(c->conn); c->conn = NULL; }

        buf_free(&ch); buf_free(&creq); buf_free(&scope); buf_free(&sts); buf_free(&k0); buf_free(&auth); buf_free(&pq);

        if (transport_ok && resp->status < 500) { ok = true; break; }

        /* Retry policy. */
        if (!transport_ok) {
            if (!first_drop) first_drop = time(NULL);
            if (time(NULL) - first_drop >= 120) break;
            double wait = ((double)rand() / RAND_MAX) * ceiling;
            ceiling = ceiling * 2 > 2 ? 2 : ceiling * 2;
            fprintf(stderr, "s3cab-restore: connection dropped (%s); retrying in %.1fs\n", resp->err, wait);
            usleep((useconds_t)(wait * 1e6));
            continue;
        }
        /* 5xx */
        attempts_5xx++;
        if (attempts_5xx >= 3) break;
        bool throttled = resp->status == 503;
        static double c5 = 0; if (c5 == 0) c5 = throttled ? 0.5 : 0.1;
        double wait = ((double)rand() / RAND_MAX) * c5;
        c5 = c5 * 2 > 20 ? 20 : c5 * 2;
        fprintf(stderr, "s3cab-restore: HTTP %d from S3; retrying in %.2fs\n", resp->status, wait);
        usleep((useconds_t)(wait * 1e6));
        if (c->conn) { http_close(c->conn); c->conn = NULL; }
    }
    buf_free(&curi); buf_free(&cqs);
    if (!ok) {
        buf_t m; buf_init(&m);
        if (resp->status == -1) buf_appendf(&m, "request failed after retries: %s", resp->err);
        else buf_appendf(&m, "request failed after retries: HTTP %d", resp->status);
        *errmsg = (char *)m.p;
    }
    return ok;
}

/* Extract <Code>...</Code> from an S3 error body. */
static char *xml_error_code(const buf_t *body) {
    const char *s = (const char *)body->p;
    if (!s) return NULL;
    const char *a = strstr(s, "<Code>");
    if (!a) return NULL;
    a += 6;
    const char *b = strstr(a, "</Code>");
    if (!b) return NULL;
    return xstrndup(a, (size_t)(b - a));
}

static char *describe_failure(const http_response *r, const char *what) {
    buf_t m; buf_init(&m);
    char *code = xml_error_code(&r->body);
    buf_appendf(&m, "%s: HTTP %d%s%s", what, r->status, code ? " " : "", code ? code : "");
    if (getenv("S3CAB_DEBUG") && r->body.len) fprintf(stderr, "--- error body ---\n%.*s\n--- end ---\n", (int)r->body.len, (char *)r->body.p);
    if (r->body.len && r->body.len < 2000 && !code) buf_appendf(&m, " body: %.*s", (int)r->body.len, (char *)r->body.p);
    free(code);
    return (char *)m.p;
}

/* The body callback has no view of the status, so a wrapper forwards object
 * bytes to the caller only on a 200 and keeps anything else as an error body. */
struct fwd { http_body_cb cb; void *ud; http_response *r; };
static bool fwd_cb(void *u, const unsigned char *d, size_t n) {
    struct fwd *F = u;
    if (F->r->status == 200 && F->cb) return F->cb(F->ud, d, n);
    buf_append(&F->r->body, d, n);
    return true;
}

s3_status s3_get(s3_client *c, const char *key, http_body_cb cb, void *ud, buf_t *body, char **errmsg) {
    *errmsg = NULL;
    http_response resp; http_response_init(&resp);
    struct fwd f = { cb, ud, &resp };
    bool ok = s3_do(c, "GET", key, NULL, 0, cb ? fwd_cb : NULL, cb ? (void *)&f : NULL, &resp, errmsg);
    s3_status st;
    if (!ok) st = S3_ERROR;
    else if (resp.status == 200) {
        if (!cb && body) { buf_free(body); *body = resp.body; buf_init(&resp.body); }
        st = S3_OK;
    } else if (resp.status == 404) {
        char *code = xml_error_code(&resp.body);
        if (code && (!strcmp(code, "NoSuchKey") || !strcmp(code, "NotFound"))) st = S3_MISS;
        else { st = S3_ERROR; *errmsg = describe_failure(&resp, key); }
        free(code);
    } else { st = S3_ERROR; *errmsg = describe_failure(&resp, key); }
    http_response_free(&resp);
    return st;
}

/* Minimal XML helpers for ListObjectsV2.  Keys are entity-decoded. */
static const char *find_tag(const char *s, const char *end, const char *tag, const char **content_end) {
    char open[64], close[64];
    snprintf(open, sizeof open, "<%s>", tag);
    snprintf(close, sizeof close, "</%s>", tag);
    const char *a = memmem(s, (size_t)(end - s), open, strlen(open));
    if (!a) return NULL;
    a += strlen(open);
    const char *b = memmem(a, (size_t)(end - a), close, strlen(close));
    if (!b) return NULL;
    *content_end = b;
    return a;
}

static char *xml_unescape(const char *s, size_t n) {
    buf_t o; buf_init(&o);
    for (size_t i = 0; i < n; i++) {
        if (s[i] != '&') { buf_append(&o, s + i, 1); continue; }
        const char *semi = memchr(s + i, ';', n - i);
        if (!semi) { buf_append(&o, s + i, 1); continue; }
        size_t el = (size_t)(semi - (s + i)) - 1;
        const char *e = s + i + 1;
        if (el == 3 && !strncmp(e, "amp", 3)) buf_appendstr(&o, "&");
        else if (el == 2 && !strncmp(e, "lt", 2)) buf_appendstr(&o, "<");
        else if (el == 2 && !strncmp(e, "gt", 2)) buf_appendstr(&o, ">");
        else if (el == 4 && !strncmp(e, "quot", 4)) buf_appendstr(&o, "\"");
        else if (el == 4 && !strncmp(e, "apos", 4)) buf_appendstr(&o, "'");
        else if (el > 1 && e[0] == '#') {
            uint32_t cp = (e[1] == 'x' || e[1] == 'X') ? (uint32_t)strtoul(e + 2, NULL, 16) : (uint32_t)strtoul(e + 1, NULL, 10);
            unsigned char u[4]; size_t ul = utf8_encode(cp, u);
            buf_append(&o, u, ul);
        } else { buf_append(&o, s + i, el + 2); }
        i += el + 1;
    }
    return (char *)o.p;
}

void s3_keylist_free(s3_keylist *l) {
    for (size_t i = 0; i < l->n; i++) free(l->keys[i]);
    free(l->keys);
    l->keys = NULL; l->n = l->cap = 0;
}

static void keylist_add(s3_keylist *l, char *k) {
    if (l->n == l->cap) { l->cap = l->cap ? l->cap * 2 : 64; l->keys = xrealloc(l->keys, l->cap * sizeof *l->keys); }
    l->keys[l->n++] = k;
}

bool s3_list(s3_client *c, const char *prefix, s3_keylist *out, char **errmsg) {
    *errmsg = NULL;
    char *token = NULL;
    for (;;) {
        qparam params[4]; size_t np = 0;
        params[np++] = (qparam){ "list-type", "2" };
        params[np++] = (qparam){ "prefix", prefix };
        params[np++] = (qparam){ "delimiter", "/" };
        if (token) params[np++] = (qparam){ "continuation-token", token };
        http_response resp; http_response_init(&resp);
        bool ok = s3_do(c, "GET", NULL, params, np, NULL, NULL, &resp, errmsg);
        if (!ok) { http_response_free(&resp); free(token); return false; }
        if (resp.status != 200) { *errmsg = describe_failure(&resp, "listing"); http_response_free(&resp); free(token); return false; }
        const char *s = (const char *)resp.body.p, *end = s + resp.body.len;
        /* Each <Contents> block holds one <Key>. */
        const char *p = s;
        for (;;) {
            const char *ce;
            const char *cs = find_tag(p, end, "Contents", &ce);
            if (!cs) break;
            const char *ke;
            const char *ks = find_tag(cs, ce, "Key", &ke);
            if (ks) keylist_add(out, xml_unescape(ks, (size_t)(ke - ks)));
            p = ce;
        }
        const char *te;
        const char *ts = find_tag(s, end, "IsTruncated", &te);
        bool truncated = ts && (size_t)(te - ts) == 4 && !strncmp(ts, "true", 4);
        free(token); token = NULL;
        if (truncated) {
            const char *ne;
            const char *ns = find_tag(s, end, "NextContinuationToken", &ne);
            if (!ns) { *errmsg = xstrdup("listing: truncated without a continuation token"); http_response_free(&resp); return false; }
            token = xml_unescape(ns, (size_t)(ne - ns));
        }
        http_response_free(&resp);
        if (!token) break;
    }
    return true;
}
