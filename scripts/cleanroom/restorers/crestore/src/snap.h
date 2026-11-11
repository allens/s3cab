#ifndef S3CAB_SNAP_H
#define S3CAB_SNAP_H
#include "common.h"

typedef enum { KIND_POSIX, KIND_DRIVE, KIND_SHARE, KIND_RELATIVE } path_kind;

typedef struct {
    path_kind kind;
    unsigned char drive;   /* uppercase letter for KIND_DRIVE */
    span_t *segs;          /* views into the path's bytes */
    size_t nsegs;
    bool bad_segment;      /* an empty, "." or ".." segment past the root */
} path_parts;

/* Classify and segment a path.  For a DIR (is_dir), trailing separators are
 * ignored first.  Segments are views into p. */
void path_split(const unsigned char *p, size_t n, bool is_dir, path_parts *out);
void path_parts_free(path_parts *pp);

typedef struct {
    span_t text;             /* the DIR as written */
    path_parts parts;        /* of the text (POSIX) or of its lowercased form (Windows) */
    unsigned char *lower;    /* lowercased copy for Windows kinds, else NULL */
    size_t lowern;
    bool usable;             /* false when it can match nothing */
} dir_t;

typedef struct {
    int line;                /* 1-based line number in the text */
    span_t hash, size, mtime, path;
    int64_t mtime_ms;
    path_parts parts;        /* of the path as written */
    const char *refused;     /* NULL when the row is accepted; otherwise why */
    size_t dup_group;        /* internal */
} file_row;

typedef struct {
    buf_t text;              /* decompressed text, owned */
    dir_t *dirs; size_t ndirs;
    bool has_start; char start[25];
    file_row *rows; size_t nrows;
    size_t nrefused;
} snapshot;

/* Decompress and parse a snapshot.  Returns NULL on success, or a static
 * reason the whole file is refused. */
const char *snapshot_load(const unsigned char *gz, size_t n, snapshot *out);
void snapshot_free(snapshot *s);

/* Deletion records: hash -> newest instant among well-formed rows. */
typedef struct { char hash[65]; char instant[25]; } del_entry;
typedef struct { del_entry *e; size_t n, cap; } del_table;
void record_parse(const unsigned char *text, size_t n, del_table *t);
const char *del_lookup(const del_table *t, const char *hash64);
void del_table_free(del_table *t);

#endif
