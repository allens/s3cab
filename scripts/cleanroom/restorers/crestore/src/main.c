/* s3cab-restore <bucket> <set> <dir> [<snapshot>]
 * Restores a set's snapshot (the latest when none is named) under <dir>,
 * laid out as format.md describes s3cab's own restore to a chosen directory. */
#include "snap.h"
#include <errno.h>
#include <fcntl.h>
#include <unistd.h>
#include <locale.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <openssl/evp.h>

typedef struct { dev_t dev; ino_t ino; } fileid;
typedef struct { fileid *v; size_t n, cap; } idset;
static void idset_add(idset *s, dev_t d, ino_t i) {
    if (s->n == s->cap) { s->cap = s->cap ? s->cap * 2 : 256; s->v = xrealloc(s->v, s->cap * sizeof *s->v); }
    s->v[s->n++] = (fileid){ d, i };
}
static bool idset_has(const idset *s, dev_t d, ino_t i) {
    for (size_t k = 0; k < s->n; k++) if (s->v[k].dev == d && s->v[k].ino == i) return true;
    return false;
}

typedef enum { BAD_MISSING, BAD_DELETED, BAD_WITHHELD } badkind;
typedef struct { char hash[65]; badkind kind; char date[25]; } badhash;
typedef struct { badhash *v; size_t n, cap; } badset;
static badhash *bad_find(badset *s, const char *h) { for (size_t k = 0; k < s->n; k++) if (!strcmp(s->v[k].hash, h)) return &s->v[k]; return NULL; }
static void bad_add(badset *s, const char *h, badkind k, const char *date) {
    if (s->n == s->cap) { s->cap = s->cap ? s->cap * 2 : 64; s->v = xrealloc(s->v, s->cap * sizeof *s->v); }
    badhash *b = &s->v[s->n++];
    snprintf(b->hash, sizeof b->hash, "%s", h); b->kind = k;
    snprintf(b->date, sizeof b->date, "%s", date ? date : "");
}

typedef struct { char **v; size_t n, cap; } strlist;
static void strlist_push(strlist *l, char *s) {
    if (l->n == l->cap) { l->cap = l->cap ? l->cap * 2 : 16; l->v = xrealloc(l->v, l->cap * sizeof *l->v); }
    l->v[l->n++] = s;
}
static void strlist_free(strlist *l) { for (size_t i = 0; i < l->n; i++) free(l->v[i]); free(l->v); memset(l, 0, sizeof *l); }

/* Counters for the summary and exit status. */
static struct {
    size_t restored, skipped_existing, deleted, missing, withheld, refused, collision, in_the_way, time_rounded, time_not_kept, name_refused;
} C;

static s3_client *g_s3;
static del_table g_del; static bool g_del_loaded;
static bool g_verbose = true;

static void say(const char *status, const unsigned char *path, size_t n, const char *fmt, ...) __attribute__((format(printf, 4, 5)));
static void say(const char *status, const unsigned char *path, size_t n, const char *fmt, ...) {
    printf("%-10s ", status);
    print_path(stdout, path, n);
    if (fmt) {
        va_list ap; va_start(ap, fmt);
        printf("  (");
        vprintf(fmt, ap);
        printf(")");
        va_end(ap);
    }
    printf("\n");
}

/* Load every deletion record, once, on the first miss. */
static void load_records(void) {
    if (g_del_loaded) return;
    g_del_loaded = true;
    s3_keylist l = {0}; char *err = NULL;
    if (!s3_list(g_s3, "objects.deleted-", &l, &err)) die("listing deletion records: %s", err);
    size_t nrec = 0;
    for (size_t i = 0; i < l.n; i++) {
        const char *k = l.keys[i];
        /* exactly objects.deleted-<n>.tsv, n a whole number from 1 up, no leading zero */
        if (strncmp(k, "objects.deleted-", 16)) continue;
        const char *d = k + 16; size_t dn = strspn(d, "0123456789");
        if (dn == 0 || d[0] == '0' || strcmp(d + dn, ".tsv")) continue;
        buf_t body; buf_init(&body);
        s3_status st = s3_get(g_s3, k, NULL, NULL, &body, &err);
        if (st == S3_MISS) { fprintf(stderr, "s3cab-restore: record %s listed but gone; it explains nothing\n", k); continue; }
        if (st == S3_ERROR) die("reading deletion record %s: %s", k, err);
        record_parse(body.p, body.len, &g_del);
        buf_free(&body);
        nrec++;
    }
    s3_keylist_free(&l);
    if (g_verbose) fprintf(stderr, "s3cab-restore: read %zu deletion record(s), %zu hash(es)\n", nrec, g_del.n);
}

/* ---- destination layout ---- */

/* Components under <dir>: the root's folder (drive letter or UNC), then every
 * segment with the row's spelling. */
static void dest_components(const file_row *row, strlist *comps) {
    if (row->parts.kind == KIND_DRIVE) { char d[2] = { (char)row->parts.drive, 0 }; strlist_push(comps, xstrdup(d)); }
    else if (row->parts.kind == KIND_SHARE) strlist_push(comps, xstrdup("UNC"));
    for (size_t i = 0; i < row->parts.nsegs; i++) strlist_push(comps, xstrndup((const char *)row->parts.segs[i].p, row->parts.segs[i].n));
}

static char *join_path(const char *base, strlist *comps, size_t upto) {
    buf_t b; buf_init(&b);
    buf_appendstr(&b, base);
    for (size_t i = 0; i < upto; i++) { if (b.len && b.p[b.len - 1] != '/') buf_appendstr(&b, "/"); buf_appendstr(&b, comps->v[i]); }
    return (char *)b.p;
}

/* Make <dir> and its missing parents (links allowed there: the user named it). */
static bool ensure_outdir(const char *dir, strlist *made, char *why, size_t whyn) {
    struct stat st;
    if (stat(dir, &st) == 0) { if (S_ISDIR(st.st_mode)) return true; snprintf(why, whyn, "%s is not a directory", dir); return false; }
    char *copy = xstrdup(dir);
    size_t len = strlen(copy);
    /* find each prefix and mkdir it */
    for (size_t i = 1; i <= len; i++) {
        if (i < len && copy[i] != '/') continue;
        char saved = copy[i]; copy[i] = 0;
        if (copy[0] && stat(copy, &st) != 0) {
            if (mkdir(copy, 0777) != 0 && errno != EEXIST) { snprintf(why, whyn, "mkdir %s: %s", copy, strerror(errno)); free(copy); return false; }
            strlist_push(made, xstrdup(copy));
        } else if (copy[0] && !S_ISDIR(st.st_mode)) { snprintf(why, whyn, "%s is not a directory", copy); free(copy); return false; }
        copy[i] = saved;
    }
    free(copy);
    return true;
}

static void undo_made(strlist *made) {
    for (size_t i = made->n; i-- > 0;) rmdir(made->v[i]);
}

/* ---- download ---- */
typedef struct { int fd; EVP_MD_CTX *md; uint64_t n; int werr; } dl_ctx;
static bool dl_cb(void *ud, const unsigned char *d, size_t n) {
    dl_ctx *c = ud;
    EVP_DigestUpdate(c->md, d, n);
    while (n) {
        ssize_t w = write(c->fd, d, n);
        if (w < 0) { if (errno == EINTR) continue; c->werr = errno; return false; }
        d += w; n -= (size_t)w; c->n += (uint64_t)w;
    }
    return true;
}

static int64_t floordiv(int64_t a, int64_t b) { int64_t q = a / b; if ((a % b != 0) && ((a < 0) != (b < 0))) q--; return q; }

static void ms_to_timespec(int64_t ms, struct timespec *ts) {
    ts->tv_sec = (time_t)floordiv(ms, 1000);
    ts->tv_nsec = (long)((ms - ts->tv_sec * 1000) * 1000000);
}
static int64_t timespec_to_ms_rounded(const struct timespec *ts) {
    /* round to nearest millisecond, a tie to the later */
    int64_t ns = (int64_t)ts->tv_nsec;
    int64_t ms_in_sec = floordiv(ns + 500000, 1000000);
    return (int64_t)ts->tv_sec * 1000 + ms_in_sec;
}

/* Restore one accepted row.  Returns nothing; updates counters. */
static void restore_row(const char *outdir, const snapshot *snap, const file_row *row, idset *written, badset *bad) {
    char hash[65]; memcpy(hash, row->hash.p, 64); hash[64] = 0;

    /* A hash already found missing or withheld is reported as that again,
     * before or after anything lands, and not fetched again. */
    badhash *known = bad_find(bad, hash);
    if (known) {
        if (known->kind == BAD_DELETED) { say("deleted", row->path.p, row->path.n, "deliberately deleted %s", known->date); C.deleted++; }
        else if (known->kind == BAD_MISSING) { say("MISSING", row->path.p, row->path.n, "objects/%s not in the bucket; damage", hash); C.missing++; }
        else { say("WITHHELD", row->path.p, row->path.n, "objects/%s does not hash to its key; damage", hash); C.withheld++; }
        return;
    }

    strlist comps = {0}; dest_components(row, &comps);
    char *dest = join_path(outdir, &comps, comps.n);
    strlist made = {0};
    char why[512];

    /* Check the way to the file: each folder inside <dir> by lstat. */
    struct stat st;
    bool outdir_exists = stat(outdir, &st) == 0 && S_ISDIR(st.st_mode);
    size_t first_missing = SIZE_MAX;
    if (!outdir_exists) first_missing = 0;
    for (size_t i = 1; i < comps.n && first_missing == SIZE_MAX; i++) {
        char *p = join_path(outdir, &comps, i);
        if (lstat(p, &st) != 0) {
            if (errno == ENOENT) first_missing = i;
            else if (errno == ENAMETOOLONG) { say("NAME", row->path.p, row->path.n, "the destination won't hold this name: %s", strerror(errno)); C.name_refused++; free(p); goto out; }
            else { say("ERROR", row->path.p, row->path.n, "cannot check %s: %s", p, strerror(errno)); C.in_the_way++; free(p); goto out; }
        } else if (S_ISLNK(st.st_mode)) { say("IN-THE-WAY", row->path.p, row->path.n, "a link where the folder %s should be", p); C.in_the_way++; free(p); goto out; }
        else if (!S_ISDIR(st.st_mode)) { say("IN-THE-WAY", row->path.p, row->path.n, "a file where the folder %s should be", p); C.in_the_way++; free(p); goto out; }
        free(p);
    }
    /* The destination itself. */
    if (first_missing == SIZE_MAX) {
        if (lstat(dest, &st) == 0) {
            if (S_ISDIR(st.st_mode)) { say("IN-THE-WAY", row->path.p, row->path.n, "a folder where the file %s should land", dest); C.in_the_way++; goto out; }
            if (idset_has(written, st.st_dev, st.st_ino)) { say("COLLISION", row->path.p, row->path.n, "another row already landed at %s", dest); C.collision++; goto out; }
            say("skipped", row->path.p, row->path.n, "already there before the restore: %s", dest); C.skipped_existing++; goto out;
        } else if (errno == ENAMETOOLONG) { say("NAME", row->path.p, row->path.n, "the destination won't hold this name: %s", strerror(errno)); C.name_refused++; goto out; }
        else if (errno != ENOENT) { say("ERROR", row->path.p, row->path.n, "cannot check %s: %s", dest, strerror(errno)); C.in_the_way++; goto out; }
    }

    /* Make the folders, remembering what we made. */
    if (!outdir_exists && !ensure_outdir(outdir, &made, why, sizeof why)) die("%s", why);
    for (size_t i = 1; i < comps.n; i++) {
        char *p = join_path(outdir, &comps, i);
        if (mkdir(p, 0777) == 0) strlist_push(&made, p);
        else if (errno == EEXIST) free(p);
        else { say("ERROR", row->path.p, row->path.n, "mkdir %s: %s", p, strerror(errno)); C.name_refused++; free(p); undo_made(&made); goto out; }
    }
    char *parent = join_path(outdir, &comps, comps.n - 1);

    /* Download into an unnamed file in the destination's folder, hashing as
     * it arrives; give it its name only once the hash matches. */
    bool tmpfile_named = false; char *tmpname = NULL;
    int fd = getenv("S3CAB_NO_TMPFILE") ? -1 : open(parent, O_TMPFILE | O_WRONLY | O_CLOEXEC, 0666); /* env: test hook for the fallback */
    if (fd < 0) {
        /* Fallback: a uniquely named temp file beside the destination. */
        buf_t t; buf_init(&t); buf_appendf(&t, "%s/.s3cab-restore.%ld.tmp", parent, (long)getpid());
        tmpname = (char *)t.p; tmpfile_named = true;
        unlink(tmpname);
        fd = open(tmpname, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0666);
        if (fd < 0) { say("ERROR", row->path.p, row->path.n, "cannot create a file in %s: %s", parent, strerror(errno)); C.name_refused++; free(parent); free(tmpname); undo_made(&made); goto out; }
    }
    dl_ctx dl = { fd, EVP_MD_CTX_new(), 0, 0 };
    EVP_DigestInit_ex(dl.md, EVP_sha256(), NULL);
    char key[80]; snprintf(key, sizeof key, "objects/%s", hash);
    char *err = NULL;
    s3_status sst = s3_get(g_s3, key, dl_cb, &dl, NULL, &err);
    bool landed = false;
    if (sst == S3_ERROR) {
        if (dl.werr) die("writing %s: %s", parent, strerror(dl.werr));
        die("fetching %s: %s", key, err ? err : "unknown error");
    }
    if (sst == S3_MISS) {
        load_records();
        const char *when = del_lookup(&g_del, hash);
        if (when && snap->has_start && strcmp(when, snap->start) > 0) {
            say("deleted", row->path.p, row->path.n, "deliberately deleted %s", when); C.deleted++;
            bad_add(bad, hash, BAD_DELETED, when);
        } else {
            say("MISSING", row->path.p, row->path.n, "objects/%s not in the bucket; damage%s", hash,
                when ? " (a deletion record lists it, but not after this snapshot's START)" : "");
            C.missing++;
            bad_add(bad, hash, BAD_MISSING, NULL);
        }
    } else {
        unsigned char dgst[32]; unsigned int dl_len = 32;
        EVP_DigestFinal_ex(dl.md, dgst, &dl_len);
        char got[65]; hex_encode(dgst, 32, got);
        if (strcmp(got, hash) != 0) {
            say("WITHHELD", row->path.p, row->path.n, "download hashes to %s, not its key; damage", got); C.withheld++;
            bad_add(bad, hash, BAD_WITHHELD, NULL);
        } else {
            struct timespec ts[2]; ms_to_timespec(row->mtime_ms, &ts[0]); ts[1] = ts[0];
            if (futimens(fd, ts) != 0) { say("TIME", row->path.p, row->path.n, "cannot set the modification time: %s", strerror(errno)); }
            int rc;
            if (!tmpfile_named) {
                char procpath[64]; snprintf(procpath, sizeof procpath, "/proc/self/fd/%d", fd);
                rc = linkat(AT_FDCWD, procpath, AT_FDCWD, dest, AT_SYMLINK_FOLLOW);
            } else {
                rc = renameat2(AT_FDCWD, tmpname, AT_FDCWD, dest, RENAME_NOREPLACE);
            }
            if (rc != 0) {
                if (errno == EEXIST) { say("IN-THE-WAY", row->path.p, row->path.n, "something appeared at %s while restoring", dest); C.in_the_way++; }
                else { say("NAME", row->path.p, row->path.n, "the destination won't create this name: %s", strerror(errno)); C.name_refused++; }
            } else {
                landed = true;
                struct stat fs;
                if (fstat(fd, &fs) == 0) {
                    idset_add(written, fs.st_dev, fs.st_ino);
                    int64_t back = timespec_to_ms_rounded(&fs.st_mtim);
                    int64_t diff = back - row->mtime_ms; if (diff < 0) diff = -diff;
                    if (diff == 0) { say("restored", row->path.p, row->path.n, NULL); C.restored++; }
                    else if (diff < 2000) { say("restored", row->path.p, row->path.n, "time rounded by the disk, off by %lldms", (long long)diff); C.restored++; C.time_rounded++; }
                    else {
                        struct tm tmv; time_t sec = (time_t)floordiv(back, 1000); gmtime_r(&sec, &tmv);
                        char tb[40]; strftime(tb, sizeof tb, "%Y-%m-%dT%H:%M:%S", &tmv);
                        say("TIME", row->path.p, row->path.n, "restored, but the disk holds %s.%03lldZ, not %.24s", tb, (long long)(back - sec * 1000), (const char *)row->mtime.p);
                        C.restored++; C.time_not_kept++;
                    }
                } else { say("restored", row->path.p, row->path.n, NULL); C.restored++; }
            }
        }
    }
    EVP_MD_CTX_free(dl.md);
    close(fd);
    if (tmpfile_named) { if (!landed) unlink(tmpname); free(tmpname); }
    if (!landed) undo_made(&made);
    free(parent);
out:
    free(dest);
    strlist_free(&comps);
    strlist_free(&made);
}

static bool is_snapshot_name(const char *name) {
    /* YYYYMMDDTHHMM.tsv.gz: digits in those places and nothing more */
    static const char pat[] = "ddddddddTdddd.tsv.gz";
    if (strlen(name) != sizeof pat - 1) return false;
    for (size_t i = 0; pat[i]; i++) {
        if (pat[i] == 'd') { if (name[i] < '0' || name[i] > '9') return false; }
        else if (name[i] != pat[i]) return false;
    }
    return true;
}

static const char *envor(const char *a, const char *b) { const char *v = getenv(a); if (v && *v) return v; v = b ? getenv(b) : NULL; return v && *v ? v : NULL; }

int main(int argc, char **argv) {
    setlocale(LC_CTYPE, "C.UTF-8");
    if (argc < 4 || argc > 5) { fprintf(stderr, "usage: s3cab-restore <bucket> <set> <dir> [<snapshot>]\n"); return 2; }
    const char *bucket = argv[1], *set = argv[2], *outdir = argv[3], *snapname = argc == 5 ? argv[4] : NULL;
    const char *akid = envor("AWS_ACCESS_KEY_ID", NULL), *secret = envor("AWS_SECRET_ACCESS_KEY", NULL), *token = envor("AWS_SESSION_TOKEN", NULL);
    const char *region = envor("AWS_REGION", "AWS_DEFAULT_REGION");
    const char *proxy = envor("HTTPS_PROXY", "https_proxy");
    if (!akid || !secret) die("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set");
    if (!region) region = "us-east-1";
    g_s3 = s3_new(bucket, region, akid, secret, token, proxy);

    /* Which snapshot. */
    buf_t key; buf_init(&key);
    char name[64];
    if (snapname) {
        snprintf(name, sizeof name, "%s", snapname);
        size_t nl = strlen(name);
        if (nl > 7 && !strcmp(name + nl - 7, ".tsv.gz")) name[nl - 7] = 0;
        buf_appendf(&key, "snapshots/%s/%s.tsv.gz", set, name);
    } else {
        buf_t prefix; buf_init(&prefix); buf_appendf(&prefix, "snapshots/%s/", set);
        s3_keylist l = {0}; char *err = NULL;
        if (!s3_list(g_s3, buf_cstr(&prefix), &l, &err)) die("listing %s: %s", buf_cstr(&prefix), err);
        const char *best = NULL;
        for (size_t i = 0; i < l.n; i++) {
            const char *base = l.keys[i] + prefix.len;
            if (!is_snapshot_name(base)) continue;
            if (!best || strcmp(base, best) > 0) best = base;
        }
        if (!best) die("set %s has no snapshot in %s", set, bucket);
        snprintf(name, sizeof name, "%.13s", best);
        buf_appendf(&key, "%s%s", buf_cstr(&prefix), best);
        s3_keylist_free(&l); buf_free(&prefix);
    }
    fprintf(stderr, "s3cab-restore: snapshot %s\n", buf_cstr(&key));

    buf_t gz; buf_init(&gz); char *err = NULL;
    const char *local = getenv("S3CAB_SNAPSHOT_FILE");
    if (local && *local) {
        /* Test hook: read the snapshot from a local file instead of the
         * bucket.  Objects are still fetched from the bucket. */
        FILE *f = fopen(local, "rb");
        if (!f) die("opening %s: %s", local, strerror(errno));
        unsigned char tmp[65536]; size_t r;
        while ((r = fread(tmp, 1, sizeof tmp, f)) > 0) buf_append(&gz, tmp, r);
        fclose(f);
        fprintf(stderr, "s3cab-restore: (snapshot bytes read from %s)\n", local);
    } else {
        s3_status st = s3_get(g_s3, buf_cstr(&key), NULL, NULL, &gz, &err);
        if (st == S3_MISS) die("no such snapshot: %s", buf_cstr(&key));
        if (st == S3_ERROR) die("fetching %s: %s", buf_cstr(&key), err);
    }

    snapshot snap;
    const char *refusal = snapshot_load(gz.p, gz.len, &snap);
    if (refusal) {
        fprintf(stderr, "s3cab-restore: REFUSED snapshot %s: %s\n", buf_cstr(&key), refusal);
        fprintf(stderr, "s3cab-restore: nothing restored; reach for an intact snapshot\n");
        return 1;
    }
    buf_free(&gz);
    fprintf(stderr, "s3cab-restore: %zu file row(s), %zu @SET DIR row(s), START %s\n", snap.nrows, snap.ndirs, snap.has_start ? snap.start : "(none)");

    idset written = {0}; badset bad = {0};
    for (size_t i = 0; i < snap.nrows; i++) {
        file_row *row = &snap.rows[i];
        if (row->refused) { say("REFUSED", row->path.p, row->path.n, "line %d: %s", row->line, row->refused); C.refused++; continue; }
        restore_row(outdir, &snap, row, &written, &bad);
    }

    printf("\n%zu restored", C.restored);
    if (C.time_rounded) printf(" (%zu with the time rounded by the disk)", C.time_rounded);
    printf(", %zu skipped (already there), %zu deliberately deleted, %zu missing, %zu withheld, %zu refused, %zu collision(s), %zu in the way, %zu time(s) not kept, %zu name(s) refused\n",
           C.skipped_existing, C.deleted, C.missing, C.withheld, C.refused, C.collision, C.in_the_way, C.time_not_kept, C.name_refused);
    int status = (C.missing || C.withheld || C.refused || C.collision || C.in_the_way || C.time_not_kept || C.name_refused) ? 1 : 0;
    snapshot_free(&snap); free(written.v); free(bad.v); del_table_free(&g_del); s3_free(g_s3); buf_free(&key);
    return status;
}
