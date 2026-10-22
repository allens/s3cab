/* Reading s3cab snapshots and deletion records, by format.md (spec of 2026-10-20). */
#ifndef S3CAB_FORMAT_H
#define S3CAB_FORMAT_H

#include "util.h"

#define HEADING_URL "https://s3cab.plantegral.com/guide/format"

enum pkind { PK_NONE = 0, PK_POSIX, PK_DRIVE, PK_UNC };

/* An absolute path cut into its root and segments (slices into the snapshot text). */
typedef struct {
    enum pkind kind;
    unsigned char drive; /* PK_DRIVE: the letter as spelled */
    size_t nseg;
    str_t *seg;
} path_t;

typedef struct {
    size_t line;
    str_t raw;      /* the value, verbatim */
    bool usable;    /* an absolute path */
    path_t path;    /* trailing separators ignored */
    str_t name;     /* the destination folder's name, as spelled */
    bool has_folder; /* false for "/": its files land straight in the output */
    buf_t *lseg;    /* lowercased segments, for Windows paths */
    int alias_of;   /* index of an earlier, identical DIR row, or -1 */
    size_t reached; /* restorable file rows that count for this DIR */
} dir_t;

typedef struct {
    size_t line;
    str_t raw;   /* the path, verbatim */
    bool path_ok; /* syntactically a valid absolute path */
    path_t path;
    buf_t *lseg; /* lowercased segments, Windows paths only */
    char hash[65];
    uint64_t size;
    int64_t sec;
    int32_t ms;
    bool ok;       /* passed every row check */
    char why[240]; /* first reason it was refused */
    int dir;       /* deepest matching DIR, or -1 */
    int tie_dir;   /* another DIR matching at the same depth, or -1 */
} frow_t;

typedef struct {
    buf_t text; /* decompressed snapshot (owned) */
    str_t *lines;
    size_t nlines;
    str_t spec, set_name, snap_name;
    dir_t *dirs;
    size_t ndirs;
    frow_t *rows;
    size_t nrows;
    size_t skipped_rows; /* unknown @ and # rows, and # rows in general */
    size_t warnings;
} snap_t;

/* gzip, members joined (as format.md says s3cab's reader does); trailing non-gzip refused. */
bool gunzip_all(const unsigned char *in, size_t n, buf_t *out, char *err, size_t errlen);

/* The whole-file checks every snapshot and record shares: strict UTF-8 (a leading BOM
 * forgiven), LF-terminated lines, the heading row first, the "." last and nothing after it. */
bool text_lines(const buf_t *text, str_t **lines, size_t *nlines, char *err, size_t errlen);

/* Parse s->text.  False (with err) means the file is refused whole. */
bool snap_parse(snap_t *s, char *err, size_t errlen);

/* Per-path rules, DIR matching, duplicate and running-through checks. */
void snap_check(snap_t *s);

/* s3cab's layout refuses a restore outright when "/" is reached beside another DIR, or two
 * reached DIRs' folder names collide ignoring case.  False, with reasons appended to why. */
bool snap_layout_ok(const snap_t *s, buf_t *why);

void snap_free(snap_t *s);

/* Full Unicode default lowercase mapping (ICU, root locale). */
void lower_utf8(str_t s, buf_t *out);

/* Deletion records, read as one set. */
typedef struct {
    char hash[65];
    char when[25];
    char *who;
    char *record; /* key of the record it came from */
} delrow_t;

typedef struct {
    sset_t idx; /* hash -> index into rows */
    delrow_t *rows;
    size_t n;
    size_t refused_records, refused_rows;
} delset_t;

/* Adds a record's rows to ds.  False (with err) if the record is refused whole, in which
 * case none of its rows count. */
bool rec_parse(const buf_t *text, const char *key, delset_t *ds, char *err, size_t errlen);
const delrow_t *del_lookup(const delset_t *ds, const char *hash);

/* Helpers exposed for the restorer. */
void split5(str_t line, str_t f[5], size_t *nf);
str_t trim_field(str_t s);
bool parse_mtime(str_t s, int64_t *sec, int32_t *ms);

#endif
