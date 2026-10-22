#include "format.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <unicode/uchar.h>
#include <unicode/ustring.h>
#include <zlib.h>

/* ---------------------------------------------------------------- gzip */

bool gunzip_all(const unsigned char *in, size_t n, buf_t *out, char *err, size_t errlen)
{
    z_stream zs = {0};
    if (inflateInit2(&zs, 16 + MAX_WBITS) != Z_OK) die("inflateInit2 failed");
    zs.next_in = (unsigned char *)in;
    zs.avail_in = (uInt)n;
    size_t members = 0;
    bool ok = false;
    for (;;) {
        buf_reserve(out, 256 * 1024);
        zs.next_out = out->p + out->len;
        zs.avail_out = (uInt)(out->cap - out->len - 1);
        int rc = inflate(&zs, Z_NO_FLUSH);
        out->len = (size_t)(zs.next_out - out->p);
        out->p[out->len] = 0;
        if (rc == Z_STREAM_END) {
            members++;
            if (zs.avail_in == 0) {
                ok = true;
                break;
            }
            inflateReset(&zs); /* another member follows: join it, as s3cab's reader does */
            continue;
        }
        if (rc == Z_OK) continue;
        if (rc == Z_BUF_ERROR && zs.avail_in == 0) {
            snprintf(err, errlen, "gzip stream is cut short%s", members ? " (in a later member)" : "");
            break;
        }
        if (rc == Z_BUF_ERROR) continue;
        snprintf(err, errlen, "%s%s", members ? "bytes after the gzip stream aren't gzip: " : "not valid gzip: ",
                 zs.msg ? zs.msg : "data error");
        break;
    }
    inflateEnd(&zs);
    return ok;
}

/* ---------------------------------------------------------------- UTF-8 */

/* Strict: no overlongs, no surrogates, nothing past U+10FFFF.  Returns offset of the first
 * bad byte, or (size_t)-1 if valid. */
static size_t utf8_check(const unsigned char *p, size_t n)
{
    size_t i = 0;
    while (i < n) {
        unsigned char c = p[i];
        if (c < 0x80) {
            i++;
            continue;
        }
        size_t need;
        unsigned char lo = 0x80, hi = 0xBF;
        if (c >= 0xC2 && c <= 0xDF)
            need = 1;
        else if (c == 0xE0)
            need = 2, lo = 0xA0;
        else if (c >= 0xE1 && c <= 0xEC)
            need = 2;
        else if (c == 0xED)
            need = 2, hi = 0x9F;
        else if (c >= 0xEE && c <= 0xEF)
            need = 2;
        else if (c == 0xF0)
            need = 3, lo = 0x90;
        else if (c >= 0xF1 && c <= 0xF3)
            need = 3;
        else if (c == 0xF4)
            need = 3, hi = 0x8F;
        else
            return i;
        if (i + need >= n) return i; /* truncated sequence */
        if (p[i + 1] < lo || p[i + 1] > hi) return i;
        for (size_t k = 2; k <= need; k++)
            if (p[i + k] < 0x80 || p[i + k] > 0xBF) return i;
        i += need + 1;
    }
    return (size_t)-1;
}

static uint32_t utf8_decode(const unsigned char *p, size_t *len)
{
    if (p[0] < 0x80) return *len = 1, p[0];
    if (p[0] < 0xE0) return *len = 2, (uint32_t)(p[0] & 0x1F) << 6 | (p[1] & 0x3F);
    if (p[0] < 0xF0) return *len = 3, (uint32_t)(p[0] & 0x0F) << 12 | (uint32_t)(p[1] & 0x3F) << 6 | (p[2] & 0x3F);
    return *len = 4,
           (uint32_t)(p[0] & 0x07) << 18 | (uint32_t)(p[1] & 0x3F) << 12 | (uint32_t)(p[2] & 0x3F) << 6 | (p[3] & 0x3F);
}

/* The leading fields' trim set: tab, VT, FF, CR, LF, every Zs, U+2028, U+2029, BOM; not U+0085. */
static bool is_trim_cp(uint32_t c)
{
    if (c == 0x09 || c == 0x0A || c == 0x0B || c == 0x0C || c == 0x0D) return true;
    if (c == 0x2028 || c == 0x2029 || c == 0xFEFF) return true;
    if (c == 0x85) return false;
    return u_charType((UChar32)c) == U_SPACE_SEPARATOR;
}

/* Trim both ends.  The text is already known to be valid UTF-8. */
str_t trim_field(str_t s)
{
    size_t a = 0, b = s.n;
    while (a < b) {
        size_t len;
        uint32_t c = utf8_decode(s.p + a, &len);
        if (!is_trim_cp(c)) break;
        a += len;
    }
    while (b > a) {
        size_t st = b - 1;
        while (st > a && (s.p[st] & 0xC0) == 0x80) st--;
        size_t len;
        uint32_t c = utf8_decode(s.p + st, &len);
        if (!is_trim_cp(c)) break;
        b = st;
    }
    return (str_t){s.p + a, b - a};
}

/* The first four tab-separated fields, and the rest of the line as the fifth. */
void split5(str_t line, str_t f[5], size_t *nf)
{
    size_t start = 0, k = 0;
    for (size_t i = 0; i < 5; i++) f[i] = (str_t){line.p + line.n, 0};
    for (size_t i = 0; i < line.n && k < 4; i++) {
        if (line.p[i] == '\t') {
            f[k++] = (str_t){line.p + start, i - start};
            start = i + 1;
        }
    }
    f[k] = (str_t){line.p + start, line.n - start};
    *nf = k + 1;
}

void lower_utf8(str_t s, buf_t *out)
{
    out->len = 0;
    buf_reserve(out, 0);
    if (s.n == 0) {
        out->p[0] = 0;
        return;
    }
    UErrorCode e = U_ZERO_ERROR;
    int32_t n16 = 0;
    u_strFromUTF8(nullptr, 0, &n16, (const char *)s.p, (int32_t)s.n, &e);
    if (U_FAILURE(e) && e != U_BUFFER_OVERFLOW_ERROR) die("UTF-8 to UTF-16 failed: %s", u_errorName(e));
    UChar *u = xmalloc(((size_t)n16 + 1) * sizeof *u);
    e = U_ZERO_ERROR;
    u_strFromUTF8(u, n16 + 1, nullptr, (const char *)s.p, (int32_t)s.n, &e);
    if (U_FAILURE(e)) die("UTF-8 to UTF-16 failed: %s", u_errorName(e));

    int32_t cap = n16 * 3 + 8, nl;
    UChar *l = xmalloc((size_t)cap * sizeof *l);
    e = U_ZERO_ERROR;
    nl = u_strToLower(l, cap, u, n16, "", &e);
    if (e == U_BUFFER_OVERFLOW_ERROR) {
        free(l);
        cap = nl + 1;
        l = xmalloc((size_t)cap * sizeof *l);
        e = U_ZERO_ERROR;
        nl = u_strToLower(l, cap, u, n16, "", &e);
    }
    if (U_FAILURE(e)) die("u_strToLower failed: %s", u_errorName(e));

    int32_t n8 = 0;
    e = U_ZERO_ERROR;
    u_strToUTF8(nullptr, 0, &n8, l, nl, &e);
    buf_reserve(out, (size_t)n8 + 1);
    e = U_ZERO_ERROR;
    u_strToUTF8((char *)out->p, n8 + 1, nullptr, l, nl, &e);
    if (U_FAILURE(e)) die("UTF-16 to UTF-8 failed: %s", u_errorName(e));
    out->len = (size_t)n8;
    out->p[out->len] = 0;
    free(u);
    free(l);
}

/* ---------------------------------------------------------------- shared whole-file checks */

bool text_lines(const buf_t *text, str_t **lines_out, size_t *nlines_out, char *err, size_t errlen)
{
    const unsigned char *p = text->p ? text->p : (const unsigned char *)"";
    size_t n = text->len;
    size_t bad = utf8_check(p, n);
    if (bad != (size_t)-1) {
        snprintf(err, errlen, "not UTF-8 (bad byte 0x%02x at offset %zu)", p[bad], bad);
        return false;
    }
    if (n >= 3 && p[0] == 0xEF && p[1] == 0xBB && p[2] == 0xBF) p += 3, n -= 3; /* a forgiven BOM */
    if (n == 0) {
        snprintf(err, errlen, "empty");
        return false;
    }
    size_t cap = 64, cnt = 0;
    str_t *lines = xmalloc(cap * sizeof *lines);
    size_t start = 0;
    for (size_t i = 0; i < n; i++) {
        if (p[i] != '\n') continue;
        if (cnt == cap) lines = xrealloc(lines, (cap *= 2) * sizeof *lines);
        lines[cnt++] = (str_t){p + start, i - start};
        start = i + 1;
    }
    bool crlf = cnt > 0 && lines[0].n && lines[0].p[lines[0].n - 1] == '\r';
    if (start != n) {
        str_t last = {p + start, n - start};
        snprintf(err, errlen, "cut short: the last line isn't terminated by LF%s",
                 str_eqz(last, ".") ? " (a '.' without its LF doesn't count)" : "");
        free(lines);
        return false;
    }
    str_t f[5];
    size_t nf;
    split5(lines[0], f, &nf);
    if (nf < 5 || !str_eqz(trim_field(f[0]), "@S3CAB") || !str_eqz(trim_field(f[1]), "FORMAT") ||
        !str_eqz(trim_field(f[2]), "size") || !str_eqz(trim_field(f[3]), "time") || !str_eqz(f[4], HEADING_URL)) {
        snprintf(err, errlen, "doesn't start with the heading row%s",
                 crlf ? " (its lines end CRLF; the format is LF only)" : "");
        free(lines);
        return false;
    }
    size_t dot = 0;
    for (size_t i = 1; i < cnt; i++)
        if (str_eqz(lines[i], ".")) {
            dot = i;
            break;
        }
    if (!dot) {
        snprintf(err, errlen, "cut short: no '.' line at the end%s", crlf ? " (its lines end CRLF; LF only)" : "");
        free(lines);
        return false;
    }
    if (dot != cnt - 1) {
        snprintf(err, errlen, "has %zu line(s) after the '.' (line %zu)", cnt - 1 - dot, dot + 1);
        free(lines);
        return false;
    }
    *lines_out = lines;
    *nlines_out = cnt;
    return true;
}

/* ---------------------------------------------------------------- fields */

static bool is_hash(str_t s)
{
    if (s.n != 64) return false;
    for (size_t i = 0; i < 64; i++) {
        unsigned char c = s.p[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    }
    return true;
}

static bool parse_size(str_t s, uint64_t *out)
{
    if (s.n == 0) return false;
    uint64_t v = 0;
    for (size_t i = 0; i < s.n; i++) {
        unsigned char c = s.p[i];
        if (c < '0' || c > '9') return false;
        if (v > (UINT64_MAX - (c - '0')) / 10) return false;
        v = v * 10 + (c - '0');
    }
    *out = v;
    return true;
}

static int64_t days_from_civil(int64_t y, int m, int d)
{
    y -= m <= 2;
    int64_t era = (y >= 0 ? y : y - 399) / 400;
    int64_t yoe = y - era * 400;
    int64_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + doe - 719468;
}

static int num(const unsigned char *p, int n)
{
    int v = 0;
    for (int i = 0; i < n; i++) {
        if (p[i] < '0' || p[i] > '9') return -1;
        v = v * 10 + (p[i] - '0');
    }
    return v;
}

/* Exactly YYYY-MM-DDTHH:MM:SS.sssZ, and a real instant (proleptic Gregorian, no leap second). */
bool parse_mtime(str_t s, int64_t *sec, int32_t *ms)
{
    if (s.n != 24) return false;
    const unsigned char *p = s.p;
    if (p[4] != '-' || p[7] != '-' || p[10] != 'T' || p[13] != ':' || p[16] != ':' || p[19] != '.' || p[23] != 'Z')
        return false;
    int y = num(p, 4), mo = num(p + 5, 2), d = num(p + 8, 2), h = num(p + 11, 2), mi = num(p + 14, 2),
        se = num(p + 17, 2), f = num(p + 20, 3);
    if (y < 0 || mo < 1 || mo > 12 || d < 1 || h < 0 || h > 23 || mi < 0 || mi > 59 || se < 0 || se > 59 || f < 0)
        return false;
    static const int mdays[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    bool leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    if (d > mdays[mo - 1] + (mo == 2 && leap)) return false;
    *sec = days_from_civil(y, mo, d) * 86400 + h * 3600 + mi * 60 + se;
    *ms = f;
    return true;
}

/* ---------------------------------------------------------------- paths */

static bool is_sep(enum pkind k, unsigned char c) { return c == '/' || (k != PK_POSIX && c == '\\'); }

static bool ascii_alpha(unsigned char c) { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'); }

/* Cut an absolute path into root and segments.  For a DIR, trailing separators are ignored
 * (after the root) and segments aren't judged; for a file row every segment must be a name.
 * Returns nullptr on success, or why the path is refused. */
static const char *parse_path(str_t s, bool is_dir, path_t *out)
{
    *out = (path_t){0};
    size_t rootlen;
    if (s.n >= 3 && ascii_alpha(s.p[0]) && s.p[1] == ':' && (s.p[2] == '\\' || s.p[2] == '/')) {
        out->kind = PK_DRIVE;
        out->drive = s.p[0];
        rootlen = 3;
    } else if (s.n >= 2 && ((s.p[0] == '\\' && s.p[1] == '\\') || (s.p[0] == '/' && s.p[1] == '/'))) {
        out->kind = PK_UNC;
        rootlen = 2;
    } else if (s.n >= 1 && s.p[0] == '/') {
        out->kind = PK_POSIX;
        rootlen = 1;
    } else {
        return "path isn't absolute";
    }
    str_t rest = {s.p + rootlen, s.n - rootlen};
    if (is_dir)
        while (rest.n && is_sep(out->kind, rest.p[rest.n - 1])) rest.n--;
    if (rest.n == 0) {
        if (!is_dir) return "path is a root, not a file";
        return nullptr;
    }
    size_t cap = 8;
    out->seg = xmalloc(cap * sizeof *out->seg);
    size_t st = 0;
    for (size_t i = 0; i <= rest.n; i++) {
        if (i < rest.n && !is_sep(out->kind, rest.p[i])) continue;
        if (out->nseg == cap) out->seg = xrealloc(out->seg, (cap *= 2) * sizeof *out->seg);
        out->seg[out->nseg++] = (str_t){rest.p + st, i - st};
        st = i + 1;
    }
    if (!is_dir) {
        for (size_t i = 0; i < out->nseg; i++) {
            str_t g = out->seg[i];
            if (g.n == 0)
                return i + 1 == out->nseg ? "path ends with a separator" : "path has an empty segment (doubled separator)";
            if (str_eqz(g, ".")) return "path has a '.' segment";
            if (str_eqz(g, "..")) return "path has a '..' segment";
        }
    }
    return nullptr;
}

static bool windowsish(enum pkind k) { return k == PK_DRIVE || k == PK_UNC; }

static buf_t *lower_segments(const path_t *p)
{
    buf_t *l = xcalloc(p->nseg ? p->nseg : 1, sizeof *l);
    for (size_t i = 0; i < p->nseg; i++) lower_utf8(p->seg[i], &l[i]);
    return l;
}

static unsigned char ascii_lower(unsigned char c) { return c >= 'A' && c <= 'Z' ? c + 32 : c; }

/* Does DIR d contain (or equal) the file path?  Returns the DIR's depth, or -1. */
static long dir_match(const dir_t *d, const frow_t *r)
{
    const path_t *dp = &d->path, *fp = &r->path;
    if (dp->kind != fp->kind || dp->nseg > fp->nseg) return -1;
    if (dp->kind == PK_DRIVE && ascii_lower(dp->drive) != ascii_lower(fp->drive)) return -1;
    for (size_t i = 0; i < dp->nseg; i++) {
        if (windowsish(dp->kind)) {
            const buf_t *a = &d->lseg[i], *b = &r->lseg[i];
            if (a->len != b->len || memcmp(a->p, b->p, a->len) != 0) return -1;
        } else if (!str_eq(dp->seg[i], fp->seg[i])) {
            return -1;
        }
    }
    return (long)dp->nseg;
}

/* An exact key for a path: kind, drive as spelled, segments as spelled.  Segments never hold
 * a separator, so joining them with '/' is unambiguous. */
static void path_key(const path_t *p, size_t nseg, buf_t *k)
{
    k->len = 0;
    unsigned char hdr[2] = {(unsigned char)('0' + p->kind), p->kind == PK_DRIVE ? p->drive : '-'};
    buf_add(k, hdr, 2);
    for (size_t i = 0; i < nseg; i++) {
        buf_add(k, "/", 1);
        buf_add(k, p->seg[i].p, p->seg[i].n);
    }
}

/* ---------------------------------------------------------------- snapshot */

static void warnf(snap_t *s, size_t line, const char *fmt, const char *arg)
{
    s->warnings++;
    fprintf(stderr, "s3cab-restore: warning: line %zu: ", line);
    fprintf(stderr, fmt, arg);
    fputc('\n', stderr);
}

static void refuse(frow_t *r, const char *why)
{
    if (!r->ok) return; /* keep the first reason */
    r->ok = false;
    snprintf(r->why, sizeof r->why, "%s", why);
}

bool snap_parse(snap_t *s, char *err, size_t errlen)
{
    if (!text_lines(&s->text, &s->lines, &s->nlines, err, errlen)) return false;
    size_t dcap = 4, rcap = 64;
    s->dirs = xmalloc(dcap * sizeof *s->dirs);
    s->rows = xmalloc(rcap * sizeof *s->rows);
    for (size_t i = 1; i + 1 < s->nlines; i++) {
        str_t f[5];
        size_t nf;
        split5(s->lines[i], f, &nf);
        str_t type = trim_field(f[0]);
        size_t lineno = i + 1;
        if (type.n && type.p[0] == '@') {
            str_t prop = nf >= 2 ? trim_field(f[1]) : (str_t){0};
            if (str_eqz(type, "@SET") && str_eqz(prop, "DIR")) {
                if (nf < 5) {
                    warnf(s, lineno, "%s", "@SET DIR row has no value column; ignored");
                    continue;
                }
                if (s->ndirs == dcap) s->dirs = xrealloc(s->dirs, (dcap *= 2) * sizeof *s->dirs);
                dir_t *d = &s->dirs[s->ndirs++];
                *d = (dir_t){.line = lineno, .raw = f[4], .alias_of = -1};
            } else if (str_eqz(type, "@S3CAB") && str_eqz(prop, "SPEC") && nf >= 5) {
                s->spec = f[4];
            } else if (str_eqz(type, "@SET") && str_eqz(prop, "NAME") && nf >= 5) {
                s->set_name = f[4];
            } else if (str_eqz(type, "@SNAPSHOT") && str_eqz(prop, "NAME") && nf >= 5) {
                s->snap_name = f[4];
            } else {
                s->skipped_rows++;
            }
            continue;
        }
        if (type.n && type.p[0] == '#') {
            s->skipped_rows++;
            continue;
        }
        if (!str_eqz(type, "-")) {
            char t[80];
            size_t tn = type.n < 60 ? type.n : 60;
            memcpy(t, type.p, tn);
            t[tn] = 0;
            for (size_t k = 0; k < tn; k++)
                if ((unsigned char)t[k] < 0x20) t[k] = '?';
            snprintf(err, errlen, "line %zu has an unknown row type '%s'%s", lineno, t,
                     type.n ? "" : " (blank first field)");
            return false;
        }
        if (s->nrows == rcap) s->rows = xrealloc(s->rows, (rcap *= 2) * sizeof *s->rows);
        frow_t *r = &s->rows[s->nrows++];
        *r = (frow_t){.line = lineno, .ok = true, .dir = -1, .tie_dir = -1};
        if (nf < 5) {
            char why[64];
            snprintf(why, sizeof why, "malformed file row: %zu field(s), not 5", nf);
            refuse(r, why);
            continue;
        }
        r->raw = f[4];
        const char *pwhy = nullptr;
        if (memchr(r->raw.p, '\t', r->raw.n))
            pwhy = "malformed file row: more than five fields (a tab in the path)";
        else if (memchr(r->raw.p, '\r', r->raw.n))
            pwhy = "path holds a CR";
        else
            pwhy = parse_path(r->raw, false, &r->path);
        if (pwhy)
            refuse(r, pwhy);
        else
            r->path_ok = true;

        str_t h = trim_field(f[1]), sz = trim_field(f[2]), tm = trim_field(f[3]);
        if (!is_hash(h))
            refuse(r, "malformed file row: hash isn't 64 lowercase hex characters");
        else
            memcpy(r->hash, h.p, 64), r->hash[64] = 0;
        if (!parse_size(sz, &r->size)) refuse(r, "malformed file row: size isn't a decimal number");
        if (!parse_mtime(tm, &r->sec, &r->ms))
            refuse(r, "malformed file row: modification time isn't a valid YYYY-MM-DDTHH:MM:SS.sssZ");
    }
    return true;
}

void snap_check(snap_t *s)
{
    /* DIRs: parse, name, lowercase, and fold identical rows into one. */
    for (size_t i = 0; i < s->ndirs; i++) {
        dir_t *d = &s->dirs[i];
        if (parse_path(d->raw, true, &d->path)) {
            warnf(s, d->line, "%s", "@SET DIR isn't an absolute path; it matches nothing");
            continue;
        }
        if (d->path.kind == PK_UNC && d->path.nseg == 0) {
            warnf(s, d->line, "%s", "@SET DIR is a bare \\\\ with no server or share; it matches nothing");
            continue;
        }
        d->usable = true;
        if (d->path.nseg) {
            d->name = d->path.seg[d->path.nseg - 1];
            d->has_folder = true;
        } else if (d->path.kind == PK_DRIVE) {
            d->name = (str_t){d->raw.p, 1}; /* a drive root's folder is its letter */
            d->has_folder = true;
        } else {
            d->has_folder = false; /* "/" */
        }
        if (windowsish(d->path.kind)) d->lseg = lower_segments(&d->path);
        buf_t ki = {0}, kj = {0};
        path_key(&d->path, d->path.nseg, &ki);
        for (size_t j = 0; j < i; j++) {
            dir_t *e = &s->dirs[j];
            if (!e->usable || e->alias_of >= 0) continue;
            path_key(&e->path, e->path.nseg, &kj);
            if (ki.len == kj.len && memcmp(ki.p, kj.p, ki.len) == 0) {
                d->alias_of = (int)j;
                break;
            }
        }
        buf_free(&ki);
        buf_free(&kj);
    }

    /* Each file row: under a DIR (deepest wins), and never a DIR itself. */
    for (size_t i = 0; i < s->nrows; i++) {
        frow_t *r = &s->rows[i];
        if (!r->path_ok) continue;
        if (windowsish(r->path.kind)) r->lseg = lower_segments(&r->path);
        long best = -1;
        bool is_dir = false;
        for (size_t j = 0; j < s->ndirs; j++) {
            dir_t *d = &s->dirs[j];
            if (!d->usable || d->alias_of >= 0) continue;
            long depth = dir_match(d, r);
            if (depth < 0) continue;
            if ((size_t)depth == r->path.nseg) {
                is_dir = true;
                continue;
            }
            if (depth > best) {
                best = depth;
                r->dir = (int)j;
                r->tie_dir = -1;
            } else if (depth == best && r->tie_dir < 0) {
                r->tie_dir = (int)j;
            }
        }
        if (is_dir)
            refuse(r, "path is a member directory (@SET DIR) itself");
        else if (best < 0)
            refuse(r, "path isn't under any @SET DIR");
    }

    /* Each path in at most one file row: every row with a well-formed path takes part, so a
     * malformed twin still blocks its sibling (no reader chooses between them). */
    sset_t seen = {0};
    buf_t key = {0};
    size_t *first = xcalloc(s->nrows, sizeof *first); /* 1 + index of the group's first row */
    bool *dup = xcalloc(s->nrows, sizeof *dup);
    for (size_t i = 0; i < s->nrows; i++) {
        frow_t *r = &s->rows[i];
        if (!r->path_ok) continue;
        path_key(&r->path, r->path.nseg, &key);
        size_t other;
        if (!sset_add(&seen, key.p, key.len, i, &other)) {
            dup[i] = dup[other] = true;
            first[i] = other + 1;
        }
    }
    for (size_t i = 0; i < s->nrows; i++) {
        if (!dup[i]) continue;
        frow_t *r = &s->rows[i];
        size_t other_line = first[i] ? s->rows[first[i] - 1].line : 0;
        for (size_t j = i + 1; !other_line && j < s->nrows; j++)
            if (first[j] == i + 1) other_line = s->rows[j].line;
        char why[120];
        snprintf(why, sizeof why, "the same path is in another file row (line %zu); both refused", other_line);
        r->ok = true; /* this reason replaces a lesser one, so the report names the conflict */
        refuse(r, why);
    }
    sset_free(&seen);

    /* Last, among the rows every other check let through: no file row running through another. */
    sset_t live = {0};
    for (size_t i = 0; i < s->nrows; i++) {
        frow_t *r = &s->rows[i];
        if (!r->ok) continue;
        path_key(&r->path, r->path.nseg, &key);
        sset_add(&live, key.p, key.len, i, nullptr);
    }
    size_t *through = xcalloc(s->nrows, sizeof *through); /* 1 + index of the conflicting row */
    for (size_t i = 0; i < s->nrows; i++) {
        frow_t *r = &s->rows[i];
        if (!r->ok) continue;
        for (size_t k = 1; k < r->path.nseg; k++) {
            path_key(&r->path, k, &key);
            size_t j;
            if (sset_has(&live, key.p, key.len, &j)) {
                through[i] = j + 1;
                if (!through[j]) through[j] = i + 1;
            }
        }
    }
    for (size_t i = 0; i < s->nrows; i++) {
        if (!through[i]) continue;
        char why[140];
        snprintf(why, sizeof why, "a file row's path runs through another file row's as a folder (line %zu); both refused",
                 s->rows[through[i] - 1].line);
        refuse(&s->rows[i], why);
    }
    sset_free(&live);
    buf_free(&key);
    free(first);
    free(dup);
    free(through);

    for (size_t i = 0; i < s->nrows; i++) {
        frow_t *r = &s->rows[i];
        if (!r->ok) continue;
        s->dirs[r->dir].reached++;
        if (r->tie_dir >= 0) s->dirs[r->tie_dir].reached++;
    }
}

static void add_raw(buf_t *b, str_t s)
{
    for (size_t i = 0; i < s.n; i++) {
        if (s.p[i] < 0x20 || s.p[i] == 0x7f)
            buf_addf(b, "\\x%02x", s.p[i]);
        else
            buf_add(b, s.p + i, 1);
    }
}

bool snap_layout_ok(const snap_t *s, buf_t *why)
{
    bool ok = true;
    size_t nreached = 0;
    for (size_t i = 0; i < s->ndirs; i++) nreached += s->dirs[i].reached > 0;
    buf_t la = {0}, lb = {0};
    for (size_t i = 0; i < s->ndirs; i++) {
        const dir_t *a = &s->dirs[i];
        if (!a->reached) continue;
        if (!a->has_folder && nreached > 1) {
            buf_adds(why, "s3cab-restore: refused: @SET DIR ");
            add_raw(why, a->raw);
            buf_addf(why, " (line %zu) has no folder of its own, so its files would mix with another DIR's\n", a->line);
            ok = false;
        }
        if (a->has_folder && (a->name.n == 0 || str_eqz(a->name, ".") || str_eqz(a->name, "..") ||
                              memchr(a->name.p, '/', a->name.n) || memchr(a->name.p, 0, a->name.n))) {
            buf_adds(why, "s3cab-restore: refused: @SET DIR ");
            add_raw(why, a->raw);
            buf_adds(why, " has no usable folder name\n");
            ok = false;
        }
        for (size_t j = i + 1; j < s->ndirs && a->has_folder; j++) {
            const dir_t *b = &s->dirs[j];
            if (!b->reached || !b->has_folder) continue;
            lower_utf8(a->name, &la);
            lower_utf8(b->name, &lb);
            if (la.len == lb.len && memcmp(la.p, lb.p, la.len) == 0) {
                buf_adds(why, "s3cab-restore: refused: @SET DIRs ");
                add_raw(why, a->raw);
                buf_adds(why, " and ");
                add_raw(why, b->raw);
                buf_addf(why, " (lines %zu, %zu) would share one folder\n", a->line, b->line);
                ok = false;
            }
        }
    }
    buf_free(&la);
    buf_free(&lb);
    if (!why->p) buf_adds(why, "");
    return ok;
}

void snap_free(snap_t *s)
{
    for (size_t i = 0; i < s->ndirs; i++) {
        free(s->dirs[i].path.seg);
        if (s->dirs[i].lseg) {
            for (size_t k = 0; k < s->dirs[i].path.nseg; k++) buf_free(&s->dirs[i].lseg[k]);
            free(s->dirs[i].lseg);
        }
    }
    for (size_t i = 0; i < s->nrows; i++) {
        free(s->rows[i].path.seg);
        if (s->rows[i].lseg) {
            for (size_t k = 0; k < s->rows[i].path.nseg; k++) buf_free(&s->rows[i].lseg[k]);
            free(s->rows[i].lseg);
        }
    }
    free(s->dirs);
    free(s->rows);
    free(s->lines);
    buf_free(&s->text);
    *s = (snap_t){0};
}

/* ---------------------------------------------------------------- deletion records */

bool rec_parse(const buf_t *text, const char *key, delset_t *ds, char *err, size_t errlen)
{
    str_t *lines;
    size_t nlines;
    if (!text_lines(text, &lines, &nlines, err, errlen)) {
        ds->refused_records++;
        return false;
    }
    size_t base = ds->n, refused_rows = 0;
    delrow_t *tmp = nullptr;
    size_t ntmp = 0;
    bool ok = true;
    for (size_t i = 1; i + 1 < nlines && ok; i++) {
        str_t f[5];
        size_t nf;
        split5(lines[i], f, &nf);
        str_t type = trim_field(f[0]);
        if (type.n && type.p[0] == '@') continue;
        if (type.n && type.p[0] == '#') {
            if (!str_eqz(type, "#deleted")) continue;
            str_t h = nf >= 2 ? trim_field(f[1]) : (str_t){0}, sz = nf >= 3 ? trim_field(f[2]) : (str_t){0},
                  tm = nf >= 4 ? trim_field(f[3]) : (str_t){0};
            uint64_t size;
            int64_t sec;
            int32_t ms;
            if (nf < 5 || !is_hash(h) || !parse_size(sz, &size) || !parse_mtime(tm, &sec, &ms)) {
                fprintf(stderr, "s3cab-restore: warning: %s line %zu: malformed #deleted row refused (its object counts as not deleted)\n",
                        key, i + 1);
                refused_rows++;
                continue;
            }
            tmp = xrealloc(tmp, (ntmp + 1) * sizeof *tmp);
            delrow_t *d = &tmp[ntmp++];
            memcpy(d->hash, h.p, 64);
            d->hash[64] = 0;
            memcpy(d->when, tm.p, 24);
            d->when[24] = 0;
            d->who = str_dup(f[4]);
            d->record = xstrdup(key);
            continue;
        }
        if (str_eqz(type, "-"))
            snprintf(err, errlen, "line %zu is a file row, which a deletion record can't hold", i + 1);
        else
            snprintf(err, errlen, "line %zu has an unknown row type", i + 1);
        ok = false;
    }
    free(lines);
    if (!ok) {
        for (size_t i = 0; i < ntmp; i++) free(tmp[i].who), free(tmp[i].record);
        free(tmp);
        ds->refused_records++;
        return false;
    }
    ds->refused_rows += refused_rows;
    (void)base;
    for (size_t i = 0; i < ntmp; i++) {
        size_t at;
        if (sset_has(&ds->idx, tmp[i].hash, 64, &at)) {
            /* the same hash in two rows: keep the newest date, for the report */
            if (strcmp(tmp[i].when, ds->rows[at].when) > 0) {
                free(ds->rows[at].who), free(ds->rows[at].record);
                ds->rows[at] = tmp[i];
            } else {
                free(tmp[i].who), free(tmp[i].record);
            }
            continue;
        }
        ds->rows = xrealloc(ds->rows, (ds->n + 1) * sizeof *ds->rows);
        ds->rows[ds->n] = tmp[i];
        sset_add(&ds->idx, tmp[i].hash, 64, ds->n, nullptr);
        ds->n++;
    }
    free(tmp);
    return true;
}

const delrow_t *del_lookup(const delset_t *ds, const char *hash)
{
    size_t at;
    return sset_has(&ds->idx, hash, 64, &at) ? &ds->rows[at] : nullptr;
}
