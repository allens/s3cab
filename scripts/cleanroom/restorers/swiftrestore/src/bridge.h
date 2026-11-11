// Bridging header: the C libraries the restorer uses, all shipped with macOS / the Xcode CLT.
#ifndef S3CAB_BRIDGE_H
#define S3CAB_BRIDGE_H
#include <curl/curl.h>
#include <zlib.h>
#include <CommonCrypto/CommonDigest.h>
#include <CommonCrypto/CommonHMAC.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <errno.h>

// curl_easy_setopt / curl_easy_getinfo are variadic, which Swift cannot call: typed wrappers.
static inline CURLcode s3cab_setopt_str(CURL *h, CURLoption o, const char *v) { return curl_easy_setopt(h, o, v); }
static inline CURLcode s3cab_setopt_long(CURL *h, CURLoption o, long v) { return curl_easy_setopt(h, o, v); }
static inline CURLcode s3cab_setopt_ptr(CURL *h, CURLoption o, void *v) { return curl_easy_setopt(h, o, v); }
static inline CURLcode s3cab_setopt_slist(CURL *h, CURLoption o, struct curl_slist *v) { return curl_easy_setopt(h, o, v); }
static inline CURLcode s3cab_setopt_wcb(CURL *h, CURLoption o, curl_write_callback cb) { return curl_easy_setopt(h, o, cb); }
static inline CURLcode s3cab_getinfo_long(CURL *h, CURLINFO i, long *v) { return curl_easy_getinfo(h, i, v); }

// inflateInit2 is a macro.
static inline int s3cab_inflateInit2(z_streamp s, int windowBits) { return inflateInit2(s, windowBits); }

// rename without replacing an existing destination.
static inline int s3cab_rename_noreplace(const char *from, const char *to) { return renamex_np(from, to, RENAME_EXCL); }
static inline int s3cab_errno(void) { return errno; }
#endif
