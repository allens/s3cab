// Read-only S3 over plain HTTPS.
//
// Three layers, top to bottom of this file's dependencies:
//   - a transport: TCP (through an HTTP proxy's CONNECT tunnel when HTTPS_PROXY is set),
//     then TLS by OpenSSL, the peer's certificate and host name verified;
//   - a minimal HTTP/1.1 client: one GET at a time on a kept-alive connection, bodies by
//     Content-Length, chunked, or to the close; no content decoding, no Accept-Encoding;
//   - AWS Signature Version 4 for the "s3" service, and the two S3 calls a restore needs:
//     GetObject and ListObjectsV2.
#define _GNU_SOURCE
#include "s3.h"

#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <time.h>
#include <unistd.h>

#include <expat.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <openssl/ssl.h>
#include <openssl/x509v3.h>

constexpr int CONNECT_TIMEOUT_MS = 10'000; // "connecting takes 10 seconds"
constexpr int IDLE_TIMEOUT_S = 30;         // "30 seconds without a byte either way"
constexpr double DROPPED_RETRY_S = 120.0;  // retry a dropped connection for two minutes
constexpr int MAX_5XX_ATTEMPTS = 3;
constexpr size_t MAX_HEADER_LINE = 64 * 1024;

// SHA-256 of the empty string: the payload hash of every request made here (all are GETs).
static const char EMPTY_SHA256[] = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

struct s3 {
    char *access, *secret, *token, *region, *bucket;
    char *host; // the endpoint's host name
    bool path_style;
    char *proxy_host, *proxy_port, *proxy_auth; // auth is base64(user:pass), or null
    SSL_CTX *ctx;
    SSL *ssl;
    int fd;
    bool reused; // a response has already been read on this connection
    unsigned char rb[1 << 16];
    size_t rpos, rlen;
    char bucket_region[64]; // x-amz-bucket-region of the last response
    unsigned long requests;
    int max_keys; // test aid: listing page size; 0 leaves it to the store
    bool debug;
};

// ---------------------------------------------------------------- small helpers

static double now_monotonic(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

static void sleep_random_under(double ceiling) {
    double s = ceiling * ((double)random() / ((double)RAND_MAX + 1.0));
    struct timespec ts = {.tv_sec = (time_t)s, .tv_nsec = (long)((s - (double)(time_t)s) * 1e9)};
    nanosleep(&ts, nullptr);
}

static bool is_unreserved(unsigned char ch) {
    return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch == '-' ||
           ch == '_' || ch == '.' || ch == '~';
}

// RFC 3986 percent-encoding as SigV4 wants it: everything but the unreserved characters,
// uppercase hex, and '/' kept only in a path.
static void uri_encode(buf *out, const char *s, size_t n, bool keep_slash) {
    for (size_t i = 0; i < n; i++) {
        unsigned char ch = (unsigned char)s[i];
        if (is_unreserved(ch) || (keep_slash && ch == '/'))
            buf_putc(out, (char)ch);
        else
            buf_printf(out, "%%%02X", ch);
    }
}

static int hexval(int ch) {
    if (ch >= '0' && ch <= '9') return ch - '0';
    if (ch >= 'a' && ch <= 'f') return ch - 'a' + 10;
    if (ch >= 'A' && ch <= 'F') return ch - 'A' + 10;
    return -1;
}

// Undo the listing's encoding-type=url: %XX is a byte, and '+' a space.
static char *url_decode(const char *s, size_t n, bool plus_is_space) {
    char *out = xmalloc(n + 1);
    size_t o = 0;
    for (size_t i = 0; i < n; i++) {
        if (s[i] == '%' && i + 2 < n && hexval(s[i + 1]) >= 0 && hexval(s[i + 2]) >= 0) {
            out[o++] = (char)(hexval(s[i + 1]) * 16 + hexval(s[i + 2]));
            i += 2;
        } else if (s[i] == '+' && plus_is_space) {
            out[o++] = ' ';
        } else {
            out[o++] = s[i];
        }
    }
    out[o] = '\0';
    return out;
}

// ---------------------------------------------------------------- transport

static void conn_close(s3 *c) {
    if (c->ssl) {
        SSL_free(c->ssl);
        c->ssl = nullptr;
    }
    if (c->fd >= 0) {
        close(c->fd);
        c->fd = -1;
    }
    c->rpos = c->rlen = 0;
    c->reused = false;
}

static int tcp_connect(const char *host, const char *port, char *err, size_t errsz) {
    struct addrinfo hints = {.ai_family = AF_UNSPEC, .ai_socktype = SOCK_STREAM};
    struct addrinfo *list = nullptr;
    int g = getaddrinfo(host, port, &hints, &list);
    if (g != 0) {
        snprintf(err, errsz, "cannot resolve %s: %s", host, gai_strerror(g));
        return -1;
    }
    int fd = -1;
    snprintf(err, errsz, "cannot connect to %s:%s", host, port);
    double deadline = now_monotonic() + CONNECT_TIMEOUT_MS / 1000.0;
    for (struct addrinfo *ai = list; ai; ai = ai->ai_next) {
        fd = socket(ai->ai_family, ai->ai_socktype | SOCK_NONBLOCK | SOCK_CLOEXEC, ai->ai_protocol);
        if (fd < 0) continue;
        int r = connect(fd, ai->ai_addr, ai->ai_addrlen);
        if (r < 0 && errno == EINPROGRESS) {
            double left = deadline - now_monotonic();
            struct pollfd pfd = {.fd = fd, .events = POLLOUT};
            int pr = left > 0 ? poll(&pfd, 1, (int)(left * 1000)) : 0;
            int soerr = 0;
            socklen_t sl = sizeof soerr;
            if (pr == 1 && getsockopt(fd, SOL_SOCKET, SO_ERROR, &soerr, &sl) == 0 && soerr == 0) {
                r = 0;
            } else {
                snprintf(err, errsz, "cannot connect to %s:%s: %s", host, port,
                         pr == 0 ? "timed out" : strerror(soerr ? soerr : errno));
                r = -1;
            }
        } else if (r < 0) {
            snprintf(err, errsz, "cannot connect to %s:%s: %s", host, port, strerror(errno));
        }
        if (r == 0) break;
        close(fd);
        fd = -1;
    }
    freeaddrinfo(list);
    if (fd < 0) return -1;
    err[0] = '\0';
    int fl = fcntl(fd, F_GETFL);
    fcntl(fd, F_SETFL, fl & ~O_NONBLOCK);
    struct timeval tv = {.tv_sec = IDLE_TIMEOUT_S};
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
    return fd;
}

static int plain_write_all(int fd, const char *p, size_t n) {
    while (n) {
        ssize_t w = send(fd, p, n, MSG_NOSIGNAL);
        if (w < 0 && errno == EINTR) continue;
        if (w <= 0) return -1;
        p += w;
        n -= (size_t)w;
    }
    return 0;
}

// Ask the proxy for a tunnel to host:443. 0 ok, -1 worth retrying, -2 refused for good.
static int proxy_tunnel(s3 *c, int fd, char *err, size_t errsz) {
    buf rq = {};
    buf_printf(&rq, "CONNECT %s:443 HTTP/1.1\r\nHost: %s:443\r\n", c->host, c->host);
    if (c->proxy_auth) buf_printf(&rq, "Proxy-Authorization: Basic %s\r\n", c->proxy_auth);
    buf_puts(&rq, "\r\n");
    int w = plain_write_all(fd, rq.p, rq.n);
    buf_free(&rq);
    if (w < 0) {
        snprintf(err, errsz, "the proxy closed the connection");
        return -1;
    }
    // The proxy says nothing after its header until we speak TLS, but read a byte at a time
    // all the same, so nothing of the tunnel's is swallowed here.
    char head[4096];
    size_t n = 0;
    while (n < sizeof head - 1) {
        ssize_t r = recv(fd, head + n, 1, 0);
        if (r < 0 && errno == EINTR) continue;
        if (r <= 0) {
            snprintf(err, errsz, "the proxy closed the connection before answering CONNECT");
            return -1;
        }
        n++;
        if (n >= 4 && memcmp(head + n - 4, "\r\n\r\n", 4) == 0) break;
    }
    head[n] = '\0';
    int status = 0;
    if (sscanf(head, "HTTP/%*d.%*d %d", &status) != 1) {
        snprintf(err, errsz, "the proxy answered CONNECT with something that is not HTTP");
        return -1;
    }
    if (status != 200) {
        head[strcspn(head, "\r\n")] = '\0';
        snprintf(err, errsz, "the proxy refused a tunnel to %.200s: %.200s", c->host, head);
        return status >= 500 ? -1 : -2;
    }
    return 0;
}

// 0 ok, -1 worth retrying, -2 not worth retrying.
static int conn_open(s3 *c, char *err, size_t errsz) {
    conn_close(c);
    int fd = c->proxy_host ? tcp_connect(c->proxy_host, c->proxy_port, err, errsz)
                           : tcp_connect(c->host, "443", err, errsz);
    if (fd < 0) return -1;
    if (c->proxy_host) {
        int r = proxy_tunnel(c, fd, err, errsz);
        if (r != 0) {
            close(fd);
            return r;
        }
    }
    SSL *ssl = SSL_new(c->ctx);
    if (!ssl) die("SSL_new failed");
    SSL_set_fd(ssl, fd);
    SSL_set_tlsext_host_name(ssl, c->host);
    SSL_set1_host(ssl, c->host); // the certificate must be for this host
    ERR_clear_error();
    if (SSL_connect(ssl) != 1) {
        long v = SSL_get_verify_result(ssl);
        int rc = -1;
        if (v != X509_V_OK) {
            snprintf(err, errsz, "TLS: the certificate of %s was not accepted: %s", c->host,
                     X509_verify_cert_error_string(v));
            rc = -2;
        } else {
            unsigned long e = ERR_peek_last_error();
            snprintf(err, errsz, "TLS handshake with %s failed: %s", c->host,
                     e ? ERR_reason_error_string(e) : "connection dropped");
        }
        SSL_free(ssl);
        close(fd);
        return rc;
    }
    c->ssl = ssl;
    c->fd = fd;
    c->rpos = c->rlen = 0;
    c->reused = false;
    if (c->debug)
        fprintf(stderr, "  [http] connected to %s%s, %s\n", c->host, c->proxy_host ? " through the proxy" : "",
                SSL_get_version(ssl));
    return 0;
}

static int conn_write_all(s3 *c, const char *p, size_t n) {
    while (n) {
        int w = SSL_write(c->ssl, p, n > (1 << 30) ? (1 << 30) : (int)n);
        if (w <= 0) return -1;
        p += w;
        n -= (size_t)w;
    }
    return 0;
}

// Refill the read buffer. >0 bytes read, 0 the peer closed, -1 dropped or timed out.
static int conn_fill(s3 *c) {
    c->rpos = c->rlen = 0;
    int r = SSL_read(c->ssl, c->rb, (int)sizeof c->rb);
    if (r > 0) {
        c->rlen = (size_t)r;
        return r;
    }
    int e = SSL_get_error(c->ssl, r);
    return e == SSL_ERROR_ZERO_RETURN ? 0 : -1;
}

// One line of the response head, without its CRLF. -1 dropped; *any says whether a byte
// of the response had arrived by then.
static int conn_getline(s3 *c, buf *line, bool *any) {
    line->n = 0;
    for (;;) {
        if (c->rpos == c->rlen) {
            if (conn_fill(c) <= 0) return -1;
        }
        *any = true;
        unsigned char ch = c->rb[c->rpos++];
        if (ch == '\n') {
            if (line->n && line->p[line->n - 1] == '\r') line->n--;
            buf_cstr(line);
            return 0;
        }
        if (line->n >= MAX_HEADER_LINE) return -1;
        buf_putc(line, (char)ch);
    }
}

// ---------------------------------------------------------------- HTTP

typedef struct {
    s3_sink *sink; // null: into res->body
    s3_result *res;
} body_dest;

static int deliver(body_dest *d, const unsigned char *p, size_t n) {
    if (d->sink) return d->sink->data(d->sink->ud, p, n) ? -2 : 0;
    buf_add(&d->res->body, p, n);
    return 0;
}

// Exactly n bytes of body. 0 ok, -1 dropped, -2 the sink refused.
static int read_exact(s3 *c, unsigned long long n, body_dest *d) {
    while (n) {
        if (c->rpos == c->rlen) {
            if (conn_fill(c) <= 0) return -1;
        }
        size_t take = c->rlen - c->rpos;
        if (take > n) take = (size_t)n;
        int r = deliver(d, c->rb + c->rpos, take);
        if (r) return r;
        c->rpos += take;
        n -= take;
    }
    return 0;
}

static int read_chunked(s3 *c, body_dest *d) {
    buf line = {};
    bool any = true;
    int rc = -1;
    for (;;) {
        if (conn_getline(c, &line, &any) < 0) break;
        char *end;
        errno = 0;
        unsigned long long size = strtoull(line.p, &end, 16);
        if (end == line.p || errno) break;
        if (size == 0) { // the last chunk, then trailers up to an empty line
            for (;;) {
                if (conn_getline(c, &line, &any) < 0) goto out;
                if (line.n == 0) break;
            }
            rc = 0;
            break;
        }
        int r = read_exact(c, size, d);
        if (r) {
            rc = r;
            break;
        }
        if (conn_getline(c, &line, &any) < 0 || line.n != 0) break; // the CRLF after the data
    }
out:
    buf_free(&line);
    return rc;
}

static int read_to_close(s3 *c, body_dest *d) {
    for (;;) {
        if (c->rpos < c->rlen) {
            int r = deliver(d, c->rb + c->rpos, c->rlen - c->rpos);
            if (r) return r;
        }
        int f = conn_fill(c);
        if (f == 0) return 0;
        if (f < 0) return -1;
    }
}

// S3's error body: <Error><Code>…</Code>…</Error>. Expat decides whether it is XML at all.
typedef struct {
    int depth;
    char names[8][40];
    buf text;
    char code[64];
    // listing
    s3_list_cb cb;
    void *ud;
    bool truncated;
    char *next_token;
} xml_state;

static void xml_start(void *ud, const XML_Char *name, const XML_Char **atts) {
    (void)atts;
    xml_state *x = ud;
    if (x->depth < 8) snprintf(x->names[x->depth], sizeof x->names[0], "%s", name);
    x->depth++;
    x->text.n = 0;
}

static void xml_text(void *ud, const XML_Char *s, int len) {
    xml_state *x = ud;
    buf_add(&x->text, s, (size_t)len);
}

static void xml_end(void *ud, const XML_Char *name) {
    xml_state *x = ud;
    x->depth--;
    const char *parent = (x->depth >= 1 && x->depth <= 8) ? x->names[x->depth - 1] : "";
    const char *text = buf_cstr(&x->text);
    if (x->depth == 1 && strcmp(parent, "Error") == 0 && strcmp(name, "Code") == 0) {
        snprintf(x->code, sizeof x->code, "%s", text);
    } else if (x->depth == 1 && strcmp(parent, "ListBucketResult") == 0) {
        if (strcmp(name, "IsTruncated") == 0) {
            x->truncated = strcmp(text, "true") == 0;
        } else if (strcmp(name, "NextContinuationToken") == 0) {
            free(x->next_token);
            x->next_token = xstrdup(text);
        }
    } else if (x->depth == 2 && x->cb) {
        bool key = strcmp(parent, "Contents") == 0 && strcmp(name, "Key") == 0;
        bool prefix = strcmp(parent, "CommonPrefixes") == 0 && strcmp(name, "Prefix") == 0;
        if (key || prefix) {
            char *decoded = url_decode(x->text.p, x->text.n, true);
            x->cb(x->ud, decoded, prefix);
            free(decoded);
        }
    }
    x->text.n = 0;
}

// True when the bytes are one well-formed XML document.
static bool xml_parse(xml_state *x, const char *p, size_t n) {
    XML_Parser parser = XML_ParserCreate(nullptr);
    if (!parser) die("XML_ParserCreate failed");
    XML_SetUserData(parser, x);
    XML_SetElementHandler(parser, xml_start, xml_end);
    XML_SetCharacterDataHandler(parser, xml_text);
    bool ok = n <= INT32_MAX && XML_Parse(parser, p, (int)n, 1) == XML_STATUS_OK;
    XML_ParserFree(parser);
    buf_free(&x->text);
    return ok;
}

bool s3_error_body(const char *body, size_t n, char code[64]) {
    xml_state x = {};
    bool ok = n == 0 || xml_parse(&x, body, n);
    snprintf(code, 64, "%s", ok ? x.code : "");
    free(x.next_token);
    return ok;
}

// One request, one response. 0 a whole response was read, -1 dropped, -2 the sink refused.
static int http_once(s3 *c, const char *target, const buf *headers, s3_sink *sink, s3_result *res,
                     bool *got_bytes) {
    *got_bytes = false;
    buf rq = {};
    buf_printf(&rq, "GET %s HTTP/1.1\r\n", target);
    buf_add(&rq, headers->p, headers->n);
    buf_puts(&rq, "\r\n");
    c->requests++;
    int w = conn_write_all(c, rq.p, rq.n);
    buf_free(&rq);
    if (w < 0) return -1;

    buf line = {};
    int rc = -1;
    long long content_length = -1;
    bool chunked = false, closing = false;
    int major = 0, minor = 0, status = 0;
    c->bucket_region[0] = '\0';

    if (conn_getline(c, &line, got_bytes) < 0) goto out;
    if (sscanf(line.p, "HTTP/%d.%d %d", &major, &minor, &status) != 3 || status < 100 || status > 599) goto out;
    if (major == 1 && minor == 0) closing = true;
    for (;;) {
        if (conn_getline(c, &line, got_bytes) < 0) goto out;
        if (line.n == 0) break;
        if (c->debug && status != 200) fprintf(stderr, "  [http]   %d: %.300s\n", status, line.p);
        char *colon = strchr(line.p, ':');
        if (!colon) continue;
        *colon = '\0';
        const char *value = colon + 1;
        while (*value == ' ' || *value == '\t') value++;
        if (strcasecmp(line.p, "content-length") == 0) {
            char *end;
            errno = 0;
            content_length = strtoll(value, &end, 10);
            if (end == value || errno || content_length < 0) goto out;
        } else if (strcasecmp(line.p, "transfer-encoding") == 0) {
            chunked = strcasestr(value, "chunked") != nullptr;
        } else if (strcasecmp(line.p, "connection") == 0) {
            if (strcasestr(value, "close")) closing = true;
        } else if (strcasecmp(line.p, "x-amz-bucket-region") == 0) {
            snprintf(c->bucket_region, sizeof c->bucket_region, "%s", value);
        }
    }
    res->status = status;
    if (c->debug) fprintf(stderr, "  [http] GET %.200s -> %d\n", target, status);

    body_dest dest = {.sink = (status == 200) ? sink : nullptr, .res = res};
    if (dest.sink && dest.sink->begin(dest.sink->ud)) {
        rc = -2;
        goto out;
    }
    int r;
    if (status == 204 || status == 304)
        r = 0;
    else if (chunked)
        r = read_chunked(c, &dest);
    else if (content_length >= 0)
        r = read_exact(c, (unsigned long long)content_length, &dest);
    else {
        r = read_to_close(c, &dest);
        closing = true;
    }
    if (r) {
        rc = r;
        goto out;
    }
    if (status != 200) {
        if (c->debug) fprintf(stderr, "  [http]   body: %.600s\n", res->body.n ? res->body.p : "(empty)");
        res->body_ok = s3_error_body(res->body.p, res->body.n, res->code);
    }
    c->reused = true;
    if (closing) conn_close(c);
    rc = 0;
out:
    buf_free(&line);
    return rc;
}

// ---------------------------------------------------------------- Signature Version 4

static void hmac_sha256(const void *key, size_t keylen, const char *data, unsigned char out[32]) {
    unsigned int outlen = 32;
    if (!HMAC(EVP_sha256(), key, (int)keylen, (const unsigned char *)data, strlen(data), out, &outlen))
        die("HMAC failed");
}

static void sha256_hex(const char *data, size_t n, char out[65]) {
    unsigned char md[32];
    unsigned int mdlen = 32;
    if (!EVP_Digest(data, n, md, &mdlen, EVP_sha256(), nullptr)) die("SHA-256 failed");
    hex_encode(md, 32, out);
}

// Sign a GET of canonical_uri?canonical_query with an empty body, and write the request's
// header lines into `headers`. Both arguments are already in canonical (encoded) form, and
// the query's parameters already sorted by name.
static void sign_get(const s3 *c, const char *canonical_uri, const char *canonical_query, buf *headers) {
    time_t now = time(nullptr);
    struct tm tm;
    gmtime_r(&now, &tm);
    char amzdate[17], date[9];
    strftime(amzdate, sizeof amzdate, "%Y%m%dT%H%M%SZ", &tm);
    strftime(date, sizeof date, "%Y%m%d", &tm);

    // Canonical headers: lowercase names, in name order, each value trimmed, each ending LF.
    buf canonical = {};
    buf_printf(&canonical, "GET\n%s\n%s\n", canonical_uri, canonical_query);
    buf_printf(&canonical, "host:%s\n", c->host);
    buf_printf(&canonical, "x-amz-content-sha256:%s\n", EMPTY_SHA256);
    buf_printf(&canonical, "x-amz-date:%s\n", amzdate);
    const char *signed_headers = "host;x-amz-content-sha256;x-amz-date";
    if (c->token) {
        buf_printf(&canonical, "x-amz-security-token:%s\n", c->token);
        signed_headers = "host;x-amz-content-sha256;x-amz-date;x-amz-security-token";
    }
    buf_printf(&canonical, "\n%s\n%s", signed_headers, EMPTY_SHA256);

    char canonical_hash[65];
    sha256_hex(canonical.p, canonical.n, canonical_hash);
    buf_free(&canonical);

    buf scope = {}, to_sign = {};
    buf_printf(&scope, "%s/%s/s3/aws4_request", date, c->region);
    buf_printf(&to_sign, "AWS4-HMAC-SHA256\n%s\n%s\n%s", amzdate, scope.p, canonical_hash);

    buf key0 = {};
    buf_printf(&key0, "AWS4%s", c->secret);
    unsigned char k_date[32], k_region[32], k_service[32], k_signing[32], sig[32];
    hmac_sha256(key0.p, key0.n, date, k_date);
    hmac_sha256(k_date, 32, c->region, k_region);
    hmac_sha256(k_region, 32, "s3", k_service);
    hmac_sha256(k_service, 32, "aws4_request", k_signing);
    hmac_sha256(k_signing, 32, to_sign.p, sig);
    OPENSSL_cleanse(key0.p, key0.n);
    buf_free(&key0);
    char sig_hex[65];
    hex_encode(sig, 32, sig_hex);

    buf_printf(headers, "Host: %s\r\n", c->host);
    buf_printf(headers, "x-amz-content-sha256: %s\r\n", EMPTY_SHA256);
    buf_printf(headers, "x-amz-date: %s\r\n", amzdate);
    if (c->token) buf_printf(headers, "x-amz-security-token: %s\r\n", c->token);
    buf_printf(headers, "Authorization: AWS4-HMAC-SHA256 Credential=%s/%s, SignedHeaders=%s, Signature=%s\r\n",
               c->access, scope.p, signed_headers, sig_hex);
    buf_free(&scope);
    buf_free(&to_sign);
}

// ---------------------------------------------------------------- S3

static void set_endpoint(s3 *c) {
    free(c->host);
    buf b = {};
    if (c->path_style)
        buf_printf(&b, "s3.%s.amazonaws.com", c->region);
    else
        buf_printf(&b, "%s.s3.%s.amazonaws.com", c->bucket, c->region);
    c->host = buf_cstr(&b);
}

static void result_reset(s3_result *res) {
    res->status = 0;
    res->body.n = 0;
    res->code[0] = '\0';
    res->body_ok = false;
    res->err[0] = '\0';
}

void s3_result_free(s3_result *res) {
    buf_free(&res->body);
    *res = (s3_result){};
}

static int s3_request(s3 *c, const char *key, const char *canonical_query, s3_sink *sink, s3_result *res) {
    double dropped_ceiling = 0.5, server_ceiling = 0.1;
    double first_drop = 0;
    int attempts_5xx = 0;
    bool followed_redirect = false, stale_retried = false;

    for (;;) {
        buf uri = {}, target = {}, headers = {};
        buf_putc(&uri, '/');
        if (c->path_style) {
            uri_encode(&uri, c->bucket, strlen(c->bucket), false);
            if (*key) buf_putc(&uri, '/');
        }
        uri_encode(&uri, key, strlen(key), true);
        buf_puts(&target, buf_cstr(&uri));
        if (*canonical_query) buf_printf(&target, "?%s", canonical_query);
        sign_get(c, uri.p, canonical_query, &headers);

        result_reset(res);
        bool was_reused = c->ssl && c->reused;
        bool got_bytes = false;
        int r = 0;
        if (!c->ssl) {
            r = conn_open(c, res->err, sizeof res->err);
            if (r == -2) {
                buf_free(&uri), buf_free(&target), buf_free(&headers);
                return S3_TRANSPORT;
            }
        }
        if (r == 0) {
            r = http_once(c, target.p, &headers, sink, res, &got_bytes);
            if (r == -1) {
                snprintf(res->err, sizeof res->err, "the connection to %s was dropped%s", c->host,
                         got_bytes ? " in mid-response" : "");
                conn_close(c);
            }
        }
        buf_free(&uri), buf_free(&target), buf_free(&headers);
        if (r == -2) {
            conn_close(c);
            snprintf(res->err, sizeof res->err, "could not write what was downloaded");
            return S3_LOCAL;
        }
        if (r == -1) {
            // A kept-alive connection the server had already closed says nothing: once, go
            // straight round again on a new one.
            if (was_reused && !got_bytes && !stale_retried) {
                stale_retried = true;
                continue;
            }
            double now = now_monotonic();
            if (first_drop == 0) first_drop = now;
            if (now - first_drop >= DROPPED_RETRY_S) return S3_TRANSPORT;
            if (c->debug) fprintf(stderr, "  [http] %s; retrying\n", res->err);
            sleep_random_under(dropped_ceiling);
            dropped_ceiling = dropped_ceiling * 2 > 2.0 ? 2.0 : dropped_ceiling * 2;
            continue;
        }
        stale_retried = false;
        if (res->status == 301 && !followed_redirect && c->bucket_region[0] &&
            strcmp(c->bucket_region, c->region) != 0) {
            // The bucket lives in another region: sign for that one and ask there.
            followed_redirect = true;
            free(c->region);
            c->region = xstrdup(c->bucket_region);
            set_endpoint(c);
            conn_close(c);
            continue;
        }
        if (res->status >= 500) {
            if (++attempts_5xx >= MAX_5XX_ATTEMPTS) return S3_OK;
            bool throttled = res->status == 503 || strcmp(res->code, "SlowDown") == 0;
            double ceiling = (throttled && server_ceiling < 0.5) ? 0.5 : server_ceiling;
            sleep_random_under(ceiling);
            server_ceiling = server_ceiling * 2 > 20.0 ? 20.0 : server_ceiling * 2;
            continue;
        }
        return S3_OK;
    }
}

int s3_get(s3 *c, const char *key, s3_sink *sink, s3_result *res) { return s3_request(c, key, "", sink, res); }

int s3_list(s3 *c, const char *prefix, const char *delimiter, s3_list_cb cb, void *ud, s3_result *res) {
    char *token = nullptr;
    for (;;) {
        // The canonical query string: parameters in name order, names and values encoded.
        buf q = {};
        if (token) {
            buf_puts(&q, "continuation-token=");
            uri_encode(&q, token, strlen(token), false);
            buf_putc(&q, '&');
        }
        if (delimiter) {
            buf_puts(&q, "delimiter=");
            uri_encode(&q, delimiter, strlen(delimiter), false);
            buf_putc(&q, '&');
        }
        buf_puts(&q, "encoding-type=url&list-type=2");
        if (c->max_keys > 0) buf_printf(&q, "&max-keys=%d", c->max_keys);
        buf_puts(&q, "&prefix=");
        uri_encode(&q, prefix, strlen(prefix), false);
        free(token);
        token = nullptr;

        int r = s3_request(c, "", buf_cstr(&q), nullptr, res);
        buf_free(&q);
        if (r != S3_OK) return r;
        if (res->status != 200) return S3_OK;

        xml_state x = {.cb = cb, .ud = ud};
        if (!xml_parse(&x, res->body.p, res->body.n)) {
            free(x.next_token);
            snprintf(res->err, sizeof res->err, "the listing of %s is not well-formed XML", prefix);
            return S3_TRANSPORT;
        }
        if (!x.truncated) {
            free(x.next_token);
            return S3_OK;
        }
        if (!x.next_token || !*x.next_token) {
            free(x.next_token);
            snprintf(res->err, sizeof res->err, "the listing of %s is truncated but names no next page", prefix);
            return S3_TRANSPORT;
        }
        token = x.next_token;
    }
}

unsigned long s3_request_count(const s3 *c) { return c->requests; }

// ---------------------------------------------------------------- setup

static char *percent_decode_dup(const char *s, size_t n) { return url_decode(s, n, false); }

// HTTPS_PROXY=http://[user:pass@]host[:port][/]
static void parse_proxy(s3 *c) {
    const char *p = getenv("HTTPS_PROXY");
    if (!p || !*p) p = getenv("https_proxy");
    if (!p || !*p) return;
    const char *scheme_end = strstr(p, "://");
    if (scheme_end) {
        if (strncasecmp(p, "http://", 7) != 0) die("HTTPS_PROXY: only an http:// proxy is supported");
        p = scheme_end + 3;
    }
    size_t alen = strcspn(p, "/");
    const char *at = nullptr;
    for (size_t i = 0; i < alen; i++)
        if (p[i] == '@') at = p + i;
    if (at) {
        const char *colon = memchr(p, ':', (size_t)(at - p));
        char *user = percent_decode_dup(p, colon ? (size_t)(colon - p) : (size_t)(at - p));
        char *pass = colon ? percent_decode_dup(colon + 1, (size_t)(at - colon - 1)) : xstrdup("");
        buf up = {};
        buf_printf(&up, "%s:%s", user, pass);
        c->proxy_auth = xmalloc(4 * ((up.n + 2) / 3) + 1);
        EVP_EncodeBlock((unsigned char *)c->proxy_auth, (const unsigned char *)up.p, (int)up.n);
        OPENSSL_cleanse(up.p, up.n);
        buf_free(&up);
        free(user);
        free(pass);
        alen -= (size_t)(at + 1 - p);
        p = at + 1;
    }
    const char *host = p, *host_end, *port = nullptr;
    if (*p == '[') { // an IPv6 literal
        host = p + 1;
        host_end = memchr(p, ']', alen);
        if (!host_end) die("HTTPS_PROXY: unreadable host");
        if (host_end + 1 < p + alen && host_end[1] == ':') port = host_end + 2;
    } else {
        host_end = memchr(p, ':', alen);
        if (host_end)
            port = host_end + 1;
        else
            host_end = p + alen;
    }
    c->proxy_host = xmemdup0(host, (size_t)(host_end - host));
    c->proxy_port = port ? xmemdup0(port, (size_t)(p + alen - port)) : xstrdup("80");
    if (!*c->proxy_host) die("HTTPS_PROXY: unreadable host");
}

static char *env_dup(const char *name) {
    const char *v = getenv(name);
    return (v && *v) ? xstrdup(v) : nullptr;
}

s3 *s3_open(const char *bucket) {
    s3 *c = xcalloc(1, sizeof *c);
    c->fd = -1;
    c->bucket = xstrdup(bucket);
    c->access = env_dup("AWS_ACCESS_KEY_ID");
    c->secret = env_dup("AWS_SECRET_ACCESS_KEY");
    c->token = env_dup("AWS_SESSION_TOKEN");
    if (!c->access || !c->secret) die("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set in the environment");
    c->region = env_dup("AWS_REGION");
    if (!c->region) c->region = env_dup("AWS_DEFAULT_REGION");
    if (!c->region) c->region = xstrdup("us-east-1");
    // A bucket name with a dot can't be a host name under the endpoint's wildcard
    // certificate, so it goes in the path instead.
    c->path_style = strchr(bucket, '.') != nullptr;
    set_endpoint(c);
    parse_proxy(c);

    const char *mk = getenv("S3CAB_RESTORE_MAX_KEYS");
    c->max_keys = mk ? atoi(mk) : 0;
    c->debug = getenv("S3CAB_RESTORE_DEBUG") != nullptr;

    signal(SIGPIPE, SIG_IGN);
    srandom((unsigned)time(nullptr) ^ (unsigned)getpid());
    c->ctx = SSL_CTX_new(TLS_client_method());
    if (!c->ctx) die("SSL_CTX_new failed");
    SSL_CTX_set_min_proto_version(c->ctx, TLS1_2_VERSION);
    SSL_CTX_set_verify(c->ctx, SSL_VERIFY_PEER, nullptr);
    if (SSL_CTX_set_default_verify_paths(c->ctx) != 1) die("cannot load the system's CA certificates");
    return c;
}

void s3_close(s3 *c) {
    if (!c) return;
    conn_close(c);
    SSL_CTX_free(c->ctx);
    if (c->secret) OPENSSL_cleanse(c->secret, strlen(c->secret));
    free(c->access), free(c->secret), free(c->token), free(c->region), free(c->bucket), free(c->host);
    free(c->proxy_host), free(c->proxy_port), free(c->proxy_auth);
    free(c);
}
