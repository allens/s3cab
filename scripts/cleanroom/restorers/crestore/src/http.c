#include "http.h"

#include <ctype.h>
#include <errno.h>
#include <netdb.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/ssl.h>

constexpr int IO_TIMEOUT_SECONDS = 60;
constexpr size_t ERRBODY_CAP = 64 * 1024;

struct http_conn {
    char *host;
    int fd;
    SSL *ssl;
    bool reused; /* a request has completed on this connection already */
    unsigned char rbuf[64 * 1024];
    size_t rpos, rlen;
};

static SSL_CTX *g_ctx;

/* ---- proxy configuration (HTTPS_PROXY / https_proxy / ALL_PROXY, honouring NO_PROXY) ---- */

typedef struct {
    bool use;
    char host[256], port[16];
    char *auth_b64; /* "user:pass" base64, or nullptr */
} proxy_t;

static int unhex(int c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static void pct_decode(char *s)
{
    char *w = s;
    for (char *r = s; *r; r++) {
        if (r[0] == '%' && unhex(r[1]) >= 0 && unhex(r[2]) >= 0) {
            *w++ = (char)(unhex(r[1]) * 16 + unhex(r[2]));
            r += 2;
        } else {
            *w++ = *r;
        }
    }
    *w = 0;
}

static bool no_proxy_matches(const char *host)
{
    const char *np = getenv("no_proxy");
    if (!np || !*np) np = getenv("NO_PROXY");
    if (!np || !*np) return false;
    char *list = xstrdup(np), *save = nullptr;
    bool hit = false;
    size_t hl = strlen(host);
    for (char *tok = strtok_r(list, ", ", &save); tok && !hit; tok = strtok_r(nullptr, ", ", &save)) {
        if (strcmp(tok, "*") == 0) { hit = true; break; }
        if (*tok == '.') tok++;
        size_t tl = strlen(tok);
        if (tl == 0 || tl > hl) continue;
        if (strcasecmp(host + hl - tl, tok) == 0 && (tl == hl || host[hl - tl - 1] == '.')) hit = true;
    }
    free(list);
    return hit;
}

static void proxy_for(const char *host, proxy_t *px)
{
    *px = (proxy_t){0};
    const char *names[] = {"https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"};
    const char *url = nullptr;
    for (size_t i = 0; i < sizeof names / sizeof *names && !url; i++) {
        const char *v = getenv(names[i]);
        if (v && *v) url = v;
    }
    if (!url || no_proxy_matches(host)) return;

    const char *p = strstr(url, "://");
    if (p) {
        if (strncasecmp(url, "http://", 7) != 0) die("unsupported proxy scheme in %.*s", (int)(p - url + 3), url);
        p += 3;
    } else {
        p = url;
    }
    char *rest = xstrdup(p);
    char *slash = strchr(rest, '/');
    if (slash) *slash = 0;
    char *hostport = rest;
    char *at = strrchr(rest, '@');
    if (at) {
        *at = 0;
        hostport = at + 1;
        char *cred = xstrdup(rest);
        char *colon = strchr(cred, ':');
        char *user = cred, *pass = colon ? colon + 1 : (char *)"";
        if (colon) *colon = 0;
        pct_decode(user);
        pct_decode(pass);
        buf_t up = {0};
        buf_addf(&up, "%s:%s", user, pass);
        px->auth_b64 = xmalloc(4 * ((up.len + 2) / 3) + 1);
        EVP_EncodeBlock((unsigned char *)px->auth_b64, up.p, (int)up.len);
        buf_free(&up);
        free(cred);
    }
    const char *port = "1080";
    char *colon = strrchr(hostport, ':');
    if (colon && !strchr(colon, ']')) {
        *colon = 0;
        port = colon + 1;
    }
    if (hostport[0] == '[') { /* [ipv6] */
        hostport++;
        char *rb = strchr(hostport, ']');
        if (rb) *rb = 0;
    }
    snprintf(px->host, sizeof px->host, "%s", hostport);
    snprintf(px->port, sizeof px->port, "%s", port);
    px->use = true;
    free(rest);
}

/* ---- connection ---- */

static void ssl_err(char *err, size_t n, const char *what)
{
    unsigned long e = ERR_get_error();
    char ebuf[200] = "";
    if (e) ERR_error_string_n(e, ebuf, sizeof ebuf);
    snprintf(err, n, "%s: %s%s", what, ebuf[0] ? ebuf : "", errno && !ebuf[0] ? strerror(errno) : "");
    ERR_clear_error();
}

static void conn_drop(http_conn_t *c)
{
    if (c->ssl) {
        SSL_free(c->ssl);
        c->ssl = nullptr;
    }
    if (c->fd >= 0) close(c->fd);
    c->fd = -1;
    c->rpos = c->rlen = 0;
    c->reused = false;
}

static int tcp_connect(const char *host, const char *port, char *err, size_t errlen)
{
    struct addrinfo hints = {.ai_family = AF_UNSPEC, .ai_socktype = SOCK_STREAM}, *ai = nullptr;
    int rc = getaddrinfo(host, port, &hints, &ai);
    if (rc) {
        snprintf(err, errlen, "resolve %s: %s", host, gai_strerror(rc));
        return -1;
    }
    int fd = -1;
    for (struct addrinfo *a = ai; a; a = a->ai_next) {
        fd = socket(a->ai_family, a->ai_socktype | SOCK_CLOEXEC, a->ai_protocol);
        if (fd < 0) continue;
        struct timeval tv = {.tv_sec = IO_TIMEOUT_SECONDS};
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
        if (connect(fd, a->ai_addr, a->ai_addrlen) == 0) break;
        snprintf(err, errlen, "connect %s:%s: %s", host, port, strerror(errno));
        close(fd);
        fd = -1;
    }
    freeaddrinfo(ai);
    return fd;
}

static bool send_all_fd(int fd, const char *p, size_t n)
{
    while (n) {
        ssize_t w = send(fd, p, n, MSG_NOSIGNAL);
        if (w <= 0) return false;
        p += w;
        n -= (size_t)w;
    }
    return true;
}

static bool proxy_connect(http_conn_t *c, const proxy_t *px, char *err, size_t errlen)
{
    buf_t req = {0};
    buf_addf(&req, "CONNECT %s:443 HTTP/1.1\r\nHost: %s:443\r\n", c->host, c->host);
    if (px->auth_b64) buf_addf(&req, "Proxy-Authorization: Basic %s\r\n", px->auth_b64);
    buf_adds(&req, "\r\n");
    bool ok = send_all_fd(c->fd, (char *)req.p, req.len);
    buf_free(&req);
    if (!ok) {
        snprintf(err, errlen, "proxy CONNECT send: %s", strerror(errno));
        return false;
    }
    /* Read the proxy's reply a byte at a time so nothing of the TLS stream is consumed. */
    char head[8192];
    size_t n = 0;
    while (n < sizeof head - 1) {
        ssize_t r = recv(c->fd, head + n, 1, 0);
        if (r <= 0) {
            snprintf(err, errlen, "proxy CONNECT: connection closed");
            return false;
        }
        n++;
        if (n >= 4 && memcmp(head + n - 4, "\r\n\r\n", 4) == 0) break;
    }
    head[n] = 0;
    int status = 0;
    if (sscanf(head, "HTTP/%*d.%*d %d", &status) != 1 || status != 200) {
        char *eol = strstr(head, "\r\n");
        if (eol) *eol = 0;
        snprintf(err, errlen, "proxy refused CONNECT %s: %.200s", c->host, head);
        return false;
    }
    return true;
}

static bool conn_open(http_conn_t *c, char *err, size_t errlen)
{
    if (!g_ctx) {
        g_ctx = SSL_CTX_new(TLS_client_method());
        if (!g_ctx) die("SSL_CTX_new failed");
        SSL_CTX_set_min_proto_version(g_ctx, TLS1_2_VERSION);
        SSL_CTX_set_verify(g_ctx, SSL_VERIFY_PEER, nullptr);
        if (SSL_CTX_set_default_verify_paths(g_ctx) != 1) die("cannot load the system CA certificates");
    }
    proxy_t px;
    proxy_for(c->host, &px);
    c->fd = px.use ? tcp_connect(px.host, px.port, err, errlen) : tcp_connect(c->host, "443", err, errlen);
    if (c->fd < 0) {
        free(px.auth_b64);
        return false;
    }
    if (px.use && !proxy_connect(c, &px, err, errlen)) {
        free(px.auth_b64);
        conn_drop(c);
        return false;
    }
    free(px.auth_b64);

    c->ssl = SSL_new(g_ctx);
    SSL_set_fd(c->ssl, c->fd);
    SSL_set_tlsext_host_name(c->ssl, c->host);
    SSL_set1_host(c->ssl, c->host);
    errno = 0;
    if (SSL_connect(c->ssl) != 1) {
        ssl_err(err, errlen, "TLS handshake");
        long vr = SSL_get_verify_result(c->ssl);
        if (vr != X509_V_OK) {
            size_t l = strlen(err);
            snprintf(err + l, errlen - l, " (certificate: %s)", X509_verify_cert_error_string(vr));
        }
        conn_drop(c);
        return false;
    }
    return true;
}

http_conn_t *http_conn_new(const char *host)
{
    http_conn_t *c = xcalloc(1, sizeof *c);
    c->host = xstrdup(host);
    c->fd = -1;
    return c;
}

void http_conn_free(http_conn_t *c)
{
    if (!c) return;
    if (c->ssl) SSL_shutdown(c->ssl);
    conn_drop(c);
    free(c->host);
    free(c);
}

/* ---- buffered reading ---- */

static int fill(http_conn_t *c)
{
    if (c->rpos < c->rlen) return 1;
    errno = 0;
    int r = SSL_read(c->ssl, c->rbuf, sizeof c->rbuf);
    if (r <= 0) return 0;
    c->rpos = 0;
    c->rlen = (size_t)r;
    return 1;
}

/* Reads a CRLF- or LF-terminated header line into out (without the terminator). */
static bool read_line(http_conn_t *c, char *out, size_t cap)
{
    size_t n = 0;
    for (;;) {
        if (!fill(c)) return false;
        unsigned char ch = c->rbuf[c->rpos++];
        if (ch == '\n') break;
        if (n + 1 < cap) out[n++] = (char)ch;
    }
    if (n && out[n - 1] == '\r') n--;
    out[n] = 0;
    return true;
}

typedef struct {
    http_sink_fn sink;
    void *ctx;
    buf_t *errbody;
    bool to_sink;
} body_t;

static int deliver(body_t *b, const unsigned char *p, size_t n)
{
    if (b->to_sink) return b->sink ? b->sink(b->ctx, p, n) : 0;
    if (b->errbody->len < ERRBODY_CAP) {
        size_t room = ERRBODY_CAP - b->errbody->len;
        buf_add(b->errbody, p, n < room ? n : room);
    }
    return 0;
}

/* Returns 0 ok, -1 transport, -2 sink. */
static int read_exact(http_conn_t *c, uint64_t n, body_t *b)
{
    while (n) {
        if (!fill(c)) return -1;
        size_t avail = c->rlen - c->rpos;
        size_t take = avail < n ? avail : (size_t)n;
        if (deliver(b, c->rbuf + c->rpos, take)) return -2;
        c->rpos += take;
        n -= take;
    }
    return 0;
}

static int read_chunked(http_conn_t *c, body_t *b)
{
    char line[1024];
    for (;;) {
        if (!read_line(c, line, sizeof line)) return -1;
        char *end;
        errno = 0;
        unsigned long long sz = strtoull(line, &end, 16);
        if (end == line || errno) return -1;
        if (sz == 0) break;
        int rc = read_exact(c, sz, b);
        if (rc) return rc;
        if (!read_line(c, line, sizeof line) || line[0]) return -1;
    }
    do { /* trailers */
        if (!read_line(c, line, sizeof line)) return -1;
    } while (line[0]);
    return 0;
}

static int read_to_eof(http_conn_t *c, body_t *b)
{
    for (;;) {
        if (!fill(c)) {
            int e = SSL_get_error(c->ssl, 0);
            (void)e;
            return 0; /* a clean or unclean close ends the body; no length to check against */
        }
        if (deliver(b, c->rbuf + c->rpos, c->rlen - c->rpos)) return -2;
        c->rpos = c->rlen;
    }
}

static bool ssl_write_all(http_conn_t *c, const unsigned char *p, size_t n)
{
    while (n) {
        int w = SSL_write(c->ssl, p, (int)n);
        if (w <= 0) return false;
        p += w;
        n -= (size_t)w;
    }
    return true;
}

int http_get(http_conn_t *c, const char *target, const char *const *headers, http_sink_fn sink, void *ctx,
             http_result_t *res)
{
    res->status = 0;
    res->err[0] = 0;
    res->errbody.len = 0;

    buf_t req = {0};
    buf_addf(&req, "GET %s HTTP/1.1\r\nHost: %s\r\n", target, c->host);
    for (size_t i = 0; headers && headers[i]; i++) buf_addf(&req, "%s\r\n", headers[i]);
    buf_adds(&req, "Accept-Encoding: identity\r\nUser-Agent: s3cab-restore-cleanroom/1\r\n\r\n");

    for (int attempt = 0;; attempt++) {
        if (c->fd < 0 && !conn_open(c, res->err, sizeof res->err)) {
            buf_free(&req);
            return HTTP_TRANSPORT;
        }
        bool was_reused = c->reused;
        char line[8192];
        if (!ssl_write_all(c, req.p, req.len) || !read_line(c, line, sizeof line)) {
            /* A kept-alive connection the server has since closed: reconnect once, silently. */
            if (was_reused && attempt == 0) {
                conn_drop(c);
                continue;
            }
            ssl_err(res->err, sizeof res->err, "connection dropped");
            conn_drop(c);
            buf_free(&req);
            return HTTP_TRANSPORT;
        }
        buf_free(&req);

        int status = 0, minor = 1;
        for (;;) { /* skip interim 1xx responses */
            if (sscanf(line, "HTTP/1.%d %d", &minor, &status) != 2) {
                snprintf(res->err, sizeof res->err, "bad status line: %.100s", line);
                conn_drop(c);
                return HTTP_TRANSPORT;
            }
            if (status >= 200) break;
            do {
                if (!read_line(c, line, sizeof line)) goto dropped;
            } while (line[0]);
            if (!read_line(c, line, sizeof line)) goto dropped;
        }

        bool chunked = false, have_len = false, close_after = (minor == 0);
        uint64_t clen = 0;
        for (;;) {
            if (!read_line(c, line, sizeof line)) goto dropped;
            if (!line[0]) break;
            char *colon = strchr(line, ':');
            if (!colon) continue;
            *colon = 0;
            char *v = colon + 1;
            while (*v == ' ' || *v == '\t') v++;
            if (strcasecmp(line, "content-length") == 0) {
                have_len = true;
                clen = strtoull(v, nullptr, 10);
            } else if (strcasecmp(line, "transfer-encoding") == 0) {
                if (strcasestr(v, "chunked")) chunked = true;
            } else if (strcasecmp(line, "connection") == 0) {
                if (strcasestr(v, "close")) close_after = true;
            }
        }

        body_t body = {.sink = sink, .ctx = ctx, .errbody = &res->errbody, .to_sink = status / 100 == 2};
        int rc = 0;
        if (status == 204 || status == 304)
            rc = 0;
        else if (chunked)
            rc = read_chunked(c, &body);
        else if (have_len)
            rc = read_exact(c, clen, &body);
        else {
            rc = read_to_eof(c, &body);
            close_after = true;
        }
        if (rc == -2) {
            conn_drop(c); /* the rest of the body is still in flight */
            return HTTP_SINK;
        }
        if (rc == -1) goto dropped;
        res->status = status;
        if (close_after)
            conn_drop(c);
        else
            c->reused = true;
        return HTTP_DONE;

    dropped:
        ssl_err(res->err, sizeof res->err, "connection dropped mid-response");
        conn_drop(c);
        return HTTP_TRANSPORT;
    }
}
