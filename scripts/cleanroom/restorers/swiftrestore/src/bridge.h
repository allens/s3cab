// Bridging header: the four system libraries the restorer uses, and nothing else.
//   libcurl       - the HTTP client (general purpose; knows nothing about S3)
//   zlib          - gzip
//   CommonCrypto  - SHA-256 and HMAC-SHA-256
//   libicucore    - Unicode lower-casing as JavaScript does it (u_strToLower)
#include <curl/curl.h>
#include <zlib.h>
#include <CommonCrypto/CommonDigest.h>
#include <CommonCrypto/CommonHMAC.h>
#include <unicode/ustring.h>

// curl_easy_setopt and curl_easy_getinfo take a variable argument list, which Swift cannot
// call, and inflateInit2 is a macro. One typed wrapper each.
typedef size_t (*s3r_curl_cb)(char *ptr, size_t size, size_t nmemb, void *userdata);

static inline CURLcode s3r_setopt_long(CURL *h, CURLoption opt, long v) { return curl_easy_setopt(h, opt, v); }
static inline CURLcode s3r_setopt_str(CURL *h, CURLoption opt, const char *v) { return curl_easy_setopt(h, opt, v); }
static inline CURLcode s3r_setopt_ptr(CURL *h, CURLoption opt, void *v) { return curl_easy_setopt(h, opt, v); }
static inline CURLcode s3r_setopt_slist(CURL *h, CURLoption opt, struct curl_slist *v) { return curl_easy_setopt(h, opt, v); }
static inline CURLcode s3r_setopt_cb(CURL *h, CURLoption opt, s3r_curl_cb v) { return curl_easy_setopt(h, opt, v); }
static inline CURLcode s3r_getinfo_long(CURL *h, CURLINFO info, long *v) { return curl_easy_getinfo(h, info, v); }
static inline int s3r_inflateInit2(z_streamp s, int windowBits) { return inflateInit2(s, windowBits); }
