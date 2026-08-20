// s3cab-restore — clean-room restorer for the s3cab storage format, written only from
// format.md. Talks to S3 over plain HTTPS with libcurl and signs requests itself (AWS
// Signature Version 4, derived from public AWS documentation). No AWS SDK, no S3 client
// library, no shelling out.
//
// Build:   g++ -std=c++23 -O2 -Wall -Wextra -o s3cab-restore restorer.cpp -lcurl -lcrypto -lzstd
// Usage:   s3cab-restore --bucket B --region R list
//          s3cab-restore --bucket B --region R restore <set> <snapshot-name> <outdir>
//          s3cab-restore --bucket B --region R get <key> [outfile]
// Credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN.

#include <algorithm>
#include <cctype>
#include <cinttypes>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <filesystem>
#include <map>
#include <optional>
#include <set>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <curl/curl.h>
#include <fcntl.h>
#include <openssl/evp.h>
#include <openssl/hmac.h>
#include <sys/stat.h>
#include <unistd.h>
#include <zstd.h>

namespace fs = std::filesystem;

// ---------------------------------------------------------------- small utilities

[[noreturn]] static void die(const std::string& msg) {
    fprintf(stderr, "s3cab-restore: fatal: %s\n", msg.c_str());
    exit(1);
}

static std::string trim_spaces(const std::string& s) {
    size_t b = s.find_first_not_of(' ');
    if (b == std::string::npos) return "";
    size_t e = s.find_last_not_of(' ');
    return s.substr(b, e - b + 1);
}

static bool is_lower_hex64(const std::string& s) {
    if (s.size() != 64) return false;
    for (char c : s)
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    return true;
}

static std::string to_hex(const unsigned char* d, size_t n) {
    static const char* hx = "0123456789abcdef";
    std::string out;
    out.reserve(n * 2);
    for (size_t i = 0; i < n; i++) { out += hx[d[i] >> 4]; out += hx[d[i] & 15]; }
    return out;
}

// Strict UTF-8 validation (the spec: "Decode strictly: a decode error means the file is
// damaged"). Returns byte offset of first invalid sequence, or npos if valid.
static size_t utf8_invalid_at(const std::string& s) {
    size_t i = 0, n = s.size();
    while (i < n) {
        unsigned char c = s[i];
        size_t len; unsigned cp_min;
        if (c < 0x80) { i++; continue; }
        else if ((c & 0xE0) == 0xC0) { len = 2; cp_min = 0x80; }
        else if ((c & 0xF0) == 0xE0) { len = 3; cp_min = 0x800; }
        else if ((c & 0xF8) == 0xF0) { len = 4; cp_min = 0x10000; }
        else return i;
        if (i + len > n) return i;
        unsigned cp = c & (0x7F >> len);
        for (size_t j = 1; j < len; j++) {
            unsigned char cc = s[i + j];
            if ((cc & 0xC0) != 0x80) return i;
            cp = (cp << 6) | (cc & 0x3F);
        }
        if (cp < cp_min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return i;
        i += len;
    }
    return std::string::npos;
}

// ---------------------------------------------------------------- crypto (OpenSSL)

static std::string sha256_hex(const void* data, size_t n) {
    unsigned char md[32]; unsigned int mdlen = 0;
    EVP_Digest(data, n, md, &mdlen, EVP_sha256(), nullptr);
    return to_hex(md, mdlen);
}

static std::string hmac_sha256_raw(const std::string& key, const std::string& data) {
    unsigned char md[32]; unsigned int mdlen = 0;
    HMAC(EVP_sha256(), key.data(), (int)key.size(),
         (const unsigned char*)data.data(), data.size(), md, &mdlen);
    return std::string((char*)md, mdlen);
}

struct Sha256Stream {
    EVP_MD_CTX* ctx;
    Sha256Stream() { ctx = EVP_MD_CTX_new(); EVP_DigestInit_ex(ctx, EVP_sha256(), nullptr); }
    ~Sha256Stream() { EVP_MD_CTX_free(ctx); }
    void update(const void* d, size_t n) { EVP_DigestUpdate(ctx, d, n); }
    std::string final_hex() {
        unsigned char md[32]; unsigned int mdlen = 0;
        EVP_DigestFinal_ex(ctx, md, &mdlen);
        return to_hex(md, mdlen);
    }
};

// ---------------------------------------------------------------- percent / xml helpers

// RFC 3986 percent-encoding with the unreserved set; keep_slash leaves '/' intact
// (for S3 canonical URIs, which are single-encoded with '/' as separator).
static std::string pct_encode(const std::string& s, bool keep_slash) {
    static const char* hx = "0123456789ABCDEF";
    std::string out;
    for (unsigned char c : s) {
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
            c == '-' || c == '.' || c == '_' || c == '~' || (keep_slash && c == '/'))
            out += (char)c;
        else { out += '%'; out += hx[c >> 4]; out += hx[c & 15]; }
    }
    return out;
}

static std::string xml_unescape(const std::string& s) {
    std::string out;
    for (size_t i = 0; i < s.size();) {
        if (s[i] != '&') { out += s[i++]; continue; }
        size_t sc = s.find(';', i);
        if (sc == std::string::npos) { out += s[i++]; continue; }
        std::string ent = s.substr(i + 1, sc - i - 1);
        if (ent == "amp") out += '&';
        else if (ent == "lt") out += '<';
        else if (ent == "gt") out += '>';
        else if (ent == "quot") out += '"';
        else if (ent == "apos") out += '\'';
        else if (!ent.empty() && ent[0] == '#') {
            long cp = (ent.size() > 1 && (ent[1] == 'x' || ent[1] == 'X'))
                          ? strtol(ent.c_str() + 2, nullptr, 16)
                          : strtol(ent.c_str() + 1, nullptr, 10);
            // encode code point back to UTF-8
            if (cp < 0x80) out += (char)cp;
            else if (cp < 0x800) { out += (char)(0xC0 | (cp >> 6)); out += (char)(0x80 | (cp & 63)); }
            else if (cp < 0x10000) { out += (char)(0xE0 | (cp >> 12)); out += (char)(0x80 | ((cp >> 6) & 63)); out += (char)(0x80 | (cp & 63)); }
            else { out += (char)(0xF0 | (cp >> 18)); out += (char)(0x80 | ((cp >> 12) & 63)); out += (char)(0x80 | ((cp >> 6) & 63)); out += (char)(0x80 | (cp & 63)); }
        } else { out += s.substr(i, sc - i + 1); }
        i = sc + 1;
    }
    return out;
}

// All text contents of <tag>...</tag> within xml (non-nested, which fits S3 listings).
static std::vector<std::string> xml_texts(const std::string& xml, const std::string& tag) {
    std::vector<std::string> out;
    std::string open = "<" + tag + ">", close = "</" + tag + ">";
    size_t p = 0;
    while ((p = xml.find(open, p)) != std::string::npos) {
        size_t b = p + open.size();
        size_t e = xml.find(close, b);
        if (e == std::string::npos) break;
        out.push_back(xml_unescape(xml.substr(b, e - b)));
        p = e + close.size();
    }
    return out;
}

// ---------------------------------------------------------------- S3 client (SigV4 over libcurl)

struct Creds { std::string akid, secret, token; };

struct HttpResult {
    long status = 0;
    std::string body;      // response body when kept in memory, or error body otherwise
    uint64_t file_bytes = 0;
    std::string file_sha256;
    CURLcode curl_rc = CURLE_OK;
    std::string curl_err;
};

struct WriteCtx {
    long status = 0;
    std::string* mem = nullptr;   // if set and status==200, body accumulates here
    FILE* f = nullptr;            // if set and status==200, body streams here
    Sha256Stream* sha = nullptr;
    uint64_t bytes = 0;
    std::string errbody;
};

static size_t hdr_cb(char* buf, size_t sz, size_t nm, void* ud) {
    WriteCtx* c = (WriteCtx*)ud;
    size_t n = sz * nm;
    if (n > 5 && memcmp(buf, "HTTP/", 5) == 0) {
        // "HTTP/1.1 200 OK" or "HTTP/2 200"
        const char* sp = (const char*)memchr(buf, ' ', n);
        if (sp) c->status = atol(sp + 1);
    }
    return n;
}

static size_t body_cb(char* buf, size_t sz, size_t nm, void* ud) {
    WriteCtx* c = (WriteCtx*)ud;
    size_t n = sz * nm;
    if (c->status == 200) {
        if (c->f) {
            if (fwrite(buf, 1, n, c->f) != n) return 0;
            if (c->sha) c->sha->update(buf, n);
        } else if (c->mem) {
            c->mem->append(buf, n);
        }
        c->bytes += n;
    } else {
        if (c->errbody.size() < 8192) c->errbody.append(buf, std::min(n, (size_t)8192));
    }
    return n;
}

class S3Client {
  public:
    S3Client(std::string bucket, std::string region, Creds creds)
        : bucket_(std::move(bucket)), region_(std::move(region)), creds_(std::move(creds)) {
        host_ = bucket_ + ".s3." + region_ + ".amazonaws.com";
        curl_ = curl_easy_init();
        if (!curl_) die("curl_easy_init failed");
    }
    ~S3Client() { curl_easy_cleanup(curl_); }

    // GET /key (no query) into memory. Throws no exceptions; check .status.
    HttpResult get_to_memory(const std::string& key,
                             const std::vector<std::pair<std::string, std::string>>& query = {}) {
        HttpResult r;
        WriteCtx ctx; ctx.mem = &r.body;
        do_get(key, query, ctx, r);
        return r;
    }

    // GET /key streamed to an open FILE*, hashing as it goes.
    HttpResult get_to_file(const std::string& key, FILE* f) {
        HttpResult r;
        Sha256Stream sha;
        WriteCtx ctx; ctx.f = f; ctx.sha = &sha;
        do_get(key, {}, ctx, r);
        r.file_bytes = ctx.bytes;
        r.file_sha256 = sha.final_hex();
        return r;
    }

    // ListObjectsV2, all pages. Returns keys; optionally common prefixes via delimiter.
    struct Listing { std::vector<std::string> keys; std::vector<std::string> prefixes; };
    Listing list(const std::string& prefix, const std::string& delimiter = "") {
        Listing out;
        std::string token;
        for (;;) {
            std::vector<std::pair<std::string, std::string>> q = {{"list-type", "2"}};
            if (!prefix.empty()) q.push_back({"prefix", prefix});
            if (!delimiter.empty()) q.push_back({"delimiter", delimiter});
            if (!token.empty()) q.push_back({"continuation-token", token});
            HttpResult r = get_to_memory("", q);
            if (r.status != 200)
                die("ListObjectsV2 failed (HTTP " + std::to_string(r.status) + "): " +
                    (r.status ? r.body.substr(0, 500) : r.curl_err));
            // <Contents><Key>k</Key>...</Contents>; CommonPrefixes hold their own <Prefix>.
            for (auto& blk : xml_texts(r.body, "Contents")) (void)blk; // (not used; Key is unique to Contents)
            for (auto& k : xml_texts(r.body, "Key")) out.keys.push_back(k);
            size_t p = 0;
            while ((p = r.body.find("<CommonPrefixes>", p)) != std::string::npos) {
                size_t e = r.body.find("</CommonPrefixes>", p);
                if (e == std::string::npos) break;
                auto v = xml_texts(r.body.substr(p, e - p), "Prefix");
                out.prefixes.insert(out.prefixes.end(), v.begin(), v.end());
                p = e + 1;
            }
            auto trunc = xml_texts(r.body, "IsTruncated");
            auto next = xml_texts(r.body, "NextContinuationToken");
            if (!trunc.empty() && trunc[0] == "true" && !next.empty()) token = next[0];
            else break;
        }
        return out;
    }

  private:
    void do_get(const std::string& key,
                const std::vector<std::pair<std::string, std::string>>& query,
                WriteCtx& ctx, HttpResult& r) {
        // canonical URI: single percent-encoding, '/' kept
        std::string uri = "/" + pct_encode(key, /*keep_slash=*/true);
        // canonical query: encoded pairs sorted by key
        std::vector<std::pair<std::string, std::string>> enc;
        for (auto& [k, v] : query) enc.push_back({pct_encode(k, false), pct_encode(v, false)});
        std::sort(enc.begin(), enc.end());
        std::string cq;
        for (auto& [k, v] : enc) { if (!cq.empty()) cq += '&'; cq += k + "=" + v; }

        static const char* EMPTY_SHA =
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

        int attempts = 0;
        for (;;) {
            attempts++;
            time_t now = time(nullptr);
            struct tm tmv; gmtime_r(&now, &tmv);
            char amzdate[32], datestamp[16];
            strftime(amzdate, sizeof amzdate, "%Y%m%dT%H%M%SZ", &tmv);
            strftime(datestamp, sizeof datestamp, "%Y%m%d", &tmv);

            std::string canon_headers = "host:" + host_ + "\n" +
                                        "x-amz-content-sha256:" + EMPTY_SHA + "\n" +
                                        "x-amz-date:" + std::string(amzdate) + "\n";
            std::string signed_headers = "host;x-amz-content-sha256;x-amz-date";
            if (!creds_.token.empty()) {
                canon_headers += "x-amz-security-token:" + creds_.token + "\n";
                signed_headers += ";x-amz-security-token";
            }
            std::string canonical = "GET\n" + uri + "\n" + cq + "\n" + canon_headers + "\n" +
                                    signed_headers + "\n" + EMPTY_SHA;
            std::string scope = std::string(datestamp) + "/" + region_ + "/s3/aws4_request";
            std::string to_sign = "AWS4-HMAC-SHA256\n" + std::string(amzdate) + "\n" + scope +
                                  "\n" + sha256_hex(canonical.data(), canonical.size());
            std::string k = hmac_sha256_raw("AWS4" + creds_.secret, datestamp);
            k = hmac_sha256_raw(k, region_);
            k = hmac_sha256_raw(k, "s3");
            k = hmac_sha256_raw(k, "aws4_request");
            std::string sig = to_hex((const unsigned char*)hmac_sha256_raw(k, to_sign).data(), 32);
            std::string auth = "Authorization: AWS4-HMAC-SHA256 Credential=" + creds_.akid + "/" +
                               scope + ", SignedHeaders=" + signed_headers + ", Signature=" + sig;

            struct curl_slist* hdrs = nullptr;
            hdrs = curl_slist_append(hdrs, ("x-amz-date: " + std::string(amzdate)).c_str());
            hdrs = curl_slist_append(hdrs, ("x-amz-content-sha256: " + std::string(EMPTY_SHA)).c_str());
            if (!creds_.token.empty())
                hdrs = curl_slist_append(hdrs, ("x-amz-security-token: " + creds_.token).c_str());
            hdrs = curl_slist_append(hdrs, auth.c_str());

            std::string url = "https://" + host_ + uri + (cq.empty() ? "" : "?" + cq);

            ctx.status = 0; ctx.bytes = 0; ctx.errbody.clear();
            if (ctx.mem) ctx.mem->clear();

            char errbuf[CURL_ERROR_SIZE] = {0};
            curl_easy_reset(curl_);
            curl_easy_setopt(curl_, CURLOPT_URL, url.c_str());
            curl_easy_setopt(curl_, CURLOPT_HTTPHEADER, hdrs);
            curl_easy_setopt(curl_, CURLOPT_HEADERFUNCTION, hdr_cb);
            curl_easy_setopt(curl_, CURLOPT_HEADERDATA, &ctx);
            curl_easy_setopt(curl_, CURLOPT_WRITEFUNCTION, body_cb);
            curl_easy_setopt(curl_, CURLOPT_WRITEDATA, &ctx);
            curl_easy_setopt(curl_, CURLOPT_ERRORBUFFER, errbuf);
            curl_easy_setopt(curl_, CURLOPT_CONNECTTIMEOUT_MS, 15000L);
            curl_easy_setopt(curl_, CURLOPT_LOW_SPEED_LIMIT, 1024L);
            curl_easy_setopt(curl_, CURLOPT_LOW_SPEED_TIME, 60L);
            curl_easy_setopt(curl_, CURLOPT_NOSIGNAL, 1L);

            CURLcode rc = curl_easy_perform(curl_);
            curl_slist_free_all(hdrs);
            r.curl_rc = rc;
            r.curl_err = errbuf;
            r.status = ctx.status;
            if (ctx.status != 200 && !ctx.errbody.empty()) r.body = ctx.errbody;

            bool retryable = (rc != CURLE_OK) || ctx.status >= 500 || ctx.status == 429;
            // A partially-written file body cannot be retried blindly (bytes already
            // consumed); only retry file downloads when nothing was written yet.
            if (ctx.f && ctx.bytes > 0) retryable = false;
            if (retryable && attempts < 4) { usleep(400000u * attempts); continue; }
            return;
        }
    }

    std::string bucket_, region_, host_;
    Creds creds_;
    CURL* curl_;
};

// ---------------------------------------------------------------- zstd

static std::string zstd_decompress(const std::string& in) {
    ZSTD_DStream* ds = ZSTD_createDStream();
    if (!ds) die("ZSTD_createDStream failed");
    std::string out;
    std::vector<char> buf(1 << 17);
    ZSTD_inBuffer zin{in.data(), in.size(), 0};
    size_t rc = 0;
    do {
        ZSTD_outBuffer zout{buf.data(), buf.size(), 0};
        rc = ZSTD_decompressStream(ds, &zout, &zin);
        if (ZSTD_isError(rc)) {
            ZSTD_freeDStream(ds);
            die(std::string("zstd decompression failed: ") + ZSTD_getErrorName(rc));
        }
        out.append(buf.data(), zout.pos);
    } while (rc != 0 || zin.pos < zin.size);
    ZSTD_freeDStream(ds);
    return out;
}

// ---------------------------------------------------------------- snapshot parsing

struct FileRow {
    std::string hash;
    uint64_t size;
    std::string mtime_str;
    struct timespec mtime;
    std::string path;   // verbatim, never trimmed
};

struct Snapshot {
    std::string set_name, start_instant, name_and_zone;
    std::vector<std::string> dirs;   // #DIR paths, verbatim
    std::vector<FileRow> rows;
    int excluded = 0, skipped = 0, errors = 0, other_meta = 0;
};

// Parse "YYYY-MM-DDTHH:MM:SS.sssZ" (exactly 24 chars) to a UTC timespec.
static bool parse_mtime(const std::string& s, struct timespec* out) {
    if (s.size() != 24 || s[4] != '-' || s[7] != '-' || s[10] != 'T' || s[13] != ':' ||
        s[16] != ':' || s[19] != '.' || s[23] != 'Z')
        return false;
    for (int i : {0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22})
        if (!isdigit((unsigned char)s[i])) return false;
    struct tm tmv = {};
    tmv.tm_year = atoi(s.substr(0, 4).c_str()) - 1900;
    tmv.tm_mon = atoi(s.substr(5, 2).c_str()) - 1;
    tmv.tm_mday = atoi(s.substr(8, 2).c_str());
    tmv.tm_hour = atoi(s.substr(11, 2).c_str());
    tmv.tm_min = atoi(s.substr(14, 2).c_str());
    tmv.tm_sec = atoi(s.substr(17, 2).c_str());
    time_t t = timegm(&tmv);
    if (t == (time_t)-1) return false;
    out->tv_sec = t;
    out->tv_nsec = (long)atoi(s.substr(20, 3).c_str()) * 1000000L;
    return true;
}

// Split on LF exactly. Requires the data to end with LF (every generated file's last line
// is terminated like the rest); anything else is truncation.
static std::vector<std::string> split_lf_terminated(const std::string& text, const char* what) {
    if (text.empty() || text.back() != '\n')
        die(std::string(what) + ": does not end with LF — truncated or damaged");
    std::vector<std::string> lines;
    size_t start = 0;
    for (size_t i = 0; i < text.size(); i++)
        if (text[i] == '\n') { lines.push_back(text.substr(start, i - start)); start = i + 1; }
    return lines;
}

static Snapshot parse_snapshot(const std::string& text) {
    size_t bad = utf8_invalid_at(text);
    if (bad != std::string::npos)
        die("snapshot is not valid UTF-8 at byte " + std::to_string(bad) + " — damaged");

    std::vector<std::string> lines = split_lf_terminated(text, "snapshot");
    if (lines.empty()) die("snapshot is empty");

    // The trailer check comes first: without #END the rows we read may not be all of them.
    {
        const std::string& last = lines.back();
        std::string marker = trim_spaces(last.substr(0, last.find('\t')));
        if (marker != "#END")
            die("snapshot has no #END trailer (last line: '" + last.substr(0, 60) +
                "') — treat as truncated");
    }

    Snapshot snap;
    std::unordered_set<std::string> seen_paths;
    for (size_t ln = 0; ln < lines.size(); ln++) {
        const std::string& line = lines[ln];
        if (line.empty())
            die("snapshot line " + std::to_string(ln + 1) + " is empty — malformed");
        // The '#' test must come before anything structural.
        if (line[0] == '#') {
            std::string marker = trim_spaces(line.substr(0, line.find('\t')));
            // take text after the Nth tab, or "" if absent
            auto after_tab = [&](int n) -> std::string {
                size_t p = 0;
                for (int i = 0; i < n; i++) {
                    p = line.find('\t', p);
                    if (p == std::string::npos) return "";
                    p++;
                }
                return line.substr(p);
            };
            auto field = [&](int idx) -> std::string {  // trimmed field idx (0-based)
                size_t p = 0;
                for (int i = 0; i < idx; i++) {
                    p = line.find('\t', p);
                    if (p == std::string::npos) return "";
                    p++;
                }
                size_t e = line.find('\t', p);
                return trim_spaces(line.substr(p, e == std::string::npos ? e : e - p));
            };
            if (marker == "#SNAPSHOT") {
                snap.set_name = field(1);
                snap.start_instant = field(2);
                snap.name_and_zone = after_tab(3);
            } else if (marker == "#DIR") {
                std::string d = after_tab(3);   // the path column, verbatim
                if (d.empty()) die("#DIR line with no path (line " + std::to_string(ln + 1) + ")");
                snap.dirs.push_back(d);
            } else if (marker == "#EXCLUDED") snap.excluded++;
            else if (marker == "#SKIPPED") snap.skipped++;
            else if (marker == "#ERROR") snap.errors++;
            else if (marker == "#END") { /* trailer; extra fields ignored by commitment */ }
            else snap.other_meta++;   // unknown metadata kinds may appear; skip them
            continue;
        }
        // file row: hash TAB size TAB mtime TAB path
        size_t t1 = line.find('\t');
        size_t t2 = t1 == std::string::npos ? t1 : line.find('\t', t1 + 1);
        size_t t3 = t2 == std::string::npos ? t2 : line.find('\t', t2 + 1);
        if (t3 == std::string::npos)
            die("file row with fewer than 4 fields at line " + std::to_string(ln + 1));
        FileRow row;
        row.hash = trim_spaces(line.substr(0, t1));
        std::string size_s = trim_spaces(line.substr(t1 + 1, t2 - t1 - 1));
        row.mtime_str = trim_spaces(line.substr(t2 + 1, t3 - t2 - 1));
        row.path = line.substr(t3 + 1);   // verbatim; never trimmed
        if (!is_lower_hex64(row.hash))
            die("bad hash '" + row.hash + "' at line " + std::to_string(ln + 1));
        if (size_s.empty() || size_s.find_first_not_of("0123456789") != std::string::npos)
            die("bad size '" + size_s + "' at line " + std::to_string(ln + 1));
        row.size = strtoull(size_s.c_str(), nullptr, 10);
        if (!parse_mtime(row.mtime_str, &row.mtime))
            die("bad mtime '" + row.mtime_str + "' at line " + std::to_string(ln + 1));
        if (row.path.empty() || row.path.find('\t') != std::string::npos ||
            row.path.find('\r') != std::string::npos)
            die("bad path at line " + std::to_string(ln + 1));
        if (!seen_paths.insert(row.path).second)
            die("path appears twice ('" + row.path + "') — snapshot is malformed; refusing to "
                "guess which row wins");
        snap.rows.push_back(std::move(row));
    }
    return snap;
}

// ---------------------------------------------------------------- deletion records

struct DeletionIndex {
    bool loaded = false;
    // hash -> name of the (first) record that lists it, e.g. "2026-08-20T0136"
    std::unordered_map<std::string, std::string> by_hash;
};

static void load_deletion_records(S3Client& s3, DeletionIndex& idx) {
    if (idx.loaded) return;
    idx.loaded = true;
    auto listing = s3.list("deletions/");
    for (const std::string& key : listing.keys) {
        if (key.size() < 5 || key.substr(key.size() - 4) != ".tsv") continue;
        std::string name = key.substr(strlen("deletions/"));
        name = name.substr(0, name.size() - 4);
        HttpResult r = s3.get_to_memory(key);
        if (r.status != 200) {
            fprintf(stderr, "warning: could not read deletion record %s (HTTP %ld)\n",
                    key.c_str(), r.status);
            continue;
        }
        for (const std::string& line : split_lf_terminated(r.body, "deletion record")) {
            if (line.empty() || line[0] == '#') continue;   // skip every # line; never parse the header
            size_t tab = line.find('\t');
            if (tab == std::string::npos) continue;
            std::string hash = line.substr(0, tab);   // record rows are not column-padded
            if (is_lower_hex64(hash)) idx.by_hash.emplace(hash, name);
        }
    }
    fprintf(stderr, "loaded %zu deletion record hash(es)\n", idx.by_hash.size());
}

// ---------------------------------------------------------------- restore

struct DirMap {
    std::string verbatim;   // as written in #DIR
    std::string prefix;     // dir + "/" (one trailing slash normalized)
    std::string base;       // last path component of dir
};

static bool looks_windows(const std::string& p) {
    return p.size() >= 2 && isalpha((unsigned char)p[0]) && p[1] == ':';
}

static int cmd_restore(S3Client& s3, const std::string& set, const std::string& snapname,
                       const std::string& outdir) {
    std::string key = "snapshots/" + set + "/" + snapname + ".tsv.zst";
    fprintf(stderr, "fetching %s\n", key.c_str());
    HttpResult r = s3.get_to_memory(key);
    if (r.status == 404) die("no such snapshot: " + key);
    if (r.status != 200)
        die("fetching snapshot failed (HTTP " + std::to_string(r.status) + "): " +
            (r.status ? r.body.substr(0, 300) : r.curl_err));
    Snapshot snap = parse_snapshot(zstd_decompress(r.body));
    fprintf(stderr,
            "snapshot %s of set '%s' (started %s): %zu file row(s), %zu dir(s), "
            "%d excluded / %d skipped / %d error rows\n",
            snapname.c_str(), snap.set_name.c_str(), snap.start_instant.c_str(),
            snap.rows.size(), snap.dirs.size(), snap.excluded, snap.skipped, snap.errors);
    if (snap.set_name != set)
        fprintf(stderr, "warning: snapshot header names set '%s', requested '%s'\n",
                snap.set_name.c_str(), set.c_str());

    // Build the output mapping from the #DIR headers.
    std::vector<DirMap> dirs;
    for (const std::string& d : snap.dirs) {
        if (looks_windows(d))
            die("snapshot's member directory '" + d + "' is a Windows-style path; this tool "
                "restores Linux-style paths only (cross-OS restore is a tool decision, and this "
                "tool declines it)");
        std::string trimmed = d;
        while (trimmed.size() > 1 && trimmed.back() == '/') trimmed.pop_back();
        size_t sl = trimmed.find_last_of('/');
        DirMap m;
        m.verbatim = d;
        m.prefix = trimmed + "/";
        m.base = sl == std::string::npos ? trimmed : trimmed.substr(sl + 1);
        if (m.base.empty()) die("#DIR '" + d + "' has no final path component to re-root under");
        dirs.push_back(std::move(m));
    }
    for (size_t i = 0; i < dirs.size(); i++)
        for (size_t j = i + 1; j < dirs.size(); j++)
            if (dirs[i].base == dirs[j].base && dirs[i].prefix != dirs[j].prefix)
                fprintf(stderr, "warning: member dirs '%s' and '%s' share the base name '%s'; "
                        "their contents will merge in the output\n",
                        dirs[i].verbatim.c_str(), dirs[j].verbatim.c_str(), dirs[i].base.c_str());

    fs::create_directories(outdir);

    struct ObjOutcome { int kind; std::string detail; fs::path restored_at; };
    // kind: 0=restored, 1=deleted-by-record, 2=fault
    std::unordered_map<std::string, ObjOutcome> outcome_by_hash;
    DeletionIndex deletions;

    uint64_t n_restored = 0, n_deleted_skip = 0, n_faults = 0, bytes = 0;
    std::vector<std::string> fault_msgs, skip_msgs;

    for (const FileRow& row : snap.rows) {
        // locate the member dir this path belongs to (longest match wins)
        const DirMap* best = nullptr;
        for (const DirMap& m : dirs)
            if (row.path.compare(0, m.prefix.size(), m.prefix) == 0)
                if (!best || m.prefix.size() > best->prefix.size()) best = &m;
        if (!best) {
            n_faults++;
            fault_msgs.push_back("not under any #DIR, nowhere to put it: " + row.path);
            continue;
        }
        std::string rel = row.path.substr(best->prefix.size());
        // refuse traversal in a hand-edited/hostile snapshot rather than escape outdir
        {
            bool bad = false;
            size_t p = 0;
            while (p <= rel.size()) {
                size_t q = rel.find('/', p);
                std::string comp = rel.substr(p, q == std::string::npos ? q : q - p);
                if (comp == ".." || comp.empty() || comp == ".") { bad = true; break; }
                if (q == std::string::npos) break;
                p = q + 1;
            }
            if (bad) {
                n_faults++;
                fault_msgs.push_back("path has unsafe components: " + row.path);
                continue;
            }
        }
        fs::path target = fs::path(outdir) / best->base / rel;

        auto finish_ok = [&](const fs::path& at) {
            struct timespec times[2] = {row.mtime, row.mtime};   // atime unspecified; use mtime
            if (utimensat(AT_FDCWD, at.c_str(), times, 0) != 0) {
                n_faults++;
                fault_msgs.push_back("utimensat failed on " + std::string(at.c_str()) + ": " +
                                     strerror(errno));
            } else {
                n_restored++;
                bytes += row.size;
            }
        };

        std::error_code ec;
        fs::create_directories(target.parent_path(), ec);
        if (ec) { n_faults++; fault_msgs.push_back("mkdir failed for " + row.path); continue; }

        auto cached = outcome_by_hash.find(row.hash);
        if (cached != outcome_by_hash.end()) {
            ObjOutcome& o = cached->second;
            if (o.kind == 0) {
                fs::copy_file(o.restored_at, target, fs::copy_options::overwrite_existing, ec);
                if (ec) { n_faults++; fault_msgs.push_back("local copy failed for " + row.path); }
                else finish_ok(target);
            } else if (o.kind == 1) {
                n_deleted_skip++;
                skip_msgs.push_back(row.path + "  (object " + row.hash.substr(0, 12) +
                                    "… deliberately deleted, record " + o.detail + ")");
            } else {
                n_faults++;
                fault_msgs.push_back(row.path + "  (object " + row.hash.substr(0, 12) + "…: " +
                                     o.detail + ")");
            }
            continue;
        }

        fs::path part = target;
        part += ".s3cab-part";
        FILE* f = fopen(part.c_str(), "wb");
        if (!f) {
            n_faults++;
            fault_msgs.push_back("cannot open for write: " + std::string(part.c_str()) + ": " +
                                 strerror(errno));
            continue;
        }
        HttpResult g = s3.get_to_file("objects/" + row.hash, f);
        bool fclose_ok = fclose(f) == 0;

        if (g.status == 200 && fclose_ok) {
            if (g.file_sha256 != row.hash) {
                fs::remove(part, ec);
                std::string why = "downloaded bytes hash to " + g.file_sha256.substr(0, 12) +
                                  "… not the key — object corrupt in store";
                outcome_by_hash[row.hash] = {2, why, {}};
                n_faults++;
                fault_msgs.push_back(row.path + "  (object " + row.hash.substr(0, 12) + "…: " +
                                     why + ")");
                continue;
            }
            if (g.file_bytes != row.size) {
                // bytes match the hash (the identity); the row's size column disagrees.
                fprintf(stderr, "warning: %s: row says %" PRIu64 " bytes, object is %" PRIu64
                        " (hash matches; trusting the bytes)\n",
                        row.path.c_str(), row.size, g.file_bytes);
            }
            fs::rename(part, target, ec);
            if (ec) {
                n_faults++;
                fault_msgs.push_back("rename failed for " + row.path);
                continue;
            }
            outcome_by_hash[row.hash] = {0, "", target};
            finish_ok(target);
        } else if (g.status == 404) {
            fs::remove(part, ec);
            // Consult the records only when a fetch actually misses.
            load_deletion_records(s3, deletions);
            auto it = deletions.by_hash.find(row.hash);
            if (it != deletions.by_hash.end()) {
                outcome_by_hash[row.hash] = {1, it->second, {}};
                n_deleted_skip++;
                skip_msgs.push_back(row.path + "  (object " + row.hash.substr(0, 12) +
                                    "… deliberately deleted, record " + it->second + ")");
            } else {
                std::string why = "missing from objects/ and no deletion record explains it — "
                                  "integrity fault";
                outcome_by_hash[row.hash] = {2, why, {}};
                n_faults++;
                fault_msgs.push_back(row.path + "  (object " + row.hash.substr(0, 12) + "…: " +
                                     why + ")");
            }
        } else if (g.status == 403) {
            fs::remove(part, ec);
            die("HTTP 403 fetching objects/" + row.hash +
                " — credentials likely expired; not a signing bug if requests worked before. "
                "Body: " + g.body.substr(0, 300));
        } else {
            fs::remove(part, ec);
            std::string why = "HTTP " + std::to_string(g.status) +
                              (g.status == 0 ? " (" + g.curl_err + ")" : "");
            n_faults++;
            fault_msgs.push_back(row.path + "  (object " + row.hash.substr(0, 12) + "…: " + why + ")");
            // do not cache transport-level failures; a later row may succeed
        }
    }

    printf("\nrestore of %s/%s -> %s\n", set.c_str(), snapname.c_str(), outdir.c_str());
    printf("  restored:            %" PRIu64 " file(s), %" PRIu64 " bytes\n", n_restored, bytes);
    printf("  deliberately absent: %" PRIu64 " file(s) (deletion record; expected, not damage)\n",
           n_deleted_skip);
    for (auto& m : skip_msgs) printf("    - %s\n", m.c_str());
    printf("  integrity faults:    %" PRIu64 "\n", n_faults);
    for (auto& m : fault_msgs) printf("    - %s\n", m.c_str());
    if (n_faults) {
        printf("result: INCOMPLETE — restored everything restorable; the faults above need "
               "attention\n");
        return 2;
    }
    printf("result: OK\n");
    return 0;
}

// ---------------------------------------------------------------- list

static int cmd_list(S3Client& s3) {
    auto sets = s3.list("sets/", "/");
    printf("sets:\n");
    for (auto& p : sets.prefixes) {
        std::string name = p.substr(strlen("sets/"));
        if (!name.empty() && name.back() == '/') name.pop_back();
        printf("  %s\n", name.c_str());
    }
    auto snaps = s3.list("snapshots/");
    printf("snapshots:\n");
    for (auto& k : snaps.keys) {
        std::string rest = k.substr(strlen("snapshots/"));
        size_t sl = rest.find('/');
        if (sl == std::string::npos) continue;
        std::string set = rest.substr(0, sl), file = rest.substr(sl + 1);
        const std::string suffix = ".tsv.zst";
        if (file.size() > suffix.size() && file.substr(file.size() - suffix.size()) == suffix)
            printf("  %s  %s\n", set.c_str(), file.substr(0, file.size() - suffix.size()).c_str());
        else
            printf("  %s  %s  (unexpected name)\n", set.c_str(), file.c_str());
    }
    auto dels = s3.list("deletions/");
    printf("deletion records:\n");
    if (dels.keys.empty()) printf("  (none)\n");
    for (auto& k : dels.keys) printf("  %s\n", k.c_str());
    return 0;
}

// ---------------------------------------------------------------- main

int main(int argc, char** argv) {
    std::string bucket, region;
    std::vector<std::string> args;
    for (int i = 1; i < argc; i++) {
        std::string a = argv[i];
        if (a == "--bucket" && i + 1 < argc) bucket = argv[++i];
        else if (a == "--region" && i + 1 < argc) region = argv[++i];
        else args.push_back(a);
    }
    if (region.empty() && getenv("AWS_REGION")) region = getenv("AWS_REGION");
    if (bucket.empty() || region.empty() || args.empty()) {
        fprintf(stderr,
                "usage: s3cab-restore --bucket B --region R list\n"
                "       s3cab-restore --bucket B --region R restore <set> <snapshot> <outdir>\n"
                "       s3cab-restore --bucket B --region R get <key> [outfile]\n");
        return 1;
    }
    Creds creds;
    if (const char* e = getenv("AWS_ACCESS_KEY_ID")) creds.akid = e;
    if (const char* e = getenv("AWS_SECRET_ACCESS_KEY")) creds.secret = e;
    if (const char* e = getenv("AWS_SESSION_TOKEN")) creds.token = e;
    if (creds.akid.empty() || creds.secret.empty())
        die("AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set");

    curl_global_init(CURL_GLOBAL_DEFAULT);
    S3Client s3(bucket, region, creds);

    if (args[0] == "list" && args.size() == 1) return cmd_list(s3);
    if (args[0] == "count" && args.size() == 2) {
        auto l = s3.list(args[1]);
        printf("%zu key(s) under %s\n", l.keys.size(), args[1].c_str());
        std::set<std::string> uniq(l.keys.begin(), l.keys.end());
        if (uniq.size() != l.keys.size()) printf("WARNING: %zu duplicate keys\n",
                                                 l.keys.size() - uniq.size());
        return 0;
    }
    if (args[0] == "restore" && args.size() == 4) return cmd_restore(s3, args[1], args[2], args[3]);
    if (args[0] == "get" && (args.size() == 2 || args.size() == 3)) {
        HttpResult r = s3.get_to_memory(args[1]);
        if (r.status != 200)
            die("GET " + args[1] + " -> HTTP " + std::to_string(r.status) + " " +
                r.body.substr(0, 300) + r.curl_err);
        if (args.size() == 3) {
            FILE* f = fopen(args[2].c_str(), "wb");
            if (!f) die("cannot open " + args[2]);
            fwrite(r.body.data(), 1, r.body.size(), f);
            fclose(f);
        } else {
            fwrite(r.body.data(), 1, r.body.size(), stdout);
        }
        return 0;
    }
    fprintf(stderr, "unknown command\n");
    return 1;
}
