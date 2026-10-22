/* A minimal HTTPS/1.1 GET client over OpenSSL, tunnelling through HTTPS_PROXY when set. */
#ifndef S3CAB_HTTP_H
#define S3CAB_HTTP_H

#include "util.h"

typedef struct http_conn http_conn_t;

/* Receives a 2xx response body as it arrives.  Return nonzero to abort. */
typedef int (*http_sink_fn)(void *ctx, const unsigned char *data, size_t n);

typedef struct {
    int status;    /* HTTP status of a complete response */
    char err[256]; /* transport failure, when http_get returns HTTP_TRANSPORT */
    buf_t errbody; /* body of a non-2xx response, capped */
} http_result_t;

enum { HTTP_DONE = 0, HTTP_TRANSPORT = -1, HTTP_SINK = -2 };

http_conn_t *http_conn_new(const char *host);
void http_conn_free(http_conn_t *c);

/* `target` is the request-target (already percent-encoded); `headers` a nullptr-terminated
 * list of "Name: value" lines.  Returns HTTP_DONE with res->status set, or HTTP_TRANSPORT
 * (connection failed or dropped; worth retrying), or HTTP_SINK (the sink refused). */
int http_get(http_conn_t *c, const char *target, const char *const *headers, http_sink_fn sink,
             void *ctx, http_result_t *res);

#endif
