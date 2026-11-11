/* The format's text rules: strict UTF-8, the trim set, five fields at the
 * first four tabs, the 24-character instant, Unicode lowercasing. */
#include "common.h"
#include <wctype.h>
#include <ctype.h>

size_t utf8_decode(const unsigned char *s, size_t n, uint32_t *cp) {
    if (!n) return 0;
    unsigned char c = s[0];
    if (c < 0x80) { *cp = c; return 1; }
    size_t len; uint32_t v, min;
    if ((c & 0xE0) == 0xC0) { len = 2; v = c & 0x1F; min = 0x80; }
    else if ((c & 0xF0) == 0xE0) { len = 3; v = c & 0x0F; min = 0x800; }
    else if ((c & 0xF8) == 0xF0) { len = 4; v = c & 0x07; min = 0x10000; }
    else return 0;
    if (n < len) return 0;
    for (size_t i = 1; i < len; i++) {
        if ((s[i] & 0xC0) != 0x80) return 0;
        v = (v << 6) | (s[i] & 0x3F);
    }
    if (v < min || v > 0x10FFFF || (v >= 0xD800 && v <= 0xDFFF)) return 0;
    *cp = v;
    return len;
}

size_t utf8_encode(uint32_t cp, unsigned char out[4]) {
    if (cp < 0x80) { out[0] = (unsigned char)cp; return 1; }
    if (cp < 0x800) { out[0] = (unsigned char)(0xC0 | (cp >> 6)); out[1] = (unsigned char)(0x80 | (cp & 0x3F)); return 2; }
    if (cp < 0x10000) { out[0] = (unsigned char)(0xE0 | (cp >> 12)); out[1] = (unsigned char)(0x80 | ((cp >> 6) & 0x3F)); out[2] = (unsigned char)(0x80 | (cp & 0x3F)); return 3; }
    out[0] = (unsigned char)(0xF0 | (cp >> 18)); out[1] = (unsigned char)(0x80 | ((cp >> 12) & 0x3F)); out[2] = (unsigned char)(0x80 | ((cp >> 6) & 0x3F)); out[3] = (unsigned char)(0x80 | (cp & 0x3F)); return 4;
}

bool utf8_valid(const unsigned char *s, size_t n) {
    size_t i = 0;
    while (i < n) {
        uint32_t cp;
        size_t l = utf8_decode(s + i, n - i, &cp);
        if (!l) return false;
        i += l;
    }
    return true;
}

/* JavaScript's trim() set, as the spec lists it. */
bool is_trim_cp(uint32_t cp) {
    if (cp >= 0x09 && cp <= 0x0D) return true;
    if (cp == 0x20 || cp == 0xA0 || cp == 0x1680) return true;
    if (cp >= 0x2000 && cp <= 0x200A) return true;
    if (cp == 0x2028 || cp == 0x2029 || cp == 0x202F || cp == 0x205F || cp == 0x3000 || cp == 0xFEFF) return true;
    return false;
}

void trim_field(const unsigned char **s, size_t *n) {
    const unsigned char *p = *s; size_t len = *n;
    /* leading */
    for (;;) {
        uint32_t cp; size_t l = utf8_decode(p, len, &cp);
        if (!l || !is_trim_cp(cp)) break;
        p += l; len -= l;
    }
    /* trailing: walk back over complete code points */
    while (len) {
        size_t back = 1;
        while (back < len && back < 4 && (p[len - back] & 0xC0) == 0x80) back++;
        uint32_t cp; size_t l = utf8_decode(p + len - back, back, &cp);
        if (l != back || !is_trim_cp(cp)) break;
        len -= back;
    }
    *s = p; *n = len;
}

void split_fields(const unsigned char *line, size_t n, span_t f[5]) {
    size_t start = 0;
    for (int i = 0; i < 5; i++) {
        if (i == 4 || start > n) {
            f[i].p = line + (start > n ? n : start);
            f[i].n = start > n ? 0 : n - start;
            for (int j = i + 1; j < 5; j++) { f[j].p = line + n; f[j].n = 0; }
            if (i == 4) return;
            return;
        }
        const unsigned char *tab = memchr(line + start, '\t', n - start);
        if (!tab) {
            f[i].p = line + start; f[i].n = n - start;
            for (int j = i + 1; j < 5; j++) { f[j].p = line + n; f[j].n = 0; }
            return;
        }
        f[i].p = line + start; f[i].n = (size_t)(tab - (line + start));
        start = (size_t)(tab - line) + 1;
    }
}

bool span_eq(span_t a, const char *s) {
    size_t l = strlen(s);
    return a.n == l && !memcmp(a.p, s, l);
}

bool is_hex64_lower(span_t s) {
    if (s.n != 64) return false;
    for (size_t i = 0; i < 64; i++) {
        unsigned char c = s.p[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    }
    return true;
}

bool is_digits(span_t s) {
    if (!s.n) return false;
    for (size_t i = 0; i < s.n; i++) if (s.p[i] < '0' || s.p[i] > '9') return false;
    return true;
}

static bool leap(int64_t y) { return (y % 4 == 0 && y % 100 != 0) || y % 400 == 0; }

/* Days from 1970-01-01 to y-m-d in the proleptic Gregorian calendar
 * (Howard Hinnant's days_from_civil; valid for year 0). */
static int64_t days_from_civil(int64_t y, int m, int d) {
    y -= m <= 2;
    int64_t era = (y >= 0 ? y : y - 399) / 400;
    int64_t yoe = y - era * 400;
    int64_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + doe - 719468;
}

bool parse_instant(const unsigned char *s, size_t n, int64_t *ms) {
    /* YYYY-MM-DDTHH:MM:SS.sssZ */
    if (n != 24) return false;
    static const char pat[] = "dddd-dd-ddTdd:dd:dd.dddZ";
    for (int i = 0; i < 24; i++) {
        if (pat[i] == 'd') { if (s[i] < '0' || s[i] > '9') return false; }
        else if (s[i] != (unsigned char)pat[i]) return false;
    }
    int y = (s[0]-'0')*1000 + (s[1]-'0')*100 + (s[2]-'0')*10 + (s[3]-'0');
    int mo = (s[5]-'0')*10 + (s[6]-'0');
    int d = (s[8]-'0')*10 + (s[9]-'0');
    int h = (s[11]-'0')*10 + (s[12]-'0');
    int mi = (s[14]-'0')*10 + (s[15]-'0');
    int se = (s[17]-'0')*10 + (s[18]-'0');
    int frac = (s[20]-'0')*100 + (s[21]-'0')*10 + (s[22]-'0');
    if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || se > 59) return false;
    static const int mdays[] = { 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
    int dim = mdays[mo - 1] + (mo == 2 && leap(y) ? 1 : 0);
    if (d > dim) return false;
    int64_t days = days_from_civil(y, mo, d);
    if (ms) *ms = ((days * 86400) + h * 3600 + mi * 60 + se) * 1000 + frac;
    return true;
}

/* ---- Unicode lowercasing ----
 * Full default case mapping = simple per-character mapping (towlower under
 * C.UTF-8) + U+0130 -> "i̇" + Final_Sigma.  Final_Sigma needs the
 * "cased" and "case-ignorable" properties, which libc doesn't expose; they
 * are approximated here from iswupper/iswlower and a list of common
 * case-ignorable characters. */
static bool is_cased(uint32_t cp) {
    return iswupper((wint_t)cp) || iswlower((wint_t)cp) || (cp >= 0x1C90 && cp <= 0x1CBF) /* Georgian Mtavruli */;
}
static bool is_case_ignorable(uint32_t cp) {
    /* Word_Break MidLetter/MidNumLet/Single_Quote, plus Mn/Me/Cf/Lm/Sk (approximated). */
    if (cp == '\'' || cp == '.' || cp == ':' || cp == 0xB7 || cp == 0x2018 || cp == 0x2019 || cp == 0x2024 || cp == 0xFE52 || cp == 0xFE55 || cp == 0xFF07 || cp == 0xFF0E || cp == 0xFF1A || cp == 0x00AD || cp == 0x0387 || cp == 0x05F4 || cp == 0x2027) return true;
    if (cp == 0x5E || cp == 0x60 || cp == 0xA8 || cp == 0xAF || cp == 0xB4 || cp == 0xB8) return true; /* Sk */
    if (cp >= 0x02B0 && cp <= 0x02FF) return true; /* modifier letters/symbols */
    if (cp >= 0x0300 && cp <= 0x036F) return true; /* combining marks */
    if (cp >= 0x0483 && cp <= 0x0489) return true;
    if (cp >= 0x0591 && cp <= 0x05BD) return true;
    if (cp >= 0x0610 && cp <= 0x061A) return true;
    if (cp >= 0x064B && cp <= 0x065F) return true;
    if (cp >= 0x1AB0 && cp <= 0x1AFF) return true;
    if (cp >= 0x1DC0 && cp <= 0x1DFF) return true;
    if (cp >= 0x200B && cp <= 0x200F) return true; /* Cf */
    if (cp >= 0x202A && cp <= 0x202E) return true;
    if (cp >= 0x2060 && cp <= 0x2064) return true;
    if (cp >= 0x20D0 && cp <= 0x20FF) return true;
    if (cp >= 0xFE00 && cp <= 0xFE0F) return true;
    if (cp >= 0xFE20 && cp <= 0xFE2F) return true;
    if (cp == 0xFEFF) return true;
    if (cp >= 0xE0100 && cp <= 0xE01EF) return true;
    if (cp >= 0x1F3FB && cp <= 0x1F3FF) return true;
    return false;
}

unsigned char *unicode_lower(const unsigned char *s, size_t n, size_t *outn) {
    /* Decode to code points first. */
    size_t cap = n + 1;
    uint32_t *cps = xmalloc(cap * sizeof *cps);
    size_t k = 0, i = 0;
    while (i < n) {
        uint32_t cp; size_t l = utf8_decode(s + i, n - i, &cp);
        if (!l) { cp = 0xFFFD; l = 1; }
        cps[k++] = cp; i += l;
    }
    buf_t out; buf_init(&out);
    for (size_t j = 0; j < k; j++) {
        uint32_t cp = cps[j];
        unsigned char u[4]; size_t ul;
        if (cp == 0x0130) { ul = utf8_encode(0x69, u); buf_append(&out, u, ul); ul = utf8_encode(0x307, u); buf_append(&out, u, ul); continue; }
        if (cp == 0x03A3) {
            /* Final_Sigma: preceded by a cased letter (skipping case-ignorable)
             * and not followed by one (skipping case-ignorable). */
            bool before = false, after = false;
            for (size_t a = j; a-- > 0;) { if (is_case_ignorable(cps[a])) continue; before = is_cased(cps[a]); break; }
            for (size_t b = j + 1; b < k; b++) { if (is_case_ignorable(cps[b])) continue; after = is_cased(cps[b]); break; }
            cp = (before && !after) ? 0x03C2 : 0x03C3;
            ul = utf8_encode(cp, u); buf_append(&out, u, ul); continue;
        }
        wint_t lw = towlower((wint_t)cp);
        ul = utf8_encode((uint32_t)lw, u); buf_append(&out, u, ul);
    }
    free(cps);
    *outn = out.len;
    return out.p;
}

void print_path(FILE *f, const unsigned char *s, size_t n) {
    /* Spell control characters out: C0, DEL, C1 (U+0080-U+009F), and the
     * line/paragraph separators. */
    size_t i = 0;
    while (i < n) {
        uint32_t cp; size_t l = utf8_decode(s + i, n - i, &cp);
        if (!l) { fprintf(f, "\\x%02X", s[i]); i++; continue; }
        if (cp < 0x20 || cp == 0x7F || (cp >= 0x80 && cp <= 0x9F) || cp == 0x2028 || cp == 0x2029) fprintf(f, "\\u%04X", cp);
        else fwrite(s + i, 1, l, f);
        i += l;
    }
}
