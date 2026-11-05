#ifndef S3CAB_RESTORE_BRIDGE_H
#define S3CAB_RESTORE_BRIDGE_H

#include <curl/curl.h>
#include <zlib.h>
#include <stdio.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <unistd.h>
#include <fcntl.h>

/* curl_easy_setopt / curl_easy_getinfo are variadic, which Swift cannot call. */
static inline CURLcode s3r_setopt_str(CURL *h, CURLoption o, const char *v) { return curl_easy_setopt(h, o, v); }
static inline CURLcode s3r_setopt_long(CURL *h, CURLoption o, long v) { return curl_easy_setopt(h, o, v); }
static inline CURLcode s3r_setopt_ptr(CURL *h, CURLoption o, void *v) { return curl_easy_setopt(h, o, v); }
static inline CURLcode s3r_setopt_slist(CURL *h, CURLoption o, struct curl_slist *v) { return curl_easy_setopt(h, o, v); }
typedef size_t (*s3r_write_cb)(char *, size_t, size_t, void *);
static inline CURLcode s3r_setopt_writecb(CURL *h, CURLoption o, s3r_write_cb cb) { return curl_easy_setopt(h, o, cb); }
static inline CURLcode s3r_getinfo_long(CURL *h, CURLINFO i, long *out) { return curl_easy_getinfo(h, i, out); }
static inline CURLcode s3r_global_init(void) { return curl_global_init(CURL_GLOBAL_DEFAULT); }

/* inflateInit2 is a macro. 15 + 16 reads the gzip wrapper. */
static inline int s3r_inflate_init_gzip(z_streamp strm) { return inflateInit2(strm, 15 + 16); }

/* rename without replacing an existing target. */
static inline int s3r_rename_excl(const char *from, const char *to) { return renamex_np(from, to, RENAME_EXCL); }

/* set atime and mtime on an open file to the same nanosecond instant. */
static inline int s3r_set_times(int fd, long long sec, long nsec) {
    struct timespec ts[2];
    ts[0].tv_sec = (time_t)sec; ts[0].tv_nsec = nsec;
    ts[1].tv_sec = (time_t)sec; ts[1].tv_nsec = nsec;
    return futimens(fd, ts);
}

#endif
