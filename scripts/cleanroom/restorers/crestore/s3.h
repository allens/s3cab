// Read-only S3 access over plain HTTPS: an HTTP/1.1 client on OpenSSL's TLS, and AWS
// Signature Version 4 worked out here. No AWS SDK and no S3 library.
#ifndef S3_H
#define S3_H

#include "util.h"

typedef struct s3 s3;

// Where a 200 response's body goes. `begin` is called each time a 200 body starts, so a
// retried request starts its sink again; `data` returns nonzero to abort (a local failure).
typedef struct {
    void *ud;
    int (*begin)(void *ud);
    int (*data)(void *ud, const unsigned char *p, size_t n);
} s3_sink;

typedef struct {
    int status;       // HTTP status of the final response
    buf body;         // the body, unless a sink took it (a non-200 body is always here)
    char code[64];    // the S3 error code of a non-200 response, "" if it has none
    bool body_ok;     // non-200 only: the body is empty or well-formed XML
    char err[512];    // why the call failed, when it returns nonzero
} s3_result;

enum {
    S3_OK = 0,         // an HTTP response arrived: look at status
    S3_TRANSPORT = -1, // no response, after the retries
    S3_LOCAL = -2,     // the sink refused the data
};

// Credentials and region come from the environment (AWS_ACCESS_KEY_ID,
// AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AWS_REGION or AWS_DEFAULT_REGION), the proxy
// from HTTPS_PROXY. Dies with a message when the keys are missing.
s3 *s3_open(const char *bucket);
void s3_close(s3 *c);

// GET one key. A 5xx is retried up to three attempts in all, a dropped connection for two
// minutes; a 301 naming the bucket's region is followed once.
int s3_get(s3 *c, const char *key, s3_sink *sink, s3_result *res);

// ListObjectsV2, every page. `delimiter` may be null. The callback gets each key, decoded,
// and each common prefix (is_prefix true). Returns S3_OK with res->status 200 when every
// page was read; any other outcome is a failed listing.
typedef void (*s3_list_cb)(void *ud, const char *key, bool is_prefix);
int s3_list(s3 *c, const char *prefix, const char *delimiter, s3_list_cb cb, void *ud, s3_result *res);

void s3_result_free(s3_result *res);

// How an error response's body reads: true when it is empty or one well-formed XML document,
// with S3's <Error><Code> copied out ("" when it has none). Exposed so it can be tested
// without a server.
bool s3_error_body(const char *body, size_t n, char code[64]);

// Test aid: number of HTTP requests sent so far.
unsigned long s3_request_count(const s3 *c);

#endif
