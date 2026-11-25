// Reading the format's files: a snapshot (.tsv.gz) and a deletion record (.tsv), by the
// rules of format.md and nothing else.
#ifndef SNAPSHOT_H
#define SNAPSHOT_H

#include "util.h"

typedef struct {
    const char *p;
    size_t n;
} str;

typedef enum { PATH_NOT_ABSOLUTE, PATH_POSIX, PATH_DRIVE, PATH_SHARE } path_kind;

typedef struct {
    size_t line;         // 1-based line number in the decompressed text
    str hash, size, time; // the leading fields, trimmed
    str path;            // the last field, verbatim
    const char *refused; // null, or why this one row is refused
    int64_t mtime_ms;    // milliseconds since 1970, when the time is a real instant
    path_kind kind;
    char drive;          // PATH_DRIVE: the letter, upper case
    size_t nseg;         // the path's segments after its root
    str *seg;
} file_row;

typedef struct snapshot {
    buf text;
    file_row *rows; // every `-` row, in file order, refused ones included
    size_t nrows;
    bool has_start; // the last @SNAPSHOT START holds a real instant
    char start[25];
    size_t ndirs;   // @SET DIR rows with a value
    size_t nlines;
    struct dir_spec *dirs;
} snapshot;

// Decompress a snapshot as the spec's gzip rules say: every stream in turn, a zero byte
// after a stream ends the file, anything else is damage. Returns false and sets *why.
bool snapshot_gunzip(const unsigned char *gz, size_t n, buf *text, const char **why);

// Check a decompressed snapshot whole. Takes ownership of `text`. Returns null and sets
// *why (a malloc'd string) when the file is refused whole.
snapshot *snapshot_parse(buf text, char **why);
void snapshot_free(snapshot *s);

// A real instant in the 24-character form YYYY-MM-DDTHH:MM:SS.sssZ.
bool instant_parse(str s, int64_t *ms);

// Deletion records, read as one set.
typedef struct deletions deletions;
deletions *deletions_new(void);
void deletions_add(deletions *d, const char *text, size_t n);
// The newest instant a well-formed row gives this hash, or null.
const char *deletions_newest(const deletions *d, str hash);
size_t deletions_count(const deletions *d);
void deletions_free(deletions *d);

#endif
