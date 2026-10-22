#include "s3.h"

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include <expat.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/rand.h>
#include <openssl/sha.h>

static const char EMPTY_SHA256[] = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

static char *env_req(const char *a, const char *b)
{
    const char *v = getenv(a);
    if ((!v || !*v) && b) v = getenv(b);
    return v && *v ? xstrdup(v) : nullptr;
}

void s3_init(s3_t *s3, const char *bucket)
{
    *s3 = (s3_t){0};
    s3->bucket = xstrdup(bucket);
    s3->akid = env_req("AWS_ACCESS_KEY_ID", nullptr);
    s3->secret = env_req("AWS_SECRET_ACCESS_KEY", nullptr);
    s3->token = env_req("AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN");
    s3->region = env_req("AWS_REGION", "AWS_DEFAULT_REGION");
    if (!s3->akid || !s3->secret) die("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set");
    if (!s3->region) die("AWS_REGION must be set");
    /* Virtual-hosted style, unless a dot in the bucket name would break the certificate match. */
    buf_t h = {0};
    s3->path_style = strchr(bucket, '.') != nullptr;
    if (s3->path_style)
        buf_addf(&h, "s3.%s.amazonaws.com", s3->region);
    else
        buf_addf(&h, "%s.s3.%s.amazonaws.com", bucket, s3->region);
    s3->host = (char *)h.p;
    s3->conn = http_conn_new(s3->host);
}

void s3_free(s3_t *s3)
{
    http_conn_free(s3->conn);
    free(s3->bucket);
    free(s3->akid);
    free(s3->secret);
    free(s3->token);
    free(s3->region);
    free(s3->host);
}

/* SigV4 URI encoding: unreserved characters pass, everything else is %XX (uppercase). */
static void uri_encode(buf_t *out, const char *s, bool keep_slash)
{
    static const char hx[] = "0123456789ABCDEF";
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        unsigned char c = *p;
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_' ||
            c == '.' || c == '~' || (keep_slash && c == '/')) {
            buf_add(out, &c, 1);
        } else {
            char e[3] = {'%', hx[c >> 4], hx[c & 15]};
            buf_add(out, e, 3);
        }
    }
}

static void sha256_hex(const void *p, size_t n, char out[65])
{
    unsigned char d[32];
    SHA256(p, n, d);
    hex_encode(d, 32, out);
}

static void hmac(const void *key, size_t klen, const char *msg, unsigned char out[32])
{
    unsigned int olen = 32;
    HMAC(EVP_sha256(), key, (int)klen, (const unsigned char *)msg, strlen(msg), out, &olen);
}

typedef struct {
    const char *k, *v;
} qparam_t;

static int qcmp(const void *a, const void *b)
{
    return strcmp(((const qparam_t *)a)->k, ((const qparam_t *)b)->k);
}

/* Builds the request target and the signed headers for GET <key>?<query>. */
static void sign_get(s3_t *s3, const char *key, qparam_t *q, size_t nq, buf_t *target, buf_t hdr[4])
{
    buf_t uri = {0}, query = {0}, creq = {0}, sts = {0};
    buf_adds(&uri, "/");
    if (s3->path_style) {
        uri_encode(&uri, s3->bucket, false);
        buf_adds(&uri, "/");
    }
    uri_encode(&uri, key, true);

    qsort(q, nq, sizeof *q, qcmp); /* keys here are all unreserved, so raw order = encoded order */
    for (size_t i = 0; i < nq; i++) {
        if (i) buf_adds(&query, "&");
        uri_encode(&query, q[i].k, false);
        buf_adds(&query, "=");
        uri_encode(&query, q[i].v, false);
    }

    time_t now = time(nullptr);
    struct tm tm;
    gmtime_r(&now, &tm);
    char amzdate[17], day[9];
    strftime(amzdate, sizeof amzdate, "%Y%m%dT%H%M%SZ", &tm);
    strftime(day, sizeof day, "%Y%m%d", &tm);

    const char *signed_headers =
        s3->token ? "host;x-amz-content-sha256;x-amz-date;x-amz-security-token" : "host;x-amz-content-sha256;x-amz-date";
    buf_addf(&creq, "GET\n%s\n%s\nhost:%s\nx-amz-content-sha256:%s\nx-amz-date:%s\n", (char *)uri.p,
             query.len ? (char *)query.p : "", s3->host, EMPTY_SHA256, amzdate);
    if (s3->token) buf_addf(&creq, "x-amz-security-token:%s\n", s3->token);
    buf_addf(&creq, "\n%s\n%s", signed_headers, EMPTY_SHA256);

    char creq_hash[65];
    sha256_hex(creq.p, creq.len, creq_hash);
    buf_addf(&sts, "AWS4-HMAC-SHA256\n%s\n%s/%s/s3/aws4_request\n%s", amzdate, day, s3->region, creq_hash);

    buf_t k0 = {0};
    buf_addf(&k0, "AWS4%s", s3->secret);
    unsigned char k1[32], k2[32], k3[32], k4[32], sig[32];
    hmac(k0.p, k0.len, day, k1);
    hmac(k1, 32, s3->region, k2);
    hmac(k2, 32, "s3", k3);
    hmac(k3, 32, "aws4_request", k4);
    hmac(k4, 32, (char *)sts.p, sig);
    char sighex[65];
    hex_encode(sig, 32, sighex);

    buf_addf(&hdr[0], "Authorization: AWS4-HMAC-SHA256 Credential=%s/%s/%s/s3/aws4_request, SignedHeaders=%s, Signature=%s",
             s3->akid, day, s3->region, signed_headers, sighex);
    buf_addf(&hdr[1], "x-amz-content-sha256: %s", EMPTY_SHA256);
    buf_addf(&hdr[2], "x-amz-date: %s", amzdate);
    if (s3->token) buf_addf(&hdr[3], "x-amz-security-token: %s", s3->token);

    buf_add(target, uri.p, uri.len);
    if (query.len) {
        buf_adds(target, "?");
        buf_add(target, query.p, query.len);
    }
    buf_free(&uri);
    buf_free(&query);
    buf_free(&creq);
    buf_free(&sts);
    buf_free(&k0);
}

/* Pull <Code> and <Message> out of an S3 error body, for the report. */
static void s3_error_text(const buf_t *body, char *out, size_t n)
{
    char code[128] = "", msg[256] = "";
    const char *b = body->len ? (const char *)body->p : "";
    const char *c = strstr(b, "<Code>"), *m = strstr(b, "<Message>");
    if (c) sscanf(c + 6, "%127[^<]", code);
    if (m) sscanf(m + 9, "%255[^<]", msg);
    snprintf(out, n, "%s%s%s", code, *code && *msg ? ": " : "", msg);
}

static double mono_now(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + ts.tv_nsec / 1e9;
}

static void random_sleep(double ceiling)
{
    unsigned int r = 0;
    RAND_bytes((unsigned char *)&r, sizeof r);
    double s = ceiling * (r / 4294967296.0);
    struct timespec ts = {.tv_sec = (time_t)s, .tv_nsec = (long)((s - (double)(time_t)s) * 1e9)};
    while (nanosleep(&ts, &ts) == -1 && errno == EINTR) {}
}

/* One signed GET with the retry policy: a dropped connection is retried for two minutes from
 * the first failure, a 5xx up to three attempts in all; each wait random under a doubling ceiling. */
static int s3_request(s3_t *s3, const char *key, qparam_t *q, size_t nq, const s3_sink_t *sink, char *err,
                      size_t errlen)
{
    double first_drop = 0, ceiling = 0.5;
    int attempts_5xx = 0;
    http_result_t res = {0};
    for (;;) {
        if (sink && sink->reset && sink->reset(sink->ctx)) {
            snprintf(err, errlen, "cannot reset the download target");
            buf_free(&res.errbody);
            return S3_FAIL;
        }
        buf_t target = {0}, hdr[4] = {0};
        sign_get(s3, key, q, nq, &target, hdr);
        const char *hv[5] = {(char *)hdr[0].p, (char *)hdr[1].p, (char *)hdr[2].p, hdr[3].len ? (char *)hdr[3].p : nullptr,
                             nullptr};
        s3->requests++;
        int rc = http_get(s3->conn, (char *)target.p, hv, sink ? sink->write : nullptr, sink ? sink->ctx : nullptr, &res);
        buf_free(&target);
        for (int i = 0; i < 4; i++) buf_free(&hdr[i]);

        if (rc == HTTP_SINK) {
            snprintf(err, errlen, "writing the download failed");
            buf_free(&res.errbody);
            return S3_FAIL;
        }
        if (rc == HTTP_TRANSPORT) {
            double now = mono_now();
            if (first_drop == 0) first_drop = now;
            if (now - first_drop > 120) {
                snprintf(err, errlen, "gave up after two minutes of dropped connections: %s", res.err);
                buf_free(&res.errbody);
                return S3_FAIL;
            }
            fprintf(stderr, "s3cab-restore: retrying %s: %s\n", key[0] ? key : "(list)", res.err);
            random_sleep(ceiling);
            ceiling = ceiling * 2 > 30 ? 30 : ceiling * 2;
            continue;
        }
        if (res.status / 100 == 2) {
            buf_free(&res.errbody);
            return S3_OK;
        }
        if (res.status == 404) {
            buf_free(&res.errbody);
            return S3_NOT_FOUND;
        }
        char detail[400];
        s3_error_text(&res.errbody, detail, sizeof detail);
        if (res.status / 100 == 5 && ++attempts_5xx < 3) {
            fprintf(stderr, "s3cab-restore: retrying %s: HTTP %d %s\n", key[0] ? key : "(list)", res.status, detail);
            random_sleep(ceiling);
            ceiling = ceiling * 2 > 30 ? 30 : ceiling * 2;
            continue;
        }
        snprintf(err, errlen, "HTTP %d%s%s", res.status, detail[0] ? " " : "", detail);
        buf_free(&res.errbody);
        return S3_FAIL;
    }
}

int s3_get(s3_t *s3, const char *key, const s3_sink_t *sink, char *err, size_t errlen)
{
    return s3_request(s3, key, nullptr, 0, sink, err, errlen);
}

/* ---- ListObjectsV2 ---- */

typedef struct {
    int depth;
    bool in_contents, capture;
    int capture_depth;
    buf_t text;
    char *what; /* element being captured */
    char ***keys;
    size_t *nkeys;
    bool truncated;
    char *next_token;
    bool bad;
} listp_t;

static void url_unquote_plus(char *s)
{
    char *w = s;
    for (char *r = s; *r; r++) {
        if (*r == '+') {
            *w++ = ' ';
        } else if (r[0] == '%' && r[1] && r[2]) {
            char h[3] = {r[1], r[2], 0};
            char *end;
            long v = strtol(h, &end, 16);
            if (*end) {
                *w++ = *r;
                continue;
            }
            *w++ = (char)v;
            r += 2;
        } else {
            *w++ = *r;
        }
    }
    *w = 0;
}

static void XMLCALL lp_start(void *ud, const XML_Char *name, const XML_Char **atts)
{
    (void)atts;
    listp_t *lp = ud;
    lp->depth++;
    if (lp->depth == 2 && strcmp(name, "Contents") == 0) lp->in_contents = true;
    bool want = (lp->depth == 3 && lp->in_contents && strcmp(name, "Key") == 0) ||
                (lp->depth == 2 && (strcmp(name, "IsTruncated") == 0 || strcmp(name, "NextContinuationToken") == 0));
    if (want) {
        lp->capture = true;
        lp->capture_depth = lp->depth;
        lp->text.len = 0;
        free(lp->what);
        lp->what = xstrdup(name);
    }
}

static void XMLCALL lp_end(void *ud, const XML_Char *name)
{
    listp_t *lp = ud;
    if (lp->capture && lp->depth == lp->capture_depth) {
        lp->capture = false;
        buf_add(&lp->text, "", 0);
        char *t = (char *)lp->text.p;
        if (strcmp(lp->what, "Key") == 0) {
            char *k = xstrdup(t);
            url_unquote_plus(k); /* encoding-type=url */
            *lp->keys = xrealloc(*lp->keys, (*lp->nkeys + 1) * sizeof **lp->keys);
            (*lp->keys)[(*lp->nkeys)++] = k;
        } else if (strcmp(lp->what, "IsTruncated") == 0) {
            lp->truncated = strcmp(t, "true") == 0;
        } else {
            free(lp->next_token);
            lp->next_token = xstrdup(t);
        }
    }
    if (lp->depth == 2 && strcmp(name, "Contents") == 0) lp->in_contents = false;
    lp->depth--;
}

static void XMLCALL lp_text(void *ud, const XML_Char *s, int len)
{
    listp_t *lp = ud;
    if (lp->capture) buf_add(&lp->text, s, (size_t)len);
}

static int sink_mem_reset(void *ctx)
{
    ((buf_t *)ctx)->len = 0;
    return 0;
}

static int sink_mem_write(void *ctx, const unsigned char *p, size_t n)
{
    buf_add(ctx, p, n);
    return 0;
}

int s3_list(s3_t *s3, const char *prefix, const char *delimiter, char ***keys, size_t *nkeys, char *err,
            size_t errlen)
{
    char *token = nullptr;
    for (;;) {
        qparam_t q[5];
        size_t nq = 0;
        q[nq++] = (qparam_t){"list-type", "2"};
        q[nq++] = (qparam_t){"prefix", prefix};
        q[nq++] = (qparam_t){"encoding-type", "url"};
        if (delimiter) q[nq++] = (qparam_t){"delimiter", delimiter};
        if (token) q[nq++] = (qparam_t){"continuation-token", token};

        buf_t body = {0};
        s3_sink_t sink = {sink_mem_reset, sink_mem_write, &body};
        int rc = s3_request(s3, "", q, nq, &sink, err, errlen);
        if (rc != S3_OK) {
            if (rc == S3_NOT_FOUND) snprintf(err, errlen, "bucket not found (404)");
            buf_free(&body);
            free(token);
            return S3_FAIL;
        }
        listp_t lp = {.keys = keys, .nkeys = nkeys};
        XML_Parser xp = XML_ParserCreate("UTF-8");
        XML_SetUserData(xp, &lp);
        XML_SetElementHandler(xp, lp_start, lp_end);
        XML_SetCharacterDataHandler(xp, lp_text);
        bool ok = XML_Parse(xp, (char *)body.p, (int)body.len, 1) == XML_STATUS_OK;
        if (!ok) snprintf(err, errlen, "bad list response: %s", XML_ErrorString(XML_GetErrorCode(xp)));
        XML_ParserFree(xp);
        buf_free(&body);
        buf_free(&lp.text);
        free(lp.what);
        free(token);
        token = lp.next_token;
        if (!ok) {
            free(token);
            return S3_FAIL;
        }
        if (!lp.truncated) break;
        if (!token || !*token) {
            snprintf(err, errlen, "truncated list response without a continuation token");
            free(token);
            return S3_FAIL;
        }
    }
    free(token);
    return S3_OK;
}
