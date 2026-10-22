// Thin non-variadic wrappers: Swift cannot call curl_easy_setopt/getinfo (C varargs).
#include <curl/curl.h>

typedef size_t (*s3c_data_cb)(char *ptr, size_t size, size_t nmemb, void *userdata);

// Must run before any other libcurl call (ENVIRONMENT.md): selects the LibreSSL backend,
// which checks certificates against /etc/ssl/cert.pem rather than through trustd.
static inline int s3c_select_openssl(void) {
  return (int)curl_global_sslset(CURLSSLBACKEND_OPENSSL, NULL, NULL);
}
static inline CURLcode s3c_set_str(CURL *h, CURLoption o, const char *v) { return curl_easy_setopt(h, o, v); }
static inline CURLcode s3c_set_long(CURL *h, CURLoption o, long v) { return curl_easy_setopt(h, o, v); }
static inline CURLcode s3c_set_ptr(CURL *h, CURLoption o, void *v) { return curl_easy_setopt(h, o, v); }
static inline CURLcode s3c_set_slist(CURL *h, CURLoption o, struct curl_slist *v) { return curl_easy_setopt(h, o, v); }
static inline CURLcode s3c_set_cb(CURL *h, CURLoption o, s3c_data_cb v) { return curl_easy_setopt(h, o, v); }
static inline CURLcode s3c_get_long(CURL *h, CURLINFO i, long *v) { return curl_easy_getinfo(h, i, v); }
