// Bridging header: the system libcurl and zlib, plus non-variadic wrappers,
// since Swift cannot call C variadic functions such as curl_easy_setopt.
#include <curl/curl.h>
#include <zlib.h>
#include <stdio.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <fcntl.h>
#include <unistd.h>

static inline CURLcode s3r_setopt_str(CURL *h, CURLoption o, const char *v) { return curl_easy_setopt(h, o, v); }
static inline CURLcode s3r_setopt_long(CURL *h, CURLoption o, long v) { return curl_easy_setopt(h, o, v); }
static inline CURLcode s3r_setopt_ptr(CURL *h, CURLoption o, void *v) { return curl_easy_setopt(h, o, v); }
static inline CURLcode s3r_setopt_slist(CURL *h, CURLoption o, struct curl_slist *v) { return curl_easy_setopt(h, o, v); }
typedef size_t (*s3r_write_cb)(char *, size_t, size_t, void *);
static inline CURLcode s3r_setopt_writefn(CURL *h, CURLoption o, s3r_write_cb cb) { return curl_easy_setopt(h, o, cb); }
static inline CURLcode s3r_getinfo_long(CURL *h, CURLINFO i, long *v) { return curl_easy_getinfo(h, i, v); }

// inflateInit2 is a macro (it passes ZLIB_VERSION and sizeof(z_stream)).
static inline int s3r_inflateInit2(z_streamp s, int windowBits) { return inflateInit2(s, windowBits); }

// renamex_np with RENAME_EXCL: rename that refuses to replace an existing target.
static inline int s3r_rename_excl(const char *from, const char *to) { return renamex_np(from, to, RENAME_EXCL); }
