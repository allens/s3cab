/* A small HTTP/1.1 client over TLS (OpenSSL), with CONNECT-proxy support.
 * Enough for GETs with Content-Length or chunked bodies, and keep-alive. */
#include "common.h"
#include <errno.h>
#include <unistd.h>
#include <ctype.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <openssl/ssl.h>
#include <openssl/err.h>

#define IO_TIMEOUT_SEC 30
#define CONNECT_TIMEOUT_SEC 10

struct http_conn {
    int fd;
    SSL_CTX *ctx;
    SSL *ssl;
    char *host;
    int port;
    /* bytes read from the socket but not yet consumed (pipelined leftovers) */
    buf_t rbuf;
    size_t rpos;
};

static SSL_CTX *g_ctx;

static void set_err(char *err, size_t errlen, const char *fmt, ...) __attribute__((format(printf, 3, 4)));
static void set_err(char *err, size_t errlen, const char *fmt, ...) {
    if (!err || !errlen) return;
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(err, errlen, fmt, ap);
    va_end(ap);
}

static const char *ssl_errstr(void) {
    static char b[256];
    unsigned long e = ERR_get_error();
    if (!e) return "unknown TLS error";
    ERR_error_string_n(e, b, sizeof b);
    ERR_clear_error();
    return b;
}

/* Base64 for the proxy's Basic credentials. */
static char *base64(const unsigned char *in, size_t n) {
    static const char tbl[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    char *out = xmalloc(((n + 2) / 3) * 4 + 1);
    size_t o = 0;
    for (size_t i = 0; i < n; i += 3) {
        uint32_t v = (uint32_t)in[i] << 16;
        if (i + 1 < n) v |= (uint32_t)in[i + 1] << 8;
        if (i + 2 < n) v |= in[i + 2];
        out[o++] = tbl[(v >> 18) & 63];
        out[o++] = tbl[(v >> 12) & 63];
        out[o++] = i + 1 < n ? tbl[(v >> 6) & 63] : '=';
        out[o++] = i + 2 < n ? tbl[v & 63] : '=';
    }
    out[o] = 0;
    return out;
}

static int hexval(int c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static char *pct_decode(const char *s, size_t n) {
    char *out = xmalloc(n + 1);
    size_t o = 0;
    for (size_t i = 0; i < n; i++) {
        if (s[i] == '%' && i + 2 < n + 0 && hexval(s[i + 1]) >= 0 && hexval(s[i + 2]) >= 0) {
            out[o++] = (char)(hexval(s[i + 1]) * 16 + hexval(s[i + 2]));
            i += 2;
        } else out[o++] = s[i];
    }
    out[o] = 0;
    return out;
}

/* Parse http://[user[:pass]@]host[:port] */
typedef struct { char *user, *pass, *host; int port; } proxy_t;
static bool parse_proxy(const char *url, proxy_t *p, char *err, size_t errlen) {
    memset(p, 0, sizeof *p);
    const char *s = url;
    if (!strncmp(s, "http://", 7)) s += 7;
    else if (!strncmp(s, "https://", 8)) { set_err(err, errlen, "TLS to the proxy itself is not supported"); return false; }
    else if (strstr(s, "://")) { set_err(err, errlen, "unsupported proxy scheme in %s", url); return false; }
    const char *end = s + strcspn(s, "/");
    const char *at = NULL;
    for (const char *q = s; q < end; q++) if (*q == '@') at = q;
    if (at) {
        const char *colon = memchr(s, ':', (size_t)(at - s));
        if (colon) { p->user = pct_decode(s, (size_t)(colon - s)); p->pass = pct_decode(colon + 1, (size_t)(at - colon - 1)); }
        else { p->user = pct_decode(s, (size_t)(at - s)); p->pass = xstrdup(""); }
        s = at + 1;
    }
    const char *colon = memchr(s, ':', (size_t)(end - s));
    if (colon) { p->host = xstrndup(s, (size_t)(colon - s)); p->port = atoi(colon + 1); }
    else { p->host = xstrndup(s, (size_t)(end - s)); p->port = 3128; }
    if (!*p->host || p->port <= 0) { set_err(err, errlen, "bad proxy URL %s", url); return false; }
    return true;
}
static void free_proxy(proxy_t *p) { free(p->user); free(p->pass); free(p->host); }

static int tcp_connect(const char *host, int port, char *err, size_t errlen) {
    struct addrinfo hints = {0}, *res = NULL;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_family = AF_UNSPEC;
    char ports[16];
    snprintf(ports, sizeof ports, "%d", port);
    int rc = getaddrinfo(host, ports, &hints, &res);
    if (rc) { set_err(err, errlen, "resolving %s: %s", host, gai_strerror(rc)); return -1; }
    int fd = -1;
    for (struct addrinfo *ai = res; ai; ai = ai->ai_next) {
        fd = socket(ai->ai_family, ai->ai_socktype | SOCK_CLOEXEC, ai->ai_protocol);
        if (fd < 0) continue;
        struct timeval tv = { CONNECT_TIMEOUT_SEC, 0 };
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
        if (connect(fd, ai->ai_addr, ai->ai_addrlen) == 0) {
            tv.tv_sec = IO_TIMEOUT_SEC;
            setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
            setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
            int one = 1;
            setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
            break;
        }
        set_err(err, errlen, "connecting to %s:%d: %s", host, port, strerror(errno));
        close(fd);
        fd = -1;
    }
    if (fd < 0 && !(err && *err)) set_err(err, errlen, "connecting to %s:%d failed", host, port);
    freeaddrinfo(res);
    return fd;
}

/* Plain-socket helpers used for the CONNECT handshake. */
static bool write_all_fd(int fd, const void *p, size_t n) {
    const unsigned char *q = p;
    while (n) {
        ssize_t w = write(fd, q, n);
        if (w < 0) { if (errno == EINTR) continue; return false; }
        q += (size_t)w; n -= (size_t)w;
    }
    return true;
}

static bool proxy_connect(int fd, const proxy_t *px, const char *host, int port, char *err, size_t errlen) {
    buf_t req; buf_init(&req);
    buf_appendf(&req, "CONNECT %s:%d HTTP/1.1\r\nHost: %s:%d\r\n", host, port, host, port);
    if (px->user) {
        buf_t cred; buf_init(&cred);
        buf_appendf(&cred, "%s:%s", px->user, px->pass ? px->pass : "");
        char *b64 = base64(cred.p, cred.len);
        buf_appendf(&req, "Proxy-Authorization: Basic %s\r\n", b64);
        free(b64); buf_free(&cred);
    }
    buf_appendstr(&req, "Proxy-Connection: Keep-Alive\r\n\r\n");
    bool ok = write_all_fd(fd, req.p, req.len);
    buf_free(&req);
    if (!ok) { set_err(err, errlen, "writing CONNECT to proxy: %s", strerror(errno)); return false; }
    /* Read the proxy's reply headers byte by byte up to the blank line, so
     * that nothing of the TLS exchange is swallowed. */
    buf_t rep; buf_init(&rep);
    for (;;) {
        unsigned char c;
        ssize_t r = read(fd, &c, 1);
        if (r <= 0) { set_err(err, errlen, "reading CONNECT reply: %s", r ? strerror(errno) : "connection closed"); buf_free(&rep); return false; }
        buf_append(&rep, &c, 1);
        if (rep.len >= 4 && !memcmp(rep.p + rep.len - 4, "\r\n\r\n", 4)) break;
        if (rep.len > 65536) { set_err(err, errlen, "CONNECT reply too long"); buf_free(&rep); return false; }
    }
    int code = 0;
    if (sscanf((char *)rep.p, "HTTP/%*d.%*d %d", &code) != 1 || code != 200) {
        char *eol = strstr((char *)rep.p, "\r\n");
        if (eol) *eol = 0;
        set_err(err, errlen, "proxy refused CONNECT: %s", (char *)rep.p);
        buf_free(&rep);
        return false;
    }
    buf_free(&rep);
    return true;
}

http_conn *http_open(const char *host, int port, const char *proxy_url, char *err, size_t errlen) {
    if (err && errlen) err[0] = 0;
    if (!g_ctx) {
        g_ctx = SSL_CTX_new(TLS_client_method());
        if (!g_ctx) { set_err(err, errlen, "SSL_CTX_new: %s", ssl_errstr()); return NULL; }
        SSL_CTX_set_min_proto_version(g_ctx, TLS1_2_VERSION);
        SSL_CTX_set_verify(g_ctx, SSL_VERIFY_PEER, NULL);
        if (!SSL_CTX_set_default_verify_paths(g_ctx)) { set_err(err, errlen, "loading CA certificates: %s", ssl_errstr()); return NULL; }
        SSL_CTX_set_mode(g_ctx, SSL_MODE_AUTO_RETRY);
    }
    int fd;
    if (proxy_url && *proxy_url) {
        proxy_t px;
        if (!parse_proxy(proxy_url, &px, err, errlen)) return NULL;
        fd = tcp_connect(px.host, px.port, err, errlen);
        if (fd >= 0 && !proxy_connect(fd, &px, host, port, err, errlen)) { close(fd); fd = -1; }
        free_proxy(&px);
    } else {
        fd = tcp_connect(host, port, err, errlen);
    }
    if (fd < 0) return NULL;
    SSL *ssl = SSL_new(g_ctx);
    if (!ssl) { set_err(err, errlen, "SSL_new: %s", ssl_errstr()); close(fd); return NULL; }
    SSL_set_tlsext_host_name(ssl, host);
    SSL_set1_host(ssl, host);
    SSL_set_fd(ssl, fd);
    int rc = SSL_connect(ssl);
    if (rc != 1) {
        int e = SSL_get_error(ssl, rc);
        long vr = SSL_get_verify_result(ssl);
        if (vr != X509_V_OK) set_err(err, errlen, "TLS certificate for %s not trusted: %s", host, X509_verify_cert_error_string(vr));
        else set_err(err, errlen, "TLS handshake with %s failed (%d): %s", host, e, ssl_errstr());
        SSL_free(ssl); close(fd);
        return NULL;
    }
    http_conn *c = xmalloc(sizeof *c);
    c->fd = fd; c->ssl = ssl; c->ctx = g_ctx; c->host = xstrdup(host); c->port = port;
    buf_init(&c->rbuf); c->rpos = 0;
    return c;
}

void http_close(http_conn *c) {
    if (!c) return;
    if (c->ssl) { SSL_shutdown(c->ssl); SSL_free(c->ssl); }
    if (c->fd >= 0) close(c->fd);
    free(c->host);
    buf_free(&c->rbuf);
    free(c);
}

void http_response_init(http_response *r) {
    memset(r, 0, sizeof *r);
    r->status = -1;
    buf_init(&r->headers); buf_init(&r->body);
}
void http_response_free(http_response *r) {
    free(r->status_line);
    buf_free(&r->headers); buf_free(&r->body);
}

static bool ssl_write_all(http_conn *c, const void *p, size_t n, http_response *resp) {
    const unsigned char *q = p;
    while (n) {
        int w = SSL_write(c->ssl, q, n > INT32_MAX ? INT32_MAX : (int)n);
        if (w <= 0) {
            int e = SSL_get_error(c->ssl, w);
            snprintf(resp->err, sizeof resp->err, "sending request: TLS error %d (%s)", e, e == SSL_ERROR_SYSCALL ? strerror(errno) : ssl_errstr());
            resp->dropped = true;
            return false;
        }
        q += w; n -= (size_t)w;
    }
    return true;
}

/* Ensure at least `want` unread bytes are buffered, reading more from TLS.
 * Returns the number available (may be less than want on EOF/error, with
 * *eof or resp->err set). */
static size_t fill(http_conn *c, size_t want, http_response *resp, bool *eof) {
    *eof = false;
    for (;;) {
        size_t have = c->rbuf.len - c->rpos;
        if (have >= want) return have;
        if (c->rpos > 0 && c->rpos == c->rbuf.len) { c->rbuf.len = 0; c->rpos = 0; }
        else if (c->rpos > (1u << 20)) { memmove(c->rbuf.p, c->rbuf.p + c->rpos, c->rbuf.len - c->rpos); c->rbuf.len -= c->rpos; c->rpos = 0; }
        buf_reserve(&c->rbuf, 65536);
        int r = SSL_read(c->ssl, c->rbuf.p + c->rbuf.len, 65536);
        if (r <= 0) {
            int e = SSL_get_error(c->ssl, r);
            if (e == SSL_ERROR_ZERO_RETURN) { *eof = true; return c->rbuf.len - c->rpos; }
            if (e == SSL_ERROR_SYSCALL && errno == 0) { *eof = true; return c->rbuf.len - c->rpos; } /* unclean close */
            snprintf(resp->err, sizeof resp->err, "reading response: TLS error %d (%s)", e, e == SSL_ERROR_SYSCALL ? strerror(errno) : ssl_errstr());
            resp->dropped = true;
            *eof = true;
            return c->rbuf.len - c->rpos;
        }
        c->rbuf.len += (size_t)r;
        c->rbuf.p[c->rbuf.len] = 0;
    }
}

/* Read a CRLF-terminated line into *line (without CRLF). */
static bool read_line(http_conn *c, span_t *line, http_response *resp) {
    size_t scanned = 0;
    for (;;) {
        bool eof;
        size_t have = fill(c, scanned + 1, resp, &eof);
        const unsigned char *base = c->rbuf.p + c->rpos;
        unsigned char *nl = memchr(base + scanned, '\n', have - scanned);
        if (nl) {
            size_t n = (size_t)(nl - base);
            line->p = base;
            line->n = (n > 0 && base[n - 1] == '\r') ? n - 1 : n;
            c->rpos += n + 1;
            return true;
        }
        scanned = have;
        if (eof) { if (!resp->err[0]) { snprintf(resp->err, sizeof resp->err, "connection closed before the response was complete"); resp->dropped = true; } return false; }
        if (have > (8u << 20)) { snprintf(resp->err, sizeof resp->err, "header line too long"); return false; }
    }
}

static bool deliver(http_body_cb cb, void *ud, buf_t *body, const unsigned char *p, size_t n, http_response *resp) {
    if (cb) { if (!cb(ud, p, n)) { snprintf(resp->err, sizeof resp->err, "body callback aborted"); return false; } }
    else buf_append(body, p, n);
    return true;
}

/* Consume exactly n body bytes. */
static bool read_body_n(http_conn *c, uint64_t n, http_body_cb cb, void *ud, http_response *resp) {
    while (n) {
        bool eof;
        size_t have = fill(c, 1, resp, &eof);
        if (!have) { if (!resp->err[0]) { snprintf(resp->err, sizeof resp->err, "connection closed with %llu body bytes missing", (unsigned long long)n); resp->dropped = true; } return false; }
        size_t take = have < n ? have : (size_t)n;
        if (!deliver(cb, ud, &resp->body, c->rbuf.p + c->rpos, take, resp)) return false;
        c->rpos += take; n -= take;
    }
    return true;
}

static bool read_chunked(http_conn *c, http_body_cb cb, void *ud, http_response *resp) {
    for (;;) {
        span_t line;
        if (!read_line(c, &line, resp)) return false;
        uint64_t sz = 0; size_t i = 0;
        while (i < line.n && hexval(line.p[i]) >= 0) { sz = sz * 16 + (uint64_t)hexval(line.p[i]); i++; }
        if (i == 0) { snprintf(resp->err, sizeof resp->err, "bad chunk size line"); return false; }
        if (sz == 0) {
            /* trailers up to a blank line */
            for (;;) { if (!read_line(c, &line, resp)) return false; if (line.n == 0) break; }
            return true;
        }
        if (!read_body_n(c, sz, cb, ud, resp)) return false;
        if (!read_line(c, &line, resp)) return false; /* CRLF after chunk */
    }
}

char *http_header_get(const http_response *r, const char *name) {
    size_t nl = strlen(name);
    const unsigned char *p = r->headers.p, *end = p + r->headers.len;
    while (p && p < end) {
        const unsigned char *nlp = memchr(p, '\n', (size_t)(end - p));
        size_t linelen = nlp ? (size_t)(nlp - p) : (size_t)(end - p);
        if (linelen > nl && p[nl] == ':' && !strncasecmp((const char *)p, name, nl)) {
            const unsigned char *v = p + nl + 1, *ve = p + linelen;
            while (v < ve && (*v == ' ' || *v == '\t')) v++;
            while (ve > v && (ve[-1] == ' ' || ve[-1] == '\t' || ve[-1] == '\r')) ve--;
            return xstrndup((const char *)v, (size_t)(ve - v));
        }
        p = nlp ? nlp + 1 : end;
    }
    return NULL;
}

bool http_request(http_conn *c, const char *method, const char *path_and_query,
                  const http_header *hdrs, size_t nhdrs,
                  http_body_cb cb, void *ud, http_response *resp, bool *reusable) {
    *reusable = false;
    buf_t req; buf_init(&req);
    buf_appendf(&req, "%s %s HTTP/1.1\r\n", method, path_and_query);
    bool have_host = false;
    for (size_t i = 0; i < nhdrs; i++) {
        if (!strcasecmp(hdrs[i].name, "Host")) have_host = true;
        buf_appendf(&req, "%s: %s\r\n", hdrs[i].name, hdrs[i].value);
    }
    if (!have_host) {
        if (c->port == 443) buf_appendf(&req, "Host: %s\r\n", c->host);
        else buf_appendf(&req, "Host: %s:%d\r\n", c->host, c->port);
    }
    buf_appendstr(&req, "Connection: keep-alive\r\n\r\n");
    bool ok = ssl_write_all(c, req.p, req.len, resp);
    buf_free(&req);
    if (!ok) return false;

    span_t line;
    if (!read_line(c, &line, resp)) return false;
    resp->status_line = xstrndup((const char *)line.p, line.n);
    int major, minor, status;
    if (sscanf(resp->status_line, "HTTP/%d.%d %d", &major, &minor, &status) != 3) {
        snprintf(resp->err, sizeof resp->err, "malformed status line: %.100s", resp->status_line);
        return false;
    }
    resp->status = status;
    bool conn_close = (major == 1 && minor == 0);
    bool chunked = false;
    int64_t clen = -1;
    for (;;) {
        if (!read_line(c, &line, resp)) return false;
        if (line.n == 0) break;
        buf_append(&resp->headers, line.p, line.n);
        buf_append(&resp->headers, "\n", 1);
    }
    char *te = http_header_get(resp, "Transfer-Encoding");
    if (te) { if (strcasestr(te, "chunked")) chunked = true; free(te); }
    char *cl = http_header_get(resp, "Content-Length");
    if (cl) { clen = strtoll(cl, NULL, 10); free(cl); }
    char *cn = http_header_get(resp, "Connection");
    if (cn) { if (strcasestr(cn, "close")) conn_close = true; if (strcasestr(cn, "keep-alive")) conn_close = false; free(cn); }

    bool bodyless = (status / 100 == 1) || status == 204 || status == 304 || !strcmp(method, "HEAD");
    if (bodyless) { *reusable = !conn_close; return true; }
    if (chunked) {
        if (!read_chunked(c, cb, ud, resp)) return false;
    } else if (clen >= 0) {
        if (!read_body_n(c, (uint64_t)clen, cb, ud, resp)) return false;
    } else {
        /* read to close */
        for (;;) {
            bool eof;
            size_t have = fill(c, 1, resp, &eof);
            if (have) { if (!deliver(cb, ud, &resp->body, c->rbuf.p + c->rpos, have, resp)) return false; c->rpos += have; }
            if (eof) { if (resp->err[0]) return false; break; }
        }
        conn_close = true;
    }
    *reusable = !conn_close;
    return true;
}
