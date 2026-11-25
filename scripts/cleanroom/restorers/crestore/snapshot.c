// Reading a snapshot and a deletion record, by format.md's rules.
#define _GNU_SOURCE
#include "snapshot.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <unicode/ucasemap.h>
#include <zlib.h>

static const char HEADING_URL[] = "https://s3cab.plantegral.com/guide/format";

struct dir_spec {
    str value;
    path_kind kind;
    char drive;
    bool usable; // it can match a path at all
    bool owned;  // seg[i].p are lowercased copies to free
    size_t nseg;
    str *seg;
};

// ---------------------------------------------------------------- gzip

bool snapshot_gunzip(const unsigned char *gz, size_t n, buf *text, const char **why) {
    z_stream z = {};
    if (inflateInit2(&z, 15 + 16) != Z_OK) die("zlib: inflateInit2 failed"); // 15+16: gzip only
    size_t pos = 0;
    bool any = false, ok = false;
    *why = nullptr;
    while (pos < n) {
        if (gz[pos] == 0) {
            if (!any) {
                *why = "a zero byte comes before the first gzip stream";
                goto out;
            }
            break; // padding after a stream: it and everything after it are ignored
        }
        for (;;) { // one gzip stream
            size_t avail = n - pos;
            if (avail > (1u << 30)) avail = 1u << 30;
            buf_reserve(text, 1 << 16);
            size_t room = text->cap - text->n - 1;
            if (room > (1u << 30)) room = 1u << 30;
            z.next_in = (Bytef *)(gz + pos);
            z.avail_in = (uInt)avail;
            z.next_out = (Bytef *)(text->p + text->n);
            z.avail_out = (uInt)room;
            int r = inflate(&z, Z_NO_FLUSH);
            pos += avail - z.avail_in;
            text->n += room - z.avail_out;
            if (r == Z_STREAM_END) break;
            if (r == Z_OK || r == Z_BUF_ERROR) {
                // Out of input without Z_STREAM_END: the stream was cut short.
                if (pos == n && z.avail_out != 0) {
                    *why = "a gzip stream is cut short";
                    goto out;
                }
                continue;
            }
            *why = z.msg ? z.msg : "gzip error"; // zlib's messages are static strings
            goto out;
        }
        any = true;
        inflateReset(&z);
    }
    ok = true;
out:
    inflateEnd(&z);
    buf_cstr(text);
    return ok;
}

// ---------------------------------------------------------------- text

static bool cont(unsigned char c) { return (c & 0xC0) == 0x80; }

// Strict UTF-8: no overlong form, no surrogate, nothing past U+10FFFF.
static bool utf8_valid(const char *s, size_t n) {
    const unsigned char *p = (const unsigned char *)s;
    size_t i = 0;
    while (i < n) {
        unsigned char c = p[i];
        if (c < 0x80) {
            i++;
        } else if (c >= 0xC2 && c <= 0xDF) {
            if (n - i < 2 || !cont(p[i + 1])) return false;
            i += 2;
        } else if (c >= 0xE0 && c <= 0xEF) {
            if (n - i < 3 || !cont(p[i + 1]) || !cont(p[i + 2])) return false;
            if (c == 0xE0 && p[i + 1] < 0xA0) return false;
            if (c == 0xED && p[i + 1] > 0x9F) return false;
            i += 3;
        } else if (c >= 0xF0 && c <= 0xF4) {
            if (n - i < 4 || !cont(p[i + 1]) || !cont(p[i + 2]) || !cont(p[i + 3])) return false;
            if (c == 0xF0 && p[i + 1] < 0x90) return false;
            if (c == 0xF4 && p[i + 1] > 0x8F) return false;
            i += 4;
        } else {
            return false;
        }
    }
    return true;
}

// One code point of valid UTF-8.
static uint32_t utf8_at(const char *s, size_t *len) {
    const unsigned char *p = (const unsigned char *)s;
    if (p[0] < 0x80) return *len = 1, p[0];
    if (p[0] < 0xE0) return *len = 2, (uint32_t)(p[0] & 0x1F) << 6 | (p[1] & 0x3F);
    if (p[0] < 0xF0) return *len = 3, (uint32_t)(p[0] & 0x0F) << 12 | (uint32_t)(p[1] & 0x3F) << 6 | (p[2] & 0x3F);
    return *len = 4, (uint32_t)(p[0] & 0x07) << 18 | (uint32_t)(p[1] & 0x3F) << 12 | (uint32_t)(p[2] & 0x3F) << 6 |
                         (p[3] & 0x3F);
}

// The trim set, JavaScript's trim(): U+0009 to U+000D, category Zs, U+2028, U+2029, U+FEFF.
static bool in_trim_set(uint32_t cp) {
    return (cp >= 0x09 && cp <= 0x0D) || cp == 0x20 || cp == 0xA0 || cp == 0x1680 || (cp >= 0x2000 && cp <= 0x200A) ||
           cp == 0x2028 || cp == 0x2029 || cp == 0x202F || cp == 0x205F || cp == 0x3000 || cp == 0xFEFF;
}

static str trim(str s) {
    while (s.n) {
        size_t len;
        if (!in_trim_set(utf8_at(s.p, &len))) break;
        s.p += len;
        s.n -= len;
    }
    while (s.n) {
        size_t i = s.n - 1, len;
        while (i > 0 && cont((unsigned char)s.p[i])) i--;
        if (!in_trim_set(utf8_at(s.p + i, &len))) break;
        s.n = i;
    }
    return s;
}

static bool str_is(str s, const char *lit) {
    size_t n = strlen(lit);
    return s.n == n && memcmp(s.p, lit, n) == 0;
}

static int str_cmp(str a, str b) {
    size_t m = a.n < b.n ? a.n : b.n;
    int c = m ? memcmp(a.p, b.p, m) : 0;
    if (c) return c;
    return (a.n > b.n) - (a.n < b.n);
}

// Split a line at its first four tabs. Returns how many fields the line has (1 to 5); the
// missing ones read as empty.
static int split5(str line, str f[5]) {
    int count = 0;
    const char *p = line.p, *end = line.p + line.n;
    while (count < 4) {
        const char *tab = memchr(p, '\t', (size_t)(end - p));
        if (!tab) break;
        f[count++] = (str){p, (size_t)(tab - p)};
        p = tab + 1;
    }
    f[count++] = (str){p, (size_t)(end - p)};
    for (int i = count; i < 5; i++) f[i] = (str){end, 0};
    return count;
}

static bool is_hash(str s) {
    if (s.n != 64) return false;
    for (size_t i = 0; i < 64; i++)
        if (!((s.p[i] >= '0' && s.p[i] <= '9') || (s.p[i] >= 'a' && s.p[i] <= 'f'))) return false;
    return true;
}

static bool is_decimal(str s) {
    if (s.n == 0) return false;
    for (size_t i = 0; i < s.n; i++)
        if (s.p[i] < '0' || s.p[i] > '9') return false;
    return true;
}

static int64_t days_from_civil(int64_t y, int m, int d) {
    y -= m <= 2;
    int64_t era = (y >= 0 ? y : y - 399) / 400;
    int64_t yoe = y - era * 400;
    int64_t doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
    int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + doe - 719468;
}

bool instant_parse(str s, int64_t *ms) {
    static const char shape[] = "dddd-dd-ddTdd:dd:dd.dddZ";
    if (s.n != 24) return false;
    for (int i = 0; i < 24; i++) {
        if (shape[i] == 'd') {
            if (s.p[i] < '0' || s.p[i] > '9') return false;
        } else if (s.p[i] != shape[i]) {
            return false;
        }
    }
    const char *p = s.p;
    int year = (p[0] - '0') * 1000 + (p[1] - '0') * 100 + (p[2] - '0') * 10 + (p[3] - '0');
    int month = (p[5] - '0') * 10 + (p[6] - '0');
    int day = (p[8] - '0') * 10 + (p[9] - '0');
    int hour = (p[11] - '0') * 10 + (p[12] - '0');
    int minute = (p[14] - '0') * 10 + (p[15] - '0');
    int second = (p[17] - '0') * 10 + (p[18] - '0');
    int milli = (p[20] - '0') * 100 + (p[21] - '0') * 10 + (p[22] - '0');
    // The proleptic Gregorian calendar: year 0000 is a leap year, October 1582 has 31 days.
    bool leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    static const int month_days[12] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    if (month < 1 || month > 12) return false;
    int last = month_days[month - 1] + (month == 2 && leap);
    if (day < 1 || day > last || hour > 23 || minute > 59 || second > 59) return false;
    if (ms)
        *ms = ((days_from_civil(year, month, day) * 24 + hour) * 60 + minute) * 60'000 + second * 1000 + milli;
    return true;
}

// ---------------------------------------------------------------- paths

static bool ascii_letter(char c) { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z'); }
static bool win_sep(char c) { return c == '\\' || c == '/'; }

typedef struct {
    path_kind kind;
    char drive;
    size_t root; // bytes of the root
    size_t nseg;
    str *seg;
    bool empty_segment;
} parsed_path;

// A path's kind is told by its first characters alone. A Windows path splits on both
// separators, any other on '/' alone. For a @SET DIR, the separators it ends with (after
// the root) are ignored first.
static parsed_path parse_path(str s, bool is_dir) {
    parsed_path r = {};
    if (s.n >= 3 && ascii_letter(s.p[0]) && s.p[1] == ':' && win_sep(s.p[2])) {
        r.kind = PATH_DRIVE;
        r.drive = (char)(s.p[0] & ~0x20);
        r.root = 3;
    } else if (s.n >= 2 && win_sep(s.p[0]) && win_sep(s.p[1])) {
        r.kind = PATH_SHARE;
        r.root = 2;
    } else if (s.n >= 1 && s.p[0] == '/') {
        r.kind = PATH_POSIX;
        r.root = 1;
    } else {
        return r;
    }
    bool win = r.kind != PATH_POSIX;
    const char *p = s.p + r.root;
    size_t n = s.n - r.root;
    if (is_dir)
        while (n && (win ? win_sep(p[n - 1]) : p[n - 1] == '/')) n--;
    if (n == 0) return r;
    size_t count = 1;
    for (size_t i = 0; i < n; i++)
        if (win ? win_sep(p[i]) : p[i] == '/') count++;
    r.seg = xmalloc(count * sizeof *r.seg);
    size_t start = 0;
    for (size_t i = 0; i <= n; i++) {
        if (i == n || (win ? win_sep(p[i]) : p[i] == '/')) {
            if (i == start) r.empty_segment = true;
            r.seg[r.nseg++] = (str){p + start, i - start};
            start = i + 1;
        }
    }
    return r;
}

// Unicode's full default lowercase mapping, Final_Sigma included, as JavaScript's
// toLowerCase() gives: ICU with the root locale.
static str lower_dup(str s) {
    static UCaseMap *map;
    UErrorCode e = U_ZERO_ERROR;
    if (!map) {
        map = ucasemap_open("", 0, &e);
        if (U_FAILURE(e)) die("ICU: ucasemap_open failed: %s", u_errorName(e));
    }
    if (s.n > INT32_MAX / 4) die("a path segment is too long");
    int32_t cap = (int32_t)s.n * 3 + 16;
    char *out = xmalloc((size_t)cap);
    int32_t len = ucasemap_utf8ToLower(map, out, cap, s.p, (int32_t)s.n, &e);
    if (U_FAILURE(e)) die("ICU: lowercasing failed: %s", u_errorName(e));
    return (str){out, (size_t)len};
}

static void dir_add(snapshot *s, str value) {
    s->dirs = xrealloc(s->dirs, (s->ndirs + 1) * sizeof *s->dirs);
    struct dir_spec *d = &s->dirs[s->ndirs++];
    parsed_path p = parse_path(value, true);
    *d = (struct dir_spec){.value = value, .kind = p.kind, .drive = p.drive, .nseg = p.nseg, .seg = p.seg};
    // A DIR that isn't absolute matches nothing; nor one with an empty segment left after
    // its trailing separators are dropped; nor a share with no server or no share name.
    d->usable = p.kind != PATH_NOT_ABSOLUTE && !p.empty_segment && !(p.kind == PATH_SHARE && p.nseg < 2);
    if (d->usable && p.kind != PATH_POSIX) {
        for (size_t i = 0; i < d->nseg; i++) d->seg[i] = lower_dup(d->seg[i]);
        d->owned = true;
    }
}

enum { REL_NONE, REL_INSIDE, REL_EQUAL };

// Whole segments, never a string prefix. `seg` is the row's segments, lowercased already
// when the row is a Windows path.
static int dir_relation(const struct dir_spec *d, const file_row *r, const str *seg) {
    if (!d->usable || d->kind != r->kind) return REL_NONE;
    if (d->kind == PATH_DRIVE && d->drive != r->drive) return REL_NONE;
    if (r->nseg < d->nseg) return REL_NONE;
    for (size_t i = 0; i < d->nseg; i++)
        if (str_cmp(d->seg[i], seg[i]) != 0) return REL_NONE;
    return r->nseg == d->nseg ? REL_EQUAL : REL_INSIDE;
}

// Every check that looks at one file row alone. Null when the row passes.
static const char *check_row(const snapshot *s, file_row *r, int nfields) {
    if (!is_hash(r->hash)) return "its hash is not 64 lowercase hex characters";
    if (!is_decimal(r->size)) return "its size is not a decimal number";
    if (!instant_parse(r->time, &r->mtime_ms)) return "its time is not a real instant in the 24-character form";
    if (nfields < 5 || r->path.n == 0) return "it has no path";
    if (memchr(r->path.p, '\t', r->path.n)) return "its path holds a tab";
    if (memchr(r->path.p, '\r', r->path.n)) return "its path holds a carriage return";
    if (memchr(r->path.p, '\0', r->path.n)) return "its path holds a NUL";
    if (r->kind == PATH_NOT_ABSOLUTE) return "its path is not absolute";
    if (r->nseg == 0) return "its path is a root, not a file";
    for (size_t i = 0; i < r->nseg; i++) {
        if (r->seg[i].n == 0) return "its path has an empty segment (a doubled or trailing separator)";
        if (str_is(r->seg[i], ".") || str_is(r->seg[i], "..")) return "its path has a `.` or `..` segment";
    }
    // Strictly inside a @SET DIR: under one, and equal to none.
    str *seg = r->seg;
    if (r->kind != PATH_POSIX) {
        seg = xmalloc(r->nseg * sizeof *seg);
        for (size_t i = 0; i < r->nseg; i++) seg[i] = lower_dup(r->seg[i]);
    }
    bool inside = false, equal = false;
    for (size_t i = 0; i < s->ndirs; i++) {
        int rel = dir_relation(&s->dirs[i], r, seg);
        inside |= rel == REL_INSIDE;
        equal |= rel == REL_EQUAL;
    }
    if (seg != r->seg) {
        for (size_t i = 0; i < r->nseg; i++) free((char *)seg[i].p);
        free(seg);
    }
    if (equal) return "its path is a @SET DIR itself, not a file inside one";
    if (!inside) return "its path is under no @SET DIR";
    return nullptr;
}

static const file_row *sort_rows;

static int by_path(const void *a, const void *b) {
    return str_cmp(sort_rows[*(const size_t *)a].path, sort_rows[*(const size_t *)b].path);
}

// The checks that look at two file rows: one path in both, and one path running through
// another as a folder. Both rows are refused, so no reader has to choose.
static void check_pairs(snapshot *s) {
    if (s->nrows == 0) return;
    size_t *idx = xmalloc(s->nrows * sizeof *idx);
    for (size_t i = 0; i < s->nrows; i++) idx[i] = i;
    sort_rows = s->rows;
    qsort(idx, s->nrows, sizeof *idx, by_path);

    // One path in two rows: every file row takes part, a malformed one included.
    for (size_t i = 0; i + 1 < s->nrows; i++) {
        file_row *a = &s->rows[idx[i]], *b = &s->rows[idx[i + 1]];
        if (str_cmp(a->path, b->path) == 0) {
            if (!a->refused) a->refused = "its path is in more than one file row";
            if (!b->refused) b->refused = "its path is in more than one file row";
        }
    }

    // One path running through another, last, among the rows every other check let through.
    size_t nvalid = 0;
    for (size_t i = 0; i < s->nrows; i++)
        if (!s->rows[idx[i]].refused) idx[nvalid++] = idx[i]; // still sorted by path
    bool *through = xcalloc(nvalid + 1, sizeof *through);
    for (size_t b = 0; b < nvalid; b++) {
        const file_row *row = &s->rows[idx[b]];
        bool win = row->kind != PATH_POSIX;
        size_t root = row->kind == PATH_DRIVE ? 3 : row->kind == PATH_SHARE ? 2 : 1;
        for (size_t i = root + 1; i < row->path.n; i++) {
            char ch = row->path.p[i];
            if (!(win ? win_sep(ch) : ch == '/')) continue;
            str prefix = {row->path.p, i};
            size_t lo = 0, hi = nvalid;
            while (lo < hi) {
                size_t mid = lo + (hi - lo) / 2;
                int c = str_cmp(s->rows[idx[mid]].path, prefix);
                if (c == 0) {
                    through[mid] = through[b] = true;
                    break;
                }
                if (c < 0)
                    lo = mid + 1;
                else
                    hi = mid;
            }
        }
    }
    for (size_t i = 0; i < nvalid; i++)
        if (through[i]) s->rows[idx[i]].refused = "its path runs through another file row's path, or the reverse";
    free(through);
    free(idx);
}

// ---------------------------------------------------------------- a snapshot

static char *refusal(const char *fmt, size_t line) {
    buf b = {};
    buf_printf(&b, fmt, line);
    return buf_cstr(&b);
}

void snapshot_free(snapshot *s) {
    if (!s) return;
    for (size_t i = 0; i < s->nrows; i++) free(s->rows[i].seg);
    for (size_t i = 0; i < s->ndirs; i++) {
        if (s->dirs[i].owned)
            for (size_t j = 0; j < s->dirs[i].nseg; j++) free((char *)s->dirs[i].seg[j].p);
        free(s->dirs[i].seg);
    }
    free(s->rows);
    free(s->dirs);
    buf_free(&s->text);
    free(s);
}

snapshot *snapshot_parse(buf text, char **why) {
    snapshot *s = xcalloc(1, sizeof *s);
    s->text = text;
    const char *t = buf_cstr(&s->text);
    size_t n = s->text.n;
    int *row_fields = nullptr;
    size_t rows_cap = 0;
    *why = nullptr;

    if (!utf8_valid(t, n)) {
        *why = xstrdup("it is not valid UTF-8");
        goto refuse;
    }
    if (n == 0) {
        *why = xstrdup("it is empty: no heading row");
        goto refuse;
    }
    if (t[n - 1] != '\n') {
        *why = xstrdup("its last line has no line feed: it was cut short, and does not end with the `.` line");
        goto refuse;
    }

    bool seen_dot = false;
    size_t pos = 0, lineno = 0;
    while (pos < n) {
        const char *nl = memchr(t + pos, '\n', n - pos);
        str line = {t + pos, (size_t)(nl - (t + pos))};
        pos += line.n + 1;
        lineno++;
        str f[5];
        int nfields = split5(line, f);

        if (lineno == 1) {
            // The heading row: five fields, the first four trimmed, the last verbatim.
            if (!(nfields == 5 && str_is(trim(f[0]), "@S3CAB") && str_is(trim(f[1]), "FORMAT") &&
                  str_is(trim(f[2]), "size") && str_is(trim(f[3]), "time") && str_is(f[4], HEADING_URL))) {
                *why = xstrdup("its first line is not the heading row");
                goto refuse;
            }
            continue;
        }
        if (seen_dot) {
            *why = refusal("something follows the `.` line (line %zu)", lineno);
            goto refuse;
        }
        if (line.n == 1 && line.p[0] == '.') { // the whole line, byte for byte
            seen_dot = true;
            continue;
        }
        if (trim(line).n == 0) {
            *why = refusal("line %zu is blank", lineno);
            goto refuse;
        }
        str type = trim(f[0]);
        if (str_is(type, "-")) {
            if (s->nrows == rows_cap) {
                rows_cap = rows_cap ? rows_cap * 2 : 256;
                s->rows = xrealloc(s->rows, rows_cap * sizeof *s->rows);
                row_fields = xrealloc(row_fields, rows_cap * sizeof *row_fields);
            }
            parsed_path p = parse_path(f[4], false);
            row_fields[s->nrows] = nfields;
            s->rows[s->nrows++] = (file_row){.line = lineno,
                                             .hash = trim(f[1]),
                                             .size = trim(f[2]),
                                             .time = trim(f[3]),
                                             .path = f[4],
                                             .kind = p.kind,
                                             .drive = p.drive,
                                             .nseg = p.nseg,
                                             .seg = p.seg};
        } else if (type.n && type.p[0] == '@') {
            str property = trim(f[1]);
            if (str_is(type, "@SET") && str_is(property, "DIR")) {
                // Fewer than five fields is no value, and an empty value is no directory.
                if (nfields == 5 && f[4].n > 0) dir_add(s, f[4]);
            } else if (str_is(type, "@SNAPSHOT") && str_is(property, "START")) {
                // Where the row repeats, the last counts, even one that is no real instant.
                str when = trim(f[3]);
                s->has_start = instant_parse(when, nullptr);
                if (s->has_start) {
                    memcpy(s->start, when.p, 24);
                    s->start[24] = '\0';
                }
            }
        } else if (type.n && type.p[0] == '#') {
            // A path a restore doesn't act on.
        } else {
            *why = refusal("line %zu holds a row type this reader doesn't know, starting with neither @ nor #", lineno);
            goto refuse;
        }
    }
    if (!seen_dot) {
        *why = xstrdup("it does not end with the `.` line: it was cut short");
        goto refuse;
    }
    s->nlines = lineno;

    // Every @SET DIR is known before any file row is judged, wherever they came.
    for (size_t i = 0; i < s->nrows; i++) s->rows[i].refused = check_row(s, &s->rows[i], row_fields[i]);
    check_pairs(s);
    free(row_fields);
    return s;

refuse:
    free(row_fields);
    snapshot_free(s);
    return nullptr;
}

// ---------------------------------------------------------------- deletion records

struct deletion {
    char hash[65];
    char when[25];
};

struct deletions {
    struct deletion *v;
    size_t n, cap;
};

deletions *deletions_new(void) { return xcalloc(1, sizeof(deletions)); }

void deletions_free(deletions *d) {
    if (!d) return;
    free(d->v);
    free(d);
}

size_t deletions_count(const deletions *d) { return d->n; }

// One record's well-formed #deleted rows: those before the first `.` line, each ended by an
// LF, each line decoded on its own. Everything else in the file is set aside.
void deletions_add(deletions *d, const char *text, size_t n) {
    size_t pos = 0;
    while (pos < n) {
        const char *nl = memchr(text + pos, '\n', n - pos);
        if (!nl) break; // a last row with no LF explains nothing
        str line = {text + pos, (size_t)(nl - (text + pos))};
        pos += line.n + 1;
        if (line.n == 1 && line.p[0] == '.') break;
        if (!utf8_valid(line.p, line.n)) continue;
        str f[5];
        split5(line, f);
        if (!str_is(trim(f[0]), "#deleted")) continue;
        str hash = trim(f[1]), size = trim(f[2]), when = trim(f[3]);
        if (!is_hash(hash) || !is_decimal(size) || !instant_parse(when, nullptr)) continue;
        struct deletion *found = nullptr;
        for (size_t i = 0; i < d->n && !found; i++)
            if (memcmp(d->v[i].hash, hash.p, 64) == 0) found = &d->v[i];
        if (found) { // two rows for one hash: the newest
            if (memcmp(when.p, found->when, 24) > 0) memcpy(found->when, when.p, 24);
            continue;
        }
        if (d->n == d->cap) {
            d->cap = d->cap ? d->cap * 2 : 64;
            d->v = xrealloc(d->v, d->cap * sizeof *d->v);
        }
        struct deletion *e = &d->v[d->n++];
        memcpy(e->hash, hash.p, 64);
        e->hash[64] = '\0';
        memcpy(e->when, when.p, 24);
        e->when[24] = '\0';
    }
}

const char *deletions_newest(const deletions *d, str hash) {
    if (hash.n != 64) return nullptr;
    for (size_t i = 0; i < d->n; i++)
        if (memcmp(d->v[i].hash, hash.p, 64) == 0) return d->v[i].when;
    return nullptr;
}
