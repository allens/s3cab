/* Snapshot parsing and validation, per format.md's reading rules. */
#include "snap.h"

static bool is_sep_win(unsigned char c) { return c == '\\' || c == '/'; }

static path_kind classify(const unsigned char *p, size_t n, unsigned char *drive) {
    if (n >= 3 && ((p[0] >= 'A' && p[0] <= 'Z') || (p[0] >= 'a' && p[0] <= 'z')) && p[1] == ':' && is_sep_win(p[2])) {
        *drive = (unsigned char)((p[0] >= 'a') ? p[0] - 32 : p[0]);
        return KIND_DRIVE;
    }
    if (n >= 2 && is_sep_win(p[0]) && is_sep_win(p[1])) return KIND_SHARE;
    if (n >= 1 && p[0] == '/') return KIND_POSIX;
    return KIND_RELATIVE;
}

void path_split(const unsigned char *p, size_t n, bool is_dir, path_parts *out) {
    memset(out, 0, sizeof *out);
    out->kind = classify(p, n, &out->drive);
    if (out->kind == KIND_RELATIVE) return;
    size_t root = out->kind == KIND_POSIX ? 1 : out->kind == KIND_DRIVE ? 3 : 2;
    bool win = out->kind != KIND_POSIX;
    size_t end = n;
    if (is_dir) {
        while (end > 0 && (win ? is_sep_win(p[end - 1]) : p[end - 1] == '/')) end--;
    }
    if (end <= root) { out->nsegs = 0; return; }
    /* count and cut segments */
    size_t cap = 8; out->segs = xmalloc(cap * sizeof *out->segs);
    size_t start = root;
    for (size_t i = root; i <= end; i++) {
        bool at_sep = (i == end) || (win ? is_sep_win(p[i]) : p[i] == '/');
        if (!at_sep) continue;
        if (out->nsegs == cap) { cap *= 2; out->segs = xrealloc(out->segs, cap * sizeof *out->segs); }
        span_t s = { p + start, i - start };
        if (s.n == 0 || (s.n == 1 && s.p[0] == '.') || (s.n == 2 && s.p[0] == '.' && s.p[1] == '.')) out->bad_segment = true;
        out->segs[out->nsegs++] = s;
        start = i + 1;
    }
}

void path_parts_free(path_parts *pp) { free(pp->segs); pp->segs = NULL; pp->nsegs = 0; }

/* ---- DIR matching ---- */

static bool seg_eq(span_t a, span_t b) { return a.n == b.n && !memcmp(a.p, b.p, a.n); }

/* Is `path` (already lowercased if Windows) under / equal to dir?  Returns
 * 0 = unrelated, 1 = strictly under, 2 = equal. */
static int dir_relation(const dir_t *d, const path_parts *pp) {
    if (!d->usable) return 0;
    if (d->parts.kind != pp->kind) return 0;
    if (pp->kind == KIND_DRIVE && d->parts.drive != pp->drive) return 0;
    if (pp->nsegs < d->parts.nsegs) return 0;
    for (size_t i = 0; i < d->parts.nsegs; i++) if (!seg_eq(d->parts.segs[i], pp->segs[i])) return 0;
    return pp->nsegs == d->parts.nsegs ? 2 : 1;
}

/* ---- line handling ---- */

static bool line_is_blank(const unsigned char *p, size_t n) {
    trim_field(&p, &n);
    return n == 0;
}

/* Check the heading row: five fields, first four trimmed, fifth verbatim. */
static bool is_heading(const unsigned char *line, size_t n) {
    span_t f[5]; split_fields(line, n, f);
    /* must actually have four tabs: a line with fewer reads missing fields as
     * empty, which then fail the comparison anyway */
    for (int i = 0; i < 4; i++) trim_field(&f[i].p, &f[i].n);
    return span_eq(f[0], "@S3CAB") && span_eq(f[1], "FORMAT") && span_eq(f[2], "size") && span_eq(f[3], "time")
        && span_eq(f[4], "https://s3cab.plantegral.com/guide/format");
}

static void add_dir(snapshot *s, span_t text) {
    s->dirs = xrealloc(s->dirs, (s->ndirs + 1) * sizeof *s->dirs);
    dir_t *d = &s->dirs[s->ndirs++];
    memset(d, 0, sizeof *d);
    d->text = text;
    unsigned char drive;
    path_kind k = classify(text.p, text.n, &drive);
    if (k == KIND_RELATIVE) { d->usable = false; return; }
    if (k == KIND_POSIX) {
        path_split(text.p, text.n, true, &d->parts);
    } else {
        d->lower = unicode_lower(text.p, text.n, &d->lowern);
        path_split(d->lower, d->lowern, true, &d->parts);
    }
    d->usable = !d->parts.bad_segment;
    if (d->parts.bad_segment) {
        /* a doubled separator after the root (empty segment) matches nothing;
         * "." and ".." are left to the file row's own segment check, which
         * refuses every row beneath such a DIR anyway (the row carries them) */
        bool only_dots = true;
        for (size_t i = 0; i < d->parts.nsegs; i++) if (d->parts.segs[i].n == 0) only_dots = false;
        d->usable = only_dots;
    }
    if (k == KIND_SHARE && d->parts.nsegs < 2) d->usable = false;
    if (memchr(text.p, 0, text.n)) d->usable = false;
}

/* ---- hashing of path bytes for the duplicate / run-through checks ---- */
typedef struct { const unsigned char *p; size_t n; size_t row; } pkey;
typedef struct { pkey *slots; size_t cap; } pset;
static uint64_t hbytes(const unsigned char *p, size_t n) {
    uint64_t h = 1469598103934665603ULL;
    for (size_t i = 0; i < n; i++) { h ^= p[i]; h *= 1099511628211ULL; }
    return h;
}
static void pset_init(pset *s, size_t n) { s->cap = 16; while (s->cap < n * 2 + 8) s->cap *= 2; s->slots = calloc(s->cap, sizeof *s->slots); if (!s->slots) die("out of memory"); }
/* Insert; returns the row index of an existing equal key, or SIZE_MAX. */
static size_t pset_insert(pset *s, const unsigned char *p, size_t n, size_t row) {
    size_t i = hbytes(p, n) & (s->cap - 1);
    for (;;) {
        if (!s->slots[i].p) { s->slots[i] = (pkey){ p, n, row }; return SIZE_MAX; }
        if (s->slots[i].n == n && !memcmp(s->slots[i].p, p, n)) return s->slots[i].row;
        i = (i + 1) & (s->cap - 1);
    }
}
static size_t pset_find(pset *s, const unsigned char *p, size_t n) {
    size_t i = hbytes(p, n) & (s->cap - 1);
    for (;;) {
        if (!s->slots[i].p) return SIZE_MAX;
        if (s->slots[i].n == n && !memcmp(s->slots[i].p, p, n)) return s->slots[i].row;
        i = (i + 1) & (s->cap - 1);
    }
}

const char *snapshot_load(const unsigned char *gz, size_t n, snapshot *s) {
    memset(s, 0, sizeof *s);
    buf_init(&s->text);
    const char *gzerr;
    if (!gunzip_all(gz, n, &s->text, &gzerr)) { snapshot_free(s); return gzerr; }
    unsigned char *t = s->text.p; size_t tn = s->text.len;
    if (!t) { snapshot_free(s); return "empty after decompression"; }
    /* Forgive one BOM at the very start. */
    if (tn >= 3 && t[0] == 0xEF && t[1] == 0xBB && t[2] == 0xBF) { t += 3; tn -= 3; }
    if (!utf8_valid(t, tn)) { snapshot_free(s); return "not valid UTF-8"; }
    if (tn == 0 || t[tn - 1] != '\n') { snapshot_free(s); return "cut short: the last line has no line feed"; }
    /* Split on LF exactly. */
    size_t nlines = 0;
    for (size_t i = 0; i < tn; i++) if (t[i] == '\n') nlines++;
    span_t *lines = xmalloc(nlines * sizeof *lines);
    { size_t k = 0, start = 0; for (size_t i = 0; i < tn; i++) if (t[i] == '\n') { lines[k++] = (span_t){ t + start, i - start }; start = i + 1; } }
    if (nlines < 2) { free(lines); snapshot_free(s); return "too short to hold a heading row and the '.'"; }
    if (!is_heading(lines[0].p, lines[0].n)) { free(lines); snapshot_free(s); return "first line is not the heading row"; }
    span_t last = lines[nlines - 1];
    if (!(last.n == 1 && last.p[0] == '.')) { free(lines); snapshot_free(s); return "last line is not '.': the file was cut short"; }

    /* First pass: whole-file checks and the @ rows (every @SET DIR must be
     * known before any file row is judged). */
    for (size_t i = 1; i + 1 < nlines; i++) {
        span_t L = lines[i];
        if (line_is_blank(L.p, L.n)) { free(lines); snapshot_free(s); return "holds a blank line"; }
        span_t f[5]; split_fields(L.p, L.n, f);
        span_t type = f[0]; trim_field(&type.p, &type.n);
        if (type.n == 1 && type.p[0] == '.') { free(lines); snapshot_free(s); return "holds a '.' line that is not the last line"; }
        if (type.n && type.p[0] == '@') {
            span_t prop = f[1]; trim_field(&prop.p, &prop.n);
            if (span_eq(type, "@SET") && span_eq(prop, "DIR")) {
                /* fewer than five fields, or an empty fifth: no directory */
                if (f[4].n > 0) add_dir(s, f[4]);
            } else if (span_eq(type, "@SNAPSHOT") && span_eq(prop, "START")) {
                span_t inst = f[3]; trim_field(&inst.p, &inst.n);
                /* the last START counts; one that isn't an instant counts as none */
                if (parse_instant(inst.p, inst.n, NULL)) { memcpy(s->start, inst.p, 24); s->start[24] = 0; s->has_start = true; }
                else s->has_start = false;
            }
            continue;
        }
        if (type.n && type.p[0] == '#') continue;
        if (type.n == 1 && type.p[0] == '-') { s->nrows++; continue; }
        free(lines); snapshot_free(s);
        return "holds a row of an unknown type that starts with neither '@' nor '#'";
    }

    /* Second pass: the file rows. */
    s->rows = xmalloc((s->nrows ? s->nrows : 1) * sizeof *s->rows);
    size_t r = 0;
    for (size_t i = 1; i + 1 < nlines; i++) {
        span_t L = lines[i];
        span_t f[5]; split_fields(L.p, L.n, f);
        span_t type = f[0]; trim_field(&type.p, &type.n);
        if (!(type.n == 1 && type.p[0] == '-')) continue;
        file_row *row = &s->rows[r++];
        memset(row, 0, sizeof *row);
        row->line = (int)i + 1;
        row->hash = f[1]; trim_field(&row->hash.p, &row->hash.n);
        row->size = f[2]; trim_field(&row->size.p, &row->size.n);
        row->mtime = f[3]; trim_field(&row->mtime.p, &row->mtime.n);
        row->path = f[4]; /* verbatim */
        if (!is_hex64_lower(row->hash)) row->refused = "hash is not 64 lowercase hex characters";
        else if (!is_digits(row->size)) row->refused = "size is not decimal digits";
        else if (!parse_instant(row->mtime.p, row->mtime.n, &row->mtime_ms)) row->refused = "time is not a real instant in the 24-character form";
        else if (row->path.n == 0) row->refused = "path is empty";
        else if (memchr(row->path.p, '\t', row->path.n)) row->refused = "path holds a tab";
        else if (memchr(row->path.p, '\r', row->path.n)) row->refused = "path holds a carriage return";
        else if (memchr(row->path.p, 0, row->path.n)) row->refused = "path holds a NUL";
        if (row->refused) continue;
        path_split(row->path.p, row->path.n, false, &row->parts);
        if (row->parts.kind == KIND_RELATIVE) { row->refused = "path is not absolute"; continue; }
        if (row->parts.nsegs == 0) { row->refused = "path names a root, not a file"; continue; }
        if (row->parts.bad_segment) { row->refused = "path has an empty, '.' or '..' segment"; continue; }
        /* DIR matching: Windows paths compare lowercased */
        path_parts cmp = row->parts; unsigned char *lower = NULL; bool own = false;
        if (row->parts.kind != KIND_POSIX) {
            size_t ln; lower = unicode_lower(row->path.p, row->path.n, &ln);
            path_split(lower, ln, false, &cmp); own = true;
        }
        bool under = false, equal = false;
        for (size_t d = 0; d < s->ndirs; d++) {
            int rel = dir_relation(&s->dirs[d], &cmp);
            if (rel == 1) under = true;
            if (rel == 2) equal = true;
        }
        if (own) { path_parts_free(&cmp); free(lower); }
        if (equal) row->refused = "path is equal to a @SET DIR";
        else if (!under) row->refused = "path is under no @SET DIR";
    }
    free(lines);

    /* One path in two rows (exact bytes), every file row taking part. */
    pset ps; pset_init(&ps, s->nrows);
    bool *dup = calloc(s->nrows ? s->nrows : 1, sizeof *dup);
    for (size_t i = 0; i < s->nrows; i++) {
        size_t prev = pset_insert(&ps, s->rows[i].path.p, s->rows[i].path.n, i);
        if (prev != SIZE_MAX) { dup[i] = true; dup[prev] = true; }
    }
    for (size_t i = 0; i < s->nrows; i++) if (dup[i] && !s->rows[i].refused) s->rows[i].refused = "path appears in more than one file row";
    free(dup);
    free(ps.slots);

    /* One path running through another as a folder, among rows every other
     * check let through; after an exact prefix, any separator of the path's
     * kind counts. */
    pset_init(&ps, s->nrows);
    for (size_t i = 0; i < s->nrows; i++) if (!s->rows[i].refused) pset_insert(&ps, s->rows[i].path.p, s->rows[i].path.n, i);
    bool *thru = calloc(s->nrows ? s->nrows : 1, sizeof *thru);
    for (size_t i = 0; i < s->nrows; i++) {
        file_row *row = &s->rows[i];
        if (row->refused) continue;
        bool win = row->parts.kind != KIND_POSIX;
        size_t root = row->parts.kind == KIND_POSIX ? 1 : row->parts.kind == KIND_DRIVE ? 3 : 2;
        for (size_t k = root + 1; k < row->path.n; k++) {
            unsigned char c = row->path.p[k];
            if (!(win ? is_sep_win(c) : c == '/')) continue;
            size_t other = pset_find(&ps, row->path.p, k);
            if (other != SIZE_MAX && other != i) { thru[i] = true; thru[other] = true; }
        }
    }
    for (size_t i = 0; i < s->nrows; i++) if (thru[i] && !s->rows[i].refused) s->rows[i].refused = "path runs through another file row's path as a folder, or is run through";
    free(thru);
    free(ps.slots);

    for (size_t i = 0; i < s->nrows; i++) if (s->rows[i].refused) s->nrefused++;
    return NULL;
}

void snapshot_free(snapshot *s) {
    for (size_t i = 0; i < s->ndirs; i++) { path_parts_free(&s->dirs[i].parts); free(s->dirs[i].lower); }
    free(s->dirs);
    if (s->rows) for (size_t i = 0; i < s->nrows; i++) path_parts_free(&s->rows[i].parts);
    free(s->rows);
    buf_free(&s->text);
    memset(s, 0, sizeof *s);
}

/* ---- deletion records ---- */

static void del_add(del_table *t, const unsigned char *hash, const unsigned char *inst) {
    for (size_t i = 0; i < t->n; i++) {
        if (!memcmp(t->e[i].hash, hash, 64)) {
            if (memcmp(inst, t->e[i].instant, 24) > 0) memcpy(t->e[i].instant, inst, 24);
            return;
        }
    }
    if (t->n == t->cap) { t->cap = t->cap ? t->cap * 2 : 64; t->e = xrealloc(t->e, t->cap * sizeof *t->e); }
    memcpy(t->e[t->n].hash, hash, 64); t->e[t->n].hash[64] = 0;
    memcpy(t->e[t->n].instant, inst, 24); t->e[t->n].instant[24] = 0;
    t->n++;
}

void record_parse(const unsigned char *text, size_t n, del_table *t) {
    size_t start = 0;
    while (start < n) {
        const unsigned char *nl = memchr(text + start, '\n', n - start);
        if (!nl) break; /* a last line with no LF explains nothing */
        span_t L = { text + start, (size_t)(nl - (text + start)) };
        start = (size_t)(nl - text) + 1;
        if (L.n == 1 && L.p[0] == '.') break; /* rows after the '.' explain nothing */
        if (!utf8_valid(L.p, L.n)) continue;  /* one wrong line */
        span_t f[5]; split_fields(L.p, L.n, f);
        span_t type = f[0]; trim_field(&type.p, &type.n);
        if (!span_eq(type, "#deleted")) continue;
        span_t hash = f[1], size = f[2], inst = f[3];
        trim_field(&hash.p, &hash.n); trim_field(&size.p, &size.n); trim_field(&inst.p, &inst.n);
        if (!is_hex64_lower(hash) || !is_digits(size) || !parse_instant(inst.p, inst.n, NULL)) continue;
        del_add(t, hash.p, inst.p);
    }
}

const char *del_lookup(const del_table *t, const char *hash64) {
    for (size_t i = 0; i < t->n; i++) if (!memcmp(t->e[i].hash, hash64, 64)) return t->e[i].instant;
    return NULL;
}

void del_table_free(del_table *t) { free(t->e); t->e = NULL; t->n = t->cap = 0; }
