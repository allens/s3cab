// s3cab-restore: an independent restorer for the s3cab storage format, written from
// format.md alone.
//
//   s3cab-restore <bucket> <set> <dir> [<snapshot>]
//
// Reconstructs the files of one snapshot of <set> under <dir>, laid out as the spec says
// s3cab's own restore to a chosen directory lays them out: each file at its whole recorded
// path under <dir>, a drive's root as a folder named by its letter, a share's as UNC.
// Never overwrites: a file already there is skipped.
//
// Exit status: 0 everything restorable was restored (files already there, and files
// deliberately deleted from the repository, don't count against it); 1 something was
// refused, missing, withheld, in the way or not kept, and the rest restored; 2 the snapshot
// was refused whole and nothing was restored, or the restore had to stop part-way (a
// failure that says nothing about any one file: credentials, the network, the bucket).
//
// Credentials, region and proxy come from the environment: AWS_ACCESS_KEY_ID,
// AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN, AWS_REGION (else AWS_DEFAULT_REGION, else
// us-east-1), HTTPS_PROXY.
//
// Test aids, also from the environment, none of them needed to restore:
//   S3CAB_RESTORE_DEBUG=1           each request and its status on stderr (never a secret)
//   S3CAB_RESTORE_MAX_KEYS=<n>      ask for listings <n> keys a page
//   S3CAB_RESTORE_SNAPSHOT_FILE=<f> read the snapshot from a .tsv.gz on disk, not the bucket
//   S3CAB_RESTORE_FORGET_IDS=1      don't trust device and inode to tell what was written
#define _GNU_SOURCE
#include "s3.h"
#include "snapshot.h"

#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include <openssl/evp.h>
#include <unicode/unorm2.h>
#include <unicode/ustring.h>

// ---------------------------------------------------------------- state

static const char *out_dir;
static s3 *client;
static const snapshot *snap;
static deletions *records; // read at the first miss, and only then

static struct {
    size_t restored, skipped, refused, deleted, missing, withheld, collisions, in_the_way, failed;
    size_t time_rounded, time_not_kept;
} count;

// Files this restore has written, by device and inode: what tells a file that was there
// before the restore from one an earlier row landed.
typedef struct {
    dev_t dev;
    ino_t ino;
    bool used;
} file_id;
static file_id *written;
static size_t written_n, written_cap;

static size_t id_slot(const file_id *table, size_t cap, dev_t dev, ino_t ino) {
    size_t i = ((size_t)ino * 0x9E3779B97F4A7C15u ^ (size_t)dev) & (cap - 1);
    while (table[i].used && !(table[i].dev == dev && table[i].ino == ino)) i = (i + 1) & (cap - 1);
    return i;
}

static void written_add(dev_t dev, ino_t ino) {
    if ((written_n + 1) * 2 > written_cap) {
        size_t cap = written_cap ? written_cap * 2 : 1024;
        file_id *table = xcalloc(cap, sizeof *table);
        for (size_t i = 0; i < written_cap; i++)
            if (written[i].used) table[id_slot(table, cap, written[i].dev, written[i].ino)] = written[i];
        free(written);
        written = table;
        written_cap = cap;
    }
    size_t i = id_slot(written, written_cap, dev, ino);
    if (!written[i].used) {
        written[i] = (file_id){dev, ino, true};
        written_n++;
    }
}

static bool forget_ids; // test aid: behave as a disk whose device and inode don't last the run

static bool written_has(dev_t dev, ino_t ino) {
    return !forget_ids && written_cap && written[id_slot(written, written_cap, dev, ino)].used;
}

// The same files again, by path, under a key that ignores letter case, Unicode
// normalization and trailing dots and spaces. FAT and exFAT on Linux number a file anew
// once it leaves the cache, so there a file this restore wrote can turn up under an inode
// it never saw: the key picks which written paths to read again beside it.
typedef struct {
    char *key, *rel;
    size_t next; // 1 + the next entry in the same bucket, 0 for none
} twin_entry;
static twin_entry *twins;
static size_t twins_n, twins_cap;
static size_t *twin_heads;
static size_t twin_buckets;

static size_t key_hash(const char *s) {
    size_t h = 1469598103934665603u;
    for (; *s; s++) h = (h ^ (unsigned char)*s) * 1099511628211u;
    return h;
}

// NFKC_Casefold of each name, less its trailing dots and spaces: generous on purpose, since
// it only chooses what to look at.
static char *fold_key(char **comp, size_t ncomp) {
    UErrorCode e = U_ZERO_ERROR;
    const UNormalizer2 *fold = unorm2_getNFKCCasefoldInstance(&e);
    if (U_FAILURE(e)) die("ICU: no NFKC_Casefold: %s", u_errorName(e));
    buf key = {};
    for (size_t i = 0; i < ncomp; i++) {
        size_t n = strlen(comp[i]);
        if (n > INT32_MAX / 64) die("a name is too long");
        int32_t cap = (int32_t)n + 16, len16 = 0, folded = 0, len8 = 0;
        UChar *src = xmalloc((size_t)cap * sizeof *src);
        e = U_ZERO_ERROR;
        u_strFromUTF8(src, cap, &len16, comp[i], (int32_t)n, &e);
        if (U_FAILURE(e)) die("ICU: %s", u_errorName(e));
        int32_t dcap = len16 * 3 + 16;
        UChar *dst = xmalloc((size_t)dcap * sizeof *dst);
        folded = unorm2_normalize(fold, src, len16, dst, dcap, &e);
        if (e == U_BUFFER_OVERFLOW_ERROR) {
            e = U_ZERO_ERROR;
            dcap = folded + 1;
            dst = xrealloc(dst, (size_t)dcap * sizeof *dst);
            folded = unorm2_normalize(fold, src, len16, dst, dcap, &e);
        }
        if (U_FAILURE(e)) die("ICU: %s", u_errorName(e));
        while (folded > 0 && (dst[folded - 1] == '.' || dst[folded - 1] == ' ')) folded--;
        int32_t cap8 = folded * 3 + 1;
        char *out = xmalloc((size_t)cap8);
        u_strToUTF8(out, cap8, &len8, dst, folded, &e);
        if (U_FAILURE(e)) die("ICU: %s", u_errorName(e));
        if (i) buf_putc(&key, '/');
        buf_add(&key, out, (size_t)len8);
        free(src), free(dst), free(out);
    }
    return buf_cstr(&key);
}

static char *join_rel(char **comp, size_t ncomp) {
    buf rel = {};
    for (size_t i = 0; i < ncomp; i++) {
        if (i) buf_putc(&rel, '/');
        buf_puts(&rel, comp[i]);
    }
    return buf_cstr(&rel);
}

static void twins_add(char **comp, size_t ncomp) {
    if (twins_n == twins_cap) {
        twins_cap = twins_cap ? twins_cap * 2 : 1024;
        twins = xrealloc(twins, twins_cap * sizeof *twins);
    }
    if (twins_n >= twin_buckets) { // grow, and hang every entry again
        twin_buckets = twin_buckets ? twin_buckets * 2 : 2048;
        free(twin_heads);
        twin_heads = xcalloc(twin_buckets, sizeof *twin_heads);
        for (size_t i = 0; i < twins_n; i++) {
            size_t b = key_hash(twins[i].key) & (twin_buckets - 1);
            twins[i].next = twin_heads[b];
            twin_heads[b] = i + 1;
        }
    }
    twin_entry *t = &twins[twins_n];
    t->key = fold_key(comp, ncomp);
    t->rel = join_rel(comp, ncomp);
    size_t b = key_hash(t->key) & (twin_buckets - 1);
    t->next = twin_heads[b];
    twin_heads[b] = ++twins_n;
}

// Is what now sits at this destination a file this restore wrote under another spelling?
// Read the twin and each candidate again, side by side: the same device and inode at that
// moment is the same entry, whatever has happened since it was written.
static bool twin_written(int out_fd, char **comp, size_t ncomp) {
    if (!twins_n) return false;
    char *key = fold_key(comp, ncomp), *rel = join_rel(comp, ncomp);
    bool same = false;
    for (size_t i = twin_heads[key_hash(key) & (twin_buckets - 1)]; i && !same; i = twins[i - 1].next) {
        const twin_entry *t = &twins[i - 1];
        struct stat mine, theirs;
        if (strcmp(t->key, key) != 0) continue;
        if (fstatat(out_fd, t->rel, &mine, AT_SYMLINK_NOFOLLOW) < 0) continue;
        if (fstatat(out_fd, rel, &theirs, AT_SYMLINK_NOFOLLOW) < 0) continue;
        same = mine.st_dev == theirs.st_dev && mine.st_ino == theirs.st_ino;
    }
    free(key), free(rel);
    return same;
}

// Hashes already found missing, deliberately deleted, or withheld: never fetched again.
typedef enum { HASH_UNKNOWN, HASH_MISSING, HASH_DELETED, HASH_WITHHELD } hash_state;
typedef struct {
    char hash[65];
    hash_state state;
    char when[25];
} bad_hash;
static bad_hash *bad;
static size_t bad_n, bad_cap;

static size_t bad_slot(const bad_hash *table, size_t cap, const char *hash) {
    size_t h = 1469598103934665603u;
    for (int i = 0; i < 16; i++) h = (h ^ (unsigned char)hash[i]) * 1099511628211u;
    size_t i = h & (cap - 1);
    while (table[i].state != HASH_UNKNOWN && memcmp(table[i].hash, hash, 64) != 0) i = (i + 1) & (cap - 1);
    return i;
}

static const bad_hash *bad_find(str hash) {
    if (!bad_cap) return nullptr;
    const bad_hash *e = &bad[bad_slot(bad, bad_cap, hash.p)];
    return e->state == HASH_UNKNOWN ? nullptr : e;
}

static void bad_add(str hash, hash_state state, const char *when) {
    if ((bad_n + 1) * 2 > bad_cap) {
        size_t cap = bad_cap ? bad_cap * 2 : 256;
        bad_hash *table = xcalloc(cap, sizeof *table);
        for (size_t i = 0; i < bad_cap; i++)
            if (bad[i].state != HASH_UNKNOWN) table[bad_slot(table, cap, bad[i].hash)] = bad[i];
        free(bad);
        bad = table;
        bad_cap = cap;
    }
    bad_hash *e = &bad[bad_slot(bad, bad_cap, hash.p)];
    if (e->state == HASH_UNKNOWN) bad_n++;
    memcpy(e->hash, hash.p, 64);
    e->hash[64] = '\0';
    e->state = state;
    snprintf(e->when, sizeof e->when, "%s", when ? when : "");
}

// ---------------------------------------------------------------- reporting

// A name can hold control characters and a terminal's escape sequences: spell them out.
static void put_text(FILE *f, str s) {
    const unsigned char *p = (const unsigned char *)s.p;
    for (size_t i = 0; i < s.n;) {
        uint32_t cp;
        size_t len;
        if (p[i] < 0x80)
            cp = p[i], len = 1;
        else if (p[i] < 0xE0)
            cp = (uint32_t)(p[i] & 0x1F) << 6 | (p[i + 1] & 0x3F), len = 2;
        else if (p[i] < 0xF0)
            cp = (uint32_t)(p[i] & 0x0F) << 12 | (uint32_t)(p[i + 1] & 0x3F) << 6 | (p[i + 2] & 0x3F), len = 3;
        else
            cp = 0x10000, len = 4;
        if (cp < 0x20 || (cp >= 0x7F && cp <= 0x9F) || cp == 0x2028 || cp == 0x2029)
            fprintf(f, "\\u{%04X}", (unsigned)cp);
        else
            fwrite(p + i, 1, len, f);
        i += len;
    }
}

// One line per file row: what became of it, its path, and why.
[[gnu::format(printf, 3, 4)]] static void report(const char *tag, const file_row *r, const char *fmt, ...) {
    printf("%-10s ", tag);
    put_text(stdout, r->path);
    va_list ap;
    va_start(ap, fmt);
    fputs("  (", stdout);
    vprintf(fmt, ap);
    fputs(")", stdout);
    va_end(ap);
    printf("  [line %zu]\n", r->line);
}

static void report_plain(const char *tag, const file_row *r) {
    printf("%-10s ", tag);
    put_text(stdout, r->path);
    printf("  [line %zu]\n", r->line);
}

[[noreturn, gnu::format(printf, 1, 2)]] static void stop(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    fflush(stdout);
    fputs("s3cab-restore: the restore has stopped: ", stderr);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    va_end(ap);
    fprintf(stderr, "s3cab-restore: %zu file(s) were restored before it stopped; the rest were NOT restored\n",
            count.restored);
    exit(2);
}

static const char *describe(const s3_result *res, int r, char *tmp, size_t n) {
    if (r != S3_OK)
        snprintf(tmp, n, "%s", res->err[0] ? res->err : "no response");
    else
        snprintf(tmp, n, "HTTP %d%s%s", res->status, res->code[0] ? " " : "", res->code);
    return tmp;
}

// A miss is a 404 whose S3 error code is NoSuchKey or NotFound, or one with no code whose
// body an XML parser accepts (an empty one included). Any other 404 says nothing about the
// key: NoSuchBucket, or a body that isn't S3's at all.
static bool is_miss(const s3_result *res) {
    return res->status == 404 && res->body_ok &&
           (res->code[0] == '\0' || strcmp(res->code, "NoSuchKey") == 0 || strcmp(res->code, "NotFound") == 0);
}

// ---------------------------------------------------------------- deletion records

typedef struct {
    char **names;
    size_t n;
} name_list;

static void collect_record(void *ud, const char *key, bool is_prefix) {
    // objects.deleted-<n>.tsv, <n> a whole number from 1 up with no leading zero.
    static const char head[] = "objects.deleted-";
    if (is_prefix || strncmp(key, head, sizeof head - 1) != 0) return;
    const char *p = key + sizeof head - 1;
    if (*p < '1' || *p > '9') return;
    while (*p >= '0' && *p <= '9') p++;
    if (strcmp(p, ".tsv") != 0) return;
    name_list *list = ud;
    list->names = xrealloc(list->names, (list->n + 1) * sizeof *list->names);
    list->names[list->n++] = xstrdup(key);
}

// Every objects.deleted-<n>.tsv, read as one set. Any failure listing them, and any but a
// miss reading one, stops the restore; a record listed but gone when read explains nothing.
static void read_records(void) {
    records = deletions_new();
    name_list list = {};
    s3_result res = {};
    char tmp[600];
    int r = s3_list(client, "objects.deleted-", "/", collect_record, &list, &res);
    if (r != S3_OK || res.status != 200)
        stop("cannot list the deletion records: %s", describe(&res, r, tmp, sizeof tmp));
    for (size_t i = 0; i < list.n; i++) {
        r = s3_get(client, list.names[i], nullptr, &res);
        if (r == S3_OK && res.status == 200)
            deletions_add(records, res.body.p ? res.body.p : "", res.body.n);
        else if (r == S3_OK && is_miss(&res))
            printf("note      deletion record %s was listed but is gone: it explains nothing\n", list.names[i]);
        else
            stop("cannot read the deletion record %s: %s", list.names[i], describe(&res, r, tmp, sizeof tmp));
        free(list.names[i]);
    }
    printf("note      read %zu deletion record(s), %zu deleted hash(es)\n", list.n, deletions_count(records));
    free(list.names);
    s3_result_free(&res);
}

// ---------------------------------------------------------------- the destination

// Where a row lands: its whole path under <dir>, the root turned into a folder.
static size_t destination(const file_row *r, char ***out) {
    char **comp = xmalloc((r->nseg + 1) * sizeof *comp);
    size_t n = 0;
    if (r->kind == PATH_DRIVE)
        comp[n++] = xmemdup0(&r->drive, 1);
    else if (r->kind == PATH_SHARE)
        comp[n++] = xstrdup("UNC");
    for (size_t i = 0; i < r->nseg; i++) comp[n++] = xmemdup0(r->seg[i].p, r->seg[i].n);
    *out = comp;
    return n;
}

typedef enum { DEST_FREE, DEST_SKIP, DEST_COLLISION, DEST_IN_THE_WAY, DEST_ERROR } dest_state;

typedef struct {
    dest_state state;
    char why[400];
} dest_check;

// Look, without changing anything, at what is where the row would land. Every folder
// between <dir> and the file is looked at without following a link.
static dest_check look(char **comp, size_t ncomp) {
    dest_check d = {.state = DEST_FREE};
    int fd = open(out_dir, O_RDONLY | O_DIRECTORY | O_CLOEXEC); // <dir> itself may be a link
    if (fd < 0) {
        if (errno == ENOENT) return d;
        if (errno == ENOTDIR) {
            d.state = DEST_IN_THE_WAY;
            snprintf(d.why, sizeof d.why, "a file is at the output directory's own path");
        } else {
            d.state = DEST_ERROR;
            snprintf(d.why, sizeof d.why, "cannot open the output directory: %s", strerror(errno));
        }
        return d;
    }
    int out_fd = dup(fd);
    struct stat st;
    for (size_t i = 0; i + 1 < ncomp; i++) {
        int next = openat(fd, comp[i], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (next >= 0) {
            close(fd);
            fd = next;
            continue;
        }
        int open_errno = errno;
        if (fstatat(fd, comp[i], &st, AT_SYMLINK_NOFOLLOW) < 0) {
            if (errno != ENOENT) {
                d.state = DEST_ERROR;
                snprintf(d.why, sizeof d.why, "folder %zu of its path: %s", i + 1, strerror(errno));
            }
        } else if (S_ISLNK(st.st_mode)) {
            d.state = DEST_IN_THE_WAY;
            snprintf(d.why, sizeof d.why, "a link is where its folder '%.200s' should be", comp[i]);
        } else if (!S_ISDIR(st.st_mode)) {
            d.state = DEST_IN_THE_WAY;
            snprintf(d.why, sizeof d.why, "a file%s is where its folder '%.200s' should be",
                     written_has(st.st_dev, st.st_ino) ? " this restore wrote" : "", comp[i]);
        } else {
            d.state = DEST_ERROR;
            snprintf(d.why, sizeof d.why, "cannot open its folder '%.200s': %s", comp[i], strerror(open_errno));
        }
        close(fd);
        close(out_fd);
        return d;
    }
    if (fstatat(fd, comp[ncomp - 1], &st, AT_SYMLINK_NOFOLLOW) < 0) {
        if (errno != ENOENT) {
            d.state = DEST_ERROR;
            snprintf(d.why, sizeof d.why, "its name: %s", strerror(errno));
        }
    } else if (S_ISDIR(st.st_mode)) {
        d.state = DEST_IN_THE_WAY;
        snprintf(d.why, sizeof d.why, "a folder is where the file should land");
    } else if (written_has(st.st_dev, st.st_ino) || twin_written(out_fd, comp, ncomp)) {
        d.state = DEST_COLLISION; // an earlier row of this restore landed on this very file
    } else {
        d.state = DEST_SKIP; // there before the restore began (a link at the name counts)
    }
    close(fd);
    close(out_fd);
    return d;
}

// Folders made for the file being landed, so a file that fails leaves none of them.
typedef struct {
    int parent; // -1: `name` is a whole path
    char *name;
} made_dir;
static made_dir *made;
static size_t made_n;

static void made_push(int parent, const char *name) {
    made = xrealloc(made, (made_n + 1) * sizeof *made);
    made[made_n++] = (made_dir){parent >= 0 ? dup(parent) : -1, xstrdup(name)};
}

static void made_done(bool remove_them) {
    while (made_n) {
        made_dir *m = &made[--made_n];
        if (remove_them) {
            if (m->parent >= 0)
                unlinkat(m->parent, m->name, AT_REMOVEDIR);
            else
                rmdir(m->name);
        }
        if (m->parent >= 0) close(m->parent);
        free(m->name);
    }
}

// mkdir -p for <dir> itself, remembering what was made.
static int make_output_dir(void) {
    char *path = xstrdup(out_dir);
    size_t n = strlen(path);
    for (size_t i = 1; i <= n; i++) {
        if (path[i] != '/' && path[i] != '\0') continue;
        if (path[i - 1] == '/') continue;
        char saved = path[i];
        path[i] = '\0';
        if (mkdir(path, 0777) == 0) {
            made_push(-1, path);
        } else if (errno != EEXIST) {
            int e = errno;
            free(path);
            errno = e;
            return -1;
        }
        path[i] = saved;
    }
    free(path);
    return 0;
}

// The download: written and hashed as it arrives, begun again if the request is retried.
typedef struct {
    int fd;
    EVP_MD_CTX *md;
    int write_errno;
} download;

static int download_begin(void *ud) {
    download *d = ud;
    if (ftruncate(d->fd, 0) < 0 || lseek(d->fd, 0, SEEK_SET) < 0) {
        d->write_errno = errno;
        return 1;
    }
    return EVP_DigestInit_ex(d->md, EVP_sha256(), nullptr) == 1 ? 0 : 1;
}

static int download_data(void *ud, const unsigned char *p, size_t n) {
    download *d = ud;
    EVP_DigestUpdate(d->md, p, n);
    while (n) {
        ssize_t w = write(d->fd, p, n);
        if (w < 0 && errno == EINTR) continue;
        if (w <= 0) {
            d->write_errno = errno;
            return 1;
        }
        p += w;
        n -= (size_t)w;
    }
    return 0;
}

static int64_t floor_div(int64_t a, int64_t b) { return a / b - (a % b != 0 && (a < 0) != (b < 0)); }

static void format_ms(int64_t ms, char out[96]) {
    time_t sec = (time_t)floor_div(ms, 1000);
    struct tm tm;
    if (!gmtime_r(&sec, &tm)) {
        snprintf(out, 96, "%lld ms from 1970", (long long)ms);
        return;
    }
    snprintf(out, 96, "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday, tm.tm_hour,
             tm.tm_min, tm.tm_sec, (int)(ms - (int64_t)sec * 1000));
}

// Give the downloaded file its name, without ever replacing anything.
static int give_name(int tmp, int dir, const char *tmp_name, const char *name) {
    if (!tmp_name) { // an O_TMPFILE: no name yet
        if (linkat(tmp, "", dir, name, AT_EMPTY_PATH) == 0) return 0;
        if (errno == EEXIST) return -1;
        char proc[64];
        snprintf(proc, sizeof proc, "/proc/self/fd/%d", tmp);
        return linkat(AT_FDCWD, proc, dir, name, AT_SYMLINK_FOLLOW);
    }
    if (linkat(dir, tmp_name, dir, name, 0) == 0) return 0;
    if (errno == EEXIST) return -1;
    return renameat2(dir, tmp_name, dir, name, RENAME_NOREPLACE); // a disk with no hard links
}

// Fetch a row's content and land it. The destination was just looked at and is free.
static void land(const file_row *r, char **comp, size_t ncomp) {
    char hash[65], tmp[600];
    memcpy(hash, r->hash.p, 64);
    hash[64] = '\0';
    const char *name = comp[ncomp - 1];
    char tmp_name[64] = "";
    int dir = -1, fd = -1;
    bool landed = false;
    s3_result res = {};
    download d = {.fd = -1};

    // The file's folders first, each opened without following a link.
    if (make_output_dir() < 0) {
        report("FAILED", r, "cannot make the output directory: %s", strerror(errno));
        count.failed++;
        goto out;
    }
    dir = open(out_dir, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (dir < 0) {
        report("FAILED", r, "cannot open the output directory: %s", strerror(errno));
        count.failed++;
        goto out;
    }
    for (size_t i = 0; i + 1 < ncomp; i++) {
        if (mkdirat(dir, comp[i], 0777) == 0) {
            made_push(dir, comp[i]);
        } else if (errno != EEXIST) {
            report("FAILED", r, "cannot make its folder '%.200s': %s", comp[i], strerror(errno));
            count.failed++;
            goto out;
        }
        int next = openat(dir, comp[i], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (next < 0) {
            report("IN-THE-WAY", r, "its folder '%.200s' is not a folder any more: %s", comp[i], strerror(errno));
            count.in_the_way++;
            goto out;
        }
        close(dir);
        dir = next;
    }

    // Download beside the destination, into a file with no name where the disk allows one.
    fd = openat(dir, ".", O_TMPFILE | O_RDWR | O_CLOEXEC, 0666);
    if (fd < 0) {
        static unsigned long serial;
        snprintf(tmp_name, sizeof tmp_name, ".s3cab-restore-%ld-%lu.tmp", (long)getpid(), ++serial);
        unlinkat(dir, tmp_name, 0);
        fd = openat(dir, tmp_name, O_CREAT | O_EXCL | O_NOFOLLOW | O_RDWR | O_CLOEXEC, 0666);
        if (fd < 0) {
            report("FAILED", r, "cannot create a file in its folder: %s", strerror(errno));
            count.failed++;
            tmp_name[0] = '\0';
            goto out;
        }
    }

    d.fd = fd;
    d.md = EVP_MD_CTX_new();
    if (!d.md) die("EVP_MD_CTX_new failed");
    s3_sink sink = {.ud = &d, .begin = download_begin, .data = download_data};
    buf key = {};
    buf_printf(&key, "objects/%s", hash);
    int rc = s3_get(client, key.p, &sink, &res);
    buf_free(&key);

    if (rc == S3_LOCAL) {
        report("FAILED", r, "cannot write the file: %s", strerror(d.write_errno));
        count.failed++;
        goto out;
    }
    if (rc == S3_OK && is_miss(&res)) {
        // A fetch missed, and only now are the records consulted.
        if (!records) read_records();
        const char *when = deletions_newest(records, r->hash);
        if (when && snap->has_start && strcmp(when, snap->start) > 0) {
            report("deleted", r, "deliberately deleted from the repository on %s", when);
            count.deleted++;
            bad_add(r->hash, HASH_DELETED, when);
        } else {
            report("MISSING", r, "objects/%s is not in the bucket, and no deletion record explains it: damage", hash);
            count.missing++;
            bad_add(r->hash, HASH_MISSING, nullptr);
        }
        goto out;
    }
    if (rc != S3_OK || res.status != 200) {
        // Anything else says nothing about this file: stop the whole restore.
        if (tmp_name[0]) unlinkat(dir, tmp_name, 0);
        made_done(true);
        stop("GET objects/%s: %s", hash, describe(&res, rc, tmp, sizeof tmp));
    }

    unsigned char md[32];
    unsigned int mdlen = 32;
    char got[65];
    EVP_DigestFinal_ex(d.md, md, &mdlen);
    hex_encode(md, 32, got);
    if (strcmp(got, hash) != 0) {
        report("WITHHELD", r, "what objects/%s holds hashes to %s: damage, not written", hash, got);
        count.withheld++;
        bad_add(r->hash, HASH_WITHHELD, nullptr);
        goto out;
    }

    // The stored modification time, to the millisecond, and the access time the same.
    int64_t sec = floor_div(r->mtime_ms, 1000);
    struct timespec ts = {.tv_sec = (time_t)sec, .tv_nsec = (long)((r->mtime_ms - sec * 1000) * 1'000'000)};
    struct timespec both[2] = {ts, ts};
    bool time_set = futimens(fd, both) == 0;

    if (give_name(fd, dir, tmp_name[0] ? tmp_name : nullptr, name) < 0) {
        if (errno == EEXIST) {
            report("IN-THE-WAY", r, "something appeared at its destination while it was being downloaded");
            count.in_the_way++;
        } else {
            report("FAILED", r, "the destination won't take its name: %s", strerror(errno));
            count.failed++;
        }
        goto out;
    }
    landed = true; // a link leaves the temp name behind: it is removed below

    struct stat st;
    if (fstat(fd, &st) < 0) die("fstat: %s", strerror(errno));
    written_add(st.st_dev, st.st_ino);
    twins_add(comp, ncomp);
    count.restored++;

    // Read the time back: compare rounded to the millisecond.
    int64_t kept = (int64_t)st.st_mtim.tv_sec * 1000 + (st.st_mtim.tv_nsec + 500'000) / 1'000'000;
    int64_t off = kept > r->mtime_ms ? kept - r->mtime_ms : r->mtime_ms - kept;
    if (time_set && off == 0) {
        report_plain("restored", r);
    } else if (time_set && off < 2000) {
        report("restored", r, "the disk rounded its time");
        count.time_rounded++;
    } else {
        char has[96];
        format_ms(kept, has);
        report("TIME", r, "restored, but the destination can't hold its time %.*s: the file has %s", (int)r->time.n,
               r->time.p, has);
        count.time_not_kept++;
    }

out:
    if (fd >= 0) close(fd);
    if (dir >= 0) {
        if (tmp_name[0]) unlinkat(dir, tmp_name, 0); // whether the file landed or failed
        close(dir);
    }
    if (d.md) EVP_MD_CTX_free(d.md);
    made_done(!landed);
    s3_result_free(&res);
}

static void restore_row(const file_row *r) {
    if (r->refused) {
        report("REFUSED", r, "%s", r->refused);
        count.refused++;
        return;
    }
    char **comp;
    size_t ncomp = destination(r, &comp);
    dest_check d = look(comp, ncomp);
    const bad_hash *known = bad_find(r->hash);

    if (d.state == DEST_SKIP) {
        // The destination comes first: a skip fetches nothing, and wins over a hash already
        // found missing or withheld.
        report("skipped", r, "a file was already there; it was not checked");
        count.skipped++;
    } else if (known && known->state == HASH_DELETED) {
        report("deleted", r, "deliberately deleted from the repository on %s", known->when);
        count.deleted++;
    } else if (known && known->state == HASH_MISSING) {
        report("MISSING", r, "its object was already found missing: damage");
        count.missing++;
    } else if (known && known->state == HASH_WITHHELD) {
        report("WITHHELD", r, "its object was already found not to hash to its key: damage");
        count.withheld++;
    } else if (d.state == DEST_COLLISION) {
        report("COLLISION", r, "an earlier row of this snapshot landed on the same file");
        count.collisions++;
    } else if (d.state == DEST_IN_THE_WAY) {
        report("IN-THE-WAY", r, "%s", d.why);
        count.in_the_way++;
    } else if (d.state == DEST_ERROR) {
        report("FAILED", r, "%s", d.why);
        count.failed++;
    } else {
        land(r, comp, ncomp);
    }
    for (size_t i = 0; i < ncomp; i++) free(comp[i]);
    free(comp);
}

// ---------------------------------------------------------------- choosing the snapshot

// A set's name: a to z and digits, with single hyphens between them.
static bool set_name_ok(const char *s) {
    if (!*s) return false;
    char prev = '-';
    for (; *s; s++) {
        bool alnum = (*s >= 'a' && *s <= 'z') || (*s >= '0' && *s <= '9');
        if (!alnum && !(*s == '-' && prev != '-')) return false;
        prev = *s;
    }
    return prev != '-';
}

// A snapshot's name: YYYYMMDDTHHMM, digits in those places and nothing more. The digits
// needn't make a date.
static bool snapshot_name_ok(const char *s) {
    if (strlen(s) != 13) return false;
    for (int i = 0; i < 13; i++)
        if (i == 8 ? s[i] != 'T' : (s[i] < '0' || s[i] > '9')) return false;
    return true;
}

typedef struct {
    size_t prefix_len;
    char latest[14];
    size_t seen;
} latest_pick;

static void pick_latest(void *ud, const char *key, bool is_prefix) {
    latest_pick *p = ud;
    if (is_prefix || strlen(key) != p->prefix_len + 13 + 7) return; // a key in a folder below is no snapshot
    const char *name = key + p->prefix_len;
    if (strcmp(name + 13, ".tsv.gz") != 0) return;
    char stem[14];
    memcpy(stem, name, 13);
    stem[13] = '\0';
    if (!snapshot_name_ok(stem)) return;
    p->seen++;
    if (strcmp(stem, p->latest) > 0) memcpy(p->latest, stem, 14); // the name that sorts last
}

int main(int argc, char **argv) {
    if (argc < 4 || argc > 5) {
        fprintf(stderr, "usage: s3cab-restore <bucket> <set> <dir> [<snapshot>]\n");
        return 2;
    }
    const char *bucket = argv[1], *set = argv[2];
    out_dir = argv[3];
    if (!*out_dir) die("the output directory's name is empty");
    if (!set_name_ok(set))
        die("'%s' is not a set's name: a to z and digits, with single hyphens between them", set);

    char name[14] = "";
    if (argc == 5) {
        // Accept the name as the spec gives it, or the file's name.
        size_t n = strlen(argv[4]);
        if (n == 20 && strcmp(argv[4] + 13, ".tsv.gz") == 0) n = 13;
        if (n != 13) die("'%s' is not a snapshot's name (YYYYMMDDTHHMM)", argv[4]);
        memcpy(name, argv[4], 13);
        name[13] = '\0';
        if (!snapshot_name_ok(name)) die("'%s' is not a snapshot's name (YYYYMMDDTHHMM)", argv[4]);
    }

    setvbuf(stdout, nullptr, _IOLBF, 0);
    forget_ids = getenv("S3CAB_RESTORE_FORGET_IDS") != nullptr;
    client = s3_open(bucket);
    s3_result res = {};
    char tmp[600];
    buf key = {};

    // Test aid: S3CAB_RESTORE_SNAPSHOT_FILE names a .tsv.gz on disk to read in place of the
    // set's snapshot, so the row and destination rules can be tried on hand-edited snapshots
    // without writing to a bucket. Objects and deletion records still come from the bucket.
    const char *local = getenv("S3CAB_RESTORE_SNAPSHOT_FILE");
    if (local && *local) {
        FILE *f = fopen(local, "rb");
        if (!f) die("cannot open %s: %s", local, strerror(errno));
        char chunk[65536];
        size_t got;
        while ((got = fread(chunk, 1, sizeof chunk, f)) > 0) buf_add(&res.body, chunk, got);
        fclose(f);
        buf_printf(&key, "%s (a file on disk, not the bucket's)", local);
    } else {
        if (!name[0]) {
            // The latest: the key directly under snapshots/<set>/ whose name sorts last, over
            // every page of the listing. No falling back to an earlier one if it is refused.
            buf_printf(&key, "snapshots/%s/", set);
            latest_pick pick = {.prefix_len = key.n};
            int r = s3_list(client, key.p, "/", pick_latest, &pick, &res);
            if (r != S3_OK || res.status != 200)
                die("cannot list %s in bucket %s: %s", key.p, bucket, describe(&res, r, tmp, sizeof tmp));
            if (!pick.seen) die("set '%s' has no snapshot in bucket %s", set, bucket);
            memcpy(name, pick.latest, 14);
            key.n = 0;
        }
        buf_printf(&key, "snapshots/%s/%s.tsv.gz", set, name);
        int r = s3_get(client, key.p, nullptr, &res);
        if (r == S3_OK && is_miss(&res)) die("there is no snapshot %s in bucket %s", key.p, bucket);
        if (r != S3_OK || res.status != 200) die("cannot fetch %s: %s", key.p, describe(&res, r, tmp, sizeof tmp));
    }
    printf("snapshot  %s (%zu bytes)\n", key.p, res.body.n);

    // The whole snapshot is checked before any row of it is restored.
    buf text = {};
    const char *damage;
    if (!snapshot_gunzip((const unsigned char *)(res.body.p ? res.body.p : ""), res.body.n, &text, &damage))
        die("%s is refused whole: it is damaged: %s. Nothing was restored.", key.p, damage);
    char *why;
    snapshot *s = snapshot_parse(text, &why);
    if (!s) die("%s is refused whole: %s. Nothing was restored.", key.p, why);
    snap = s;
    s3_result_free(&res);
    printf("          %zu line(s), %zu file row(s), %zu @SET DIR row(s), START %s\n", s->nlines, s->nrows, s->ndirs,
           s->has_start ? s->start : "(none)");

    for (size_t i = 0; i < s->nrows; i++) restore_row(&s->rows[i]);

    size_t damage_count = count.refused + count.missing + count.withheld + count.collisions + count.in_the_way +
                          count.failed + count.time_not_kept;
    printf("summary   %zu restored, %zu skipped (already there), %zu deliberately deleted", count.restored,
           count.skipped, count.deleted);
    if (count.time_rounded) printf(", %zu time(s) rounded by the disk", count.time_rounded);
    printf("\n");
    if (damage_count) {
        printf("problems  %zu refused, %zu missing, %zu withheld, %zu collision(s), %zu in the way, %zu failed, "
               "%zu time(s) not kept\n",
               count.refused, count.missing, count.withheld, count.collisions, count.in_the_way, count.failed,
               count.time_not_kept);
        printf("          this is NOT a full restore of %s\n", key.p);
    }
    if (getenv("S3CAB_RESTORE_DEBUG")) fprintf(stderr, "  [http] %lu request(s) in all\n", s3_request_count(client));
    buf_free(&key);
    s3_close(client);
    return damage_count ? 1 : 0;
}
