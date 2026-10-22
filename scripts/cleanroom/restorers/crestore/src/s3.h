/* Just enough S3 to read a bucket: signed GET and ListObjectsV2, with SigV4 done by hand. */
#ifndef S3CAB_S3_H
#define S3CAB_S3_H

#include "http.h"

typedef struct {
    char *bucket, *region, *akid, *secret, *token;
    char *host;
    bool path_style;
    http_conn_t *conn;
    unsigned long requests; /* signed requests sent, retries included */
} s3_t;

/* Where a GET's body goes.  `reset` is called before every attempt, so a retry starts clean. */
typedef struct {
    int (*reset)(void *ctx);
    http_sink_fn write;
    void *ctx;
} s3_sink_t;

enum { S3_OK = 0, S3_NOT_FOUND = 1, S3_FAIL = 2 };

void s3_init(s3_t *s3, const char *bucket); /* credentials and region from the environment */
void s3_free(s3_t *s3);

/* GET one key.  S3_NOT_FOUND only for a 404; every other failure is S3_FAIL with `err`. */
int s3_get(s3_t *s3, const char *key, const s3_sink_t *sink, char *err, size_t errlen);

/* List keys under `prefix` (and, with a delimiter, only those not past it).  Keys are
 * appended to *keys (each malloc'd). */
int s3_list(s3_t *s3, const char *prefix, const char *delimiter, char ***keys, size_t *nkeys, char *err,
            size_t errlen);

#endif
