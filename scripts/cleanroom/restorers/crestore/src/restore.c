/* s3cab-restore: an independent restorer for the s3cab repository format.
 *
 *   s3cab-restore <bucket> <set> <dir> [<snapshot>]
 *
 * Restores the set's latest snapshot (or the one named) under <dir>, laid out as s3cab's own
 * restore to a chosen directory: <dir>/<name of the DIR that matched>/<rest of the path>.
 * Credentials and region come from the environment.  Exit 0 when everything restorable was
 * restored (deliberate deletions and files already present don't count against it), 1
 * otherwise, 2 for a usage error. */

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#include <openssl/evp.h>

#include "format.h"
#include "s3.h"

typedef struct {
    s3_t s3;
    const char *outpath;
    int outfd; /* -1 until the first file is about to land */
    bool verbose;
    sset_t ours; /* dev:ino of every file this run created */
    sset_t landed; /* destination paths this run wrote, for the report */
    bool dels_loaded;
    delset_t dels;
    /* tallies */
    size_t restored, skipped, deleted, refused, damaged, in_way, collided, unwritable, time_rounded, time_off;
    uint64_t bytes;
} run_t;

static run_t R;

static bool valid_set_name(const char *s)
{
    if (!*s) return false;
    for (; *s; s++)
        if (!((*s >= 'a' && *s <= 'z') || (*s >= '0' && *s <= '9') || *s == '-')) return false;
    return true;
}

/* YYYY-MM-DDTHHMM, digits where digits go. */
static bool valid_snap_name(const char *s, size_t n)
{
    static const char pat[] = "dddd-dd-ddTdddd";
    if (n != sizeof pat - 1) return false;
    for (size_t i = 0; i < n; i++) {
        if (pat[i] == 'd' ? !(s[i] >= '0' && s[i] <= '9') : s[i] != pat[i]) return false;
    }
    return true;
}

static void say_path(FILE *f, const char *prefix, str_t p, const char *suffix)
{
    fputs(prefix, f);
    put_escaped(f, p.p, p.n);
    fputs(suffix, f);
}

/* ---------------------------------------------------------------- download sink */

typedef struct {
    int fd;
    EVP_MD_CTX *md;
    uint64_t n;
} dl_t;

static int dl_reset(void *ctx)
{
    dl_t *d = ctx;
    if (ftruncate(d->fd, 0) || lseek(d->fd, 0, SEEK_SET) < 0) return -1;
    d->n = 0;
    return EVP_DigestInit_ex(d->md, EVP_sha256(), nullptr) == 1 ? 0 : -1;
}

static int dl_write(void *ctx, const unsigned char *p, size_t n)
{
    dl_t *d = ctx;
    EVP_DigestUpdate(d->md, p, n);
    d->n += n;
    while (n) {
        ssize_t w = write(d->fd, p, n);
        if (w < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        p += w;
        n -= (size_t)w;
    }
    return 0;
}

static int mem_reset(void *ctx)
{
    ((buf_t *)ctx)->len = 0;
    return 0;
}

static int mem_write(void *ctx, const unsigned char *p, size_t n)
{
    buf_add(ctx, p, n);
    return 0;
}

/* ---------------------------------------------------------------- deletion records */

static bool rec_key(const char *k)
{
    const char *pre = "objects.deleted-", *suf = ".tsv";
    size_t lp = strlen(pre), n = strlen(k);
    if (n <= lp + 4 || strncmp(k, pre, lp) != 0 || strcmp(k + n - 4, suf) != 0) return false;
    for (const char *p = k + lp; p < k + n - 4; p++)
        if (*p < '0' || *p > '9') return false;
    return true;
}

/* Read every objects.deleted-<n>.tsv as one set.  A record that vanishes between the listing
 * and its fetch was absorbed by a compaction, whose merged record is newer than the listing:
 * list again, once, so its rows aren't lost.  False means a failure that stops the restore. */
static bool load_deletions(void)
{
    if (R.dels_loaded) return true;
    R.dels_loaded = true;
    sset_t fetched = {0};
    size_t used = 0;
    for (int pass = 0; pass < 2; pass++) {
        char **keys = nullptr, err[512];
        size_t nkeys = 0;
        bool vanished = false;
        if (s3_list(&R.s3, "objects.deleted-", "/", &keys, &nkeys, err, sizeof err) != S3_OK) {
            fprintf(stderr, "s3cab-restore: listing deletion records failed: %s\n", err);
            return false;
        }
        for (size_t i = 0; i < nkeys; i++) {
            if (!rec_key(keys[i]) || !sset_add(&fetched, keys[i], strlen(keys[i]), 0, nullptr)) continue;
            buf_t body = {0};
            s3_sink_t sink = {mem_reset, mem_write, &body};
            int rc = s3_get(&R.s3, keys[i], &sink, err, sizeof err);
            if (rc == S3_NOT_FOUND) {
                vanished = true;
            } else if (rc != S3_OK) {
                fprintf(stderr, "s3cab-restore: fetching deletion record %s failed: %s\n", keys[i], err);
                buf_free(&body);
                return false;
            } else if (!rec_parse(&body, keys[i], &R.dels, err, sizeof err)) {
                fprintf(stderr, "s3cab-restore: warning: deletion record %s refused (%s); none of its rows count\n",
                        keys[i], err);
            } else {
                used++;
            }
            buf_free(&body);
        }
        for (size_t i = 0; i < nkeys; i++) free(keys[i]);
        free(keys);
        if (!vanished) break;
        if (pass == 1)
            fprintf(stderr, "s3cab-restore: warning: deletion records keep vanishing while being read (compaction running?)\n");
    }
    sset_free(&fetched);
    if (R.verbose)
        fprintf(stderr, "s3cab-restore: read %zu deletion record(s): %zu deleted hash(es)\n", used, R.dels.n);
    return true;
}

/* ---------------------------------------------------------------- destination */

static bool ensure_output(void)
{
    if (R.outfd >= 0) return true;
    /* mkdir -p: the output directory is the caller's choice, so its own path may hold links */
    char *p = xstrdup(R.outpath);
    for (char *s = p + 1; *s; s++) {
        if (*s != '/') continue;
        *s = 0;
        if (mkdir(p, 0777) && errno != EEXIST) break;
        *s = '/';
    }
    if (mkdir(p, 0777) && errno != EEXIST) {
        fprintf(stderr, "s3cab-restore: cannot create %s: %s\n", R.outpath, strerror(errno));
        free(p);
        return false;
    }
    free(p);
    R.outfd = open(R.outpath, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (R.outfd < 0) {
        fprintf(stderr, "s3cab-restore: cannot open %s: %s\n", R.outpath, strerror(errno));
        return false;
    }
    return true;
}

static void devino_key(const struct stat *st, char out[64]) { snprintf(out, 64, "%ju:%ju", (uintmax_t)st->st_dev, (uintmax_t)st->st_ino); }

typedef struct {
    str_t *seg;
    size_t n;
    buf_t shown; /* <dir>/a/b, for messages */
} dest_t;

enum probe { P_ABSENT, P_EXISTS_FILE, P_OURS, P_IN_WAY, P_ERROR };

/* Walk the destination's folders without following links.  *dfd_out receives the deepest
 * existing folder; *depth_out how many of the folders exist. */
static enum probe probe_dest(const dest_t *d, int *dfd_out, size_t *depth_out, char *why, size_t whylen)
{
    int dfd = dup(R.outfd);
    size_t k = 0;
    for (; k + 1 < d->n; k++) {
        char *name = str_dup(d->seg[k]);
        int fd = openat(dfd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        int e = errno;
        free(name);
        if (fd >= 0) {
            close(dfd);
            dfd = fd;
            continue;
        }
        if (e == ENOENT) break;
        if (e == ENOTDIR || e == ELOOP) {
            snprintf(why, whylen, "something that isn't a folder is where folder '%.*s' should be", (int)d->seg[k].n,
                     (const char *)d->seg[k].p);
            close(dfd);
            return P_IN_WAY;
        }
        snprintf(why, whylen, "cannot open folder '%.*s': %s", (int)d->seg[k].n, (const char *)d->seg[k].p, strerror(e));
        close(dfd);
        return P_ERROR;
    }
    *dfd_out = dfd;
    *depth_out = k;
    if (k + 1 < d->n) return P_ABSENT; /* a folder is missing, so the file is too */
    char *name = str_dup(d->seg[d->n - 1]);
    struct stat st;
    int rc = fstatat(dfd, name, &st, AT_SYMLINK_NOFOLLOW);
    int e = errno;
    free(name);
    if (rc != 0) {
        if (e == ENOENT) return P_ABSENT;
        snprintf(why, whylen, "cannot check the destination: %s", strerror(e));
        return P_ERROR;
    }
    if (S_ISREG(st.st_mode)) {
        char key[64];
        devino_key(&st, key);
        return sset_has(&R.ours, key, strlen(key), nullptr) ? P_OURS : P_EXISTS_FILE;
    }
    snprintf(why, whylen, "%s is where the file should land", S_ISDIR(st.st_mode) ? "a folder" : S_ISLNK(st.st_mode) ? "a link" : "something that isn't a file");
    return P_IN_WAY;
}

/* Create the missing folders below dfd (which holds `depth` of them already). */
static int make_folders(const dest_t *d, int dfd, size_t depth, char *why, size_t whylen)
{
    for (size_t k = depth; k + 1 < d->n; k++) {
        char *name = str_dup(d->seg[k]);
        if (mkdirat(dfd, name, 0777) && errno != EEXIST) {
            snprintf(why, whylen, "cannot create folder '%s': %s", name, strerror(errno));
            free(name);
            close(dfd);
            return -1;
        }
        int fd = openat(dfd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        int e = errno;
        free(name);
        close(dfd);
        if (fd < 0) {
            snprintf(why, whylen, "folder '%.*s' is in the way: %s", (int)d->seg[k].n, (const char *)d->seg[k].p, strerror(e));
            return -1;
        }
        dfd = fd;
    }
    return dfd;
}

static int64_t floordiv(int64_t a, int64_t b) { return a / b - ((a % b != 0) && ((a < 0) != (b < 0))); }

/* ---------------------------------------------------------------- one file */

static int open_temp(char *named, size_t namedlen)
{
    named[0] = 0;
    int fd = openat(R.outfd, ".", O_TMPFILE | O_RDWR | O_CLOEXEC, 0666);
    if (fd >= 0) return fd;
    static unsigned counter;
    snprintf(named, namedlen, ".s3cab-restore-%ld-%u.part", (long)getpid(), counter++);
    return openat(R.outfd, named, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0666);
}

static void drop_temp(int fd, const char *named)
{
    close(fd);
    if (named[0]) unlinkat(R.outfd, named, 0);
}

/* Link the verified temp file in as dfd/name; copy when it can't be linked across a mount. */
static int place(int tfd, const char *named, int dfd, const char *name)
{
    int rc;
    if (named[0]) {
        rc = linkat(R.outfd, named, dfd, name, 0);
    } else {
        char proc[64];
        snprintf(proc, sizeof proc, "/proc/self/fd/%d", tfd);
        rc = linkat(AT_FDCWD, proc, dfd, name, AT_SYMLINK_FOLLOW);
    }
    if (rc == 0 || errno != EXDEV) return rc;
    int ofd = openat(dfd, name, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0666);
    if (ofd < 0) return -1;
    char buf[1 << 16];
    ssize_t n;
    lseek(tfd, 0, SEEK_SET);
    while ((n = read(tfd, buf, sizeof buf)) > 0)
        if (write(ofd, buf, (size_t)n) != n) {
            close(ofd);
            return -1;
        }
    struct stat st;
    fstat(tfd, &st);
    struct timespec ts[2] = {{.tv_nsec = UTIME_OMIT}, st.st_mtim};
    futimens(ofd, ts);
    close(ofd);
    return 0;
}

/* Returns false only for a failure that stops the whole restore. */
static bool restore_one(const snap_t *s, const frow_t *r, const dest_t *d)
{
    char why[400];
    int dfd = -1;
    size_t depth = 0;
    for (size_t k = 0; k < d->n; k++) {
        if (memchr(d->seg[k].p, 0, d->seg[k].n)) {
            say_path(stderr, "FAILED: ", d->shown.len ? (str_t){d->shown.p, d->shown.len} : r->raw,
                     ": a name holds NUL, which no Linux name can\n");
            R.unwritable++;
            return true;
        }
    }
    enum probe p = probe_dest(d, &dfd, &depth, why, sizeof why);
    str_t shown = {d->shown.p, d->shown.len};
    if (p == P_EXISTS_FILE) {
        say_path(stdout, "skipped: ", shown, " (already at the destination; left alone)\n");
        R.skipped++;
        close(dfd);
        return true;
    }
    if (p == P_OURS) {
        say_path(stderr, "FAILED: ", shown, "");
        fprintf(stderr, " (line %zu): another row of this snapshot already restored to the same file\n", r->line);
        R.collided++;
        close(dfd);
        return true;
    }
    if (p == P_IN_WAY || p == P_ERROR) {
        say_path(stderr, "FAILED: ", shown, ": ");
        fprintf(stderr, "%s\n", why);
        if (p == P_IN_WAY) R.in_way++; else R.unwritable++;
        if (dfd >= 0) close(dfd);
        return true;
    }

    /* Download to an unnamed file beside the output, verify, and only then make it visible. */
    char named[128];
    int tfd = open_temp(named, sizeof named);
    if (tfd < 0) {
        fprintf(stderr, "s3cab-restore: cannot create a temporary file in %s: %s\n", R.outpath, strerror(errno));
        close(dfd);
        return false;
    }
    dl_t dl = {.fd = tfd, .md = EVP_MD_CTX_new()};
    s3_sink_t sink = {dl_reset, dl_write, &dl};
    char key[80], err[512];
    snprintf(key, sizeof key, "objects/%s", r->hash);
    int rc = s3_get(&R.s3, key, &sink, err, sizeof err);
    unsigned char md[32];
    unsigned int mdlen = 0;
    EVP_DigestFinal_ex(dl.md, md, &mdlen);
    EVP_MD_CTX_free(dl.md);
    if (rc == S3_NOT_FOUND) {
        drop_temp(tfd, named);
        close(dfd);
        if (!load_deletions()) return false;
        const delrow_t *del = del_lookup(&R.dels, r->hash);
        if (del) {
            say_path(stdout, "deleted: ", r->raw, "");
            printf(" (deliberately deleted %s by %s; not restored)\n", del->when, del->who);
            R.deleted++;
        } else {
            say_path(stderr, "DAMAGE: ", r->raw, "");
            fprintf(stderr, " (line %zu): objects/%s is missing and no deletion record lists it\n", r->line, r->hash);
            R.damaged++;
        }
        return true;
    }
    if (rc != S3_OK) {
        fprintf(stderr, "s3cab-restore: fetching %s failed: %s; stopping the restore\n", key, err);
        drop_temp(tfd, named);
        close(dfd);
        return false;
    }
    char got[65];
    hex_encode(md, 32, got);
    if (strcmp(got, r->hash) != 0) {
        say_path(stderr, "DAMAGE: ", r->raw, "");
        fprintf(stderr, " (line %zu): objects/%s downloaded with SHA-256 %s; withheld\n", r->line, r->hash, got);
        R.damaged++;
        drop_temp(tfd, named);
        close(dfd);
        return true;
    }

    struct timespec ts[2] = {{.tv_nsec = UTIME_OMIT}, {.tv_sec = (time_t)r->sec, .tv_nsec = (long)r->ms * 1000000L}};
    bool time_set = futimens(tfd, ts) == 0;
    int time_errno = errno;

    dfd = make_folders(d, dfd, depth, why, sizeof why);
    if (dfd < 0) {
        say_path(stderr, "FAILED: ", shown, ": ");
        fprintf(stderr, "%s\n", why);
        R.in_way++;
        drop_temp(tfd, named);
        return true;
    }
    char *name = str_dup(d->seg[d->n - 1]);
    if (place(tfd, named, dfd, name) != 0) {
        int e = errno;
        if (e == EEXIST) {
            struct stat st;
            bool ours = false;
            if (fstatat(dfd, name, &st, AT_SYMLINK_NOFOLLOW) == 0) {
                char k[64];
                devino_key(&st, k);
                ours = sset_has(&R.ours, k, strlen(k), nullptr);
            }
            if (ours) {
                say_path(stderr, "FAILED: ", shown, "");
                fprintf(stderr, " (line %zu): another row of this snapshot already restored to the same file\n", r->line);
                R.collided++;
            } else {
                say_path(stdout, "skipped: ", shown, " (already at the destination; left alone)\n");
                R.skipped++;
            }
        } else {
            say_path(stderr, "FAILED: ", shown, ": ");
            fprintf(stderr, "cannot create it: %s\n", strerror(e));
            R.unwritable++;
        }
        free(name);
        close(dfd);
        drop_temp(tfd, named);
        return true;
    }

    struct stat st;
    if (fstatat(dfd, name, &st, AT_SYMLINK_NOFOLLOW) == 0) {
        char k[64];
        devino_key(&st, k);
        sset_add(&R.ours, k, strlen(k), 0, nullptr);
    }
    free(name);
    close(dfd);
    drop_temp(tfd, named);
    R.restored++;
    R.bytes += dl.n;
    if (R.verbose) say_path(stdout, "restored: ", shown, "\n");

    /* Read the time back: rounding is reported in the total, a time not kept per file. */
    int64_t want = r->sec * 1000 + r->ms;
    int64_t have = (int64_t)st.st_mtim.tv_sec * 1000 + floordiv((int64_t)st.st_mtim.tv_nsec + 500000, 1000000);
    if (!time_set || have != want) {
        int64_t off = have > want ? have - want : want - have;
        if (time_set && off < 2000) {
            R.time_rounded++;
        } else {
            say_path(stderr, "FAILED: ", shown, "");
            if (!time_set)
                fprintf(stderr, ": modification time not set: %s (file kept)\n", strerror(time_errno));
            else
                fprintf(stderr, ": modification time not kept: wanted %lld ms, got %lld ms (file kept)\n", (long long)want,
                        (long long)have);
            R.time_off++;
        }
    }
    (void)s;
    return true;
}

/* ---------------------------------------------------------------- main */

static void usage(void)
{
    fprintf(stderr, "usage: s3cab-restore <bucket> <set> <dir> [<snapshot>]\n");
    exit(2);
}

int main(int argc, char **argv)
{
    signal(SIGPIPE, SIG_IGN);
    setvbuf(stdout, nullptr, _IOLBF, 0); /* keep stdout and stderr in order in a log */
    if (argc < 4 || argc > 5) usage();
    const char *bucket = argv[1], *set = argv[2];
    R.outpath = argv[3];
    R.outfd = -1;
    R.verbose = getenv("S3CAB_RESTORE_VERBOSE") && *getenv("S3CAB_RESTORE_VERBOSE");
    if (!valid_set_name(set)) {
        fprintf(stderr, "s3cab-restore: a set's name is lowercase letters, digits and hyphens: %s\n", set);
        return 2;
    }
    if (!*R.outpath) usage();
    if (strlen(bucket) > 63 || strpbrk(bucket, "/?#") || !*bucket) {
        fprintf(stderr, "s3cab-restore: not a bucket name: %s\n", bucket);
        return 2;
    }
    s3_init(&R.s3, bucket);
    char err[1024];

    /* Which snapshot. */
    char *snapname = nullptr;
    if (argc == 5) {
        size_t n = strlen(argv[4]);
        if (n > 7 && strcmp(argv[4] + n - 7, ".tsv.gz") == 0) n -= 7;
        if (!valid_snap_name(argv[4], n)) {
            fprintf(stderr, "s3cab-restore: a snapshot's name is YYYY-MM-DDTHHMM: %s\n", argv[4]);
            return 2;
        }
        snapname = str_dup((str_t){(const unsigned char *)argv[4], n});
    } else {
        buf_t prefix = {0};
        buf_addf(&prefix, "snapshots/%s/", set);
        char **keys = nullptr;
        size_t nkeys = 0;
        if (s3_list(&R.s3, (char *)prefix.p, "/", &keys, &nkeys, err, sizeof err) != S3_OK) {
            fprintf(stderr, "s3cab-restore: listing %s failed: %s\n", (char *)prefix.p, err);
            return 1;
        }
        for (size_t i = 0; i < nkeys; i++) {
            const char *nm = keys[i] + prefix.len;
            size_t n = strlen(nm);
            if (strncmp(keys[i], (char *)prefix.p, prefix.len) != 0 || n < 7 || strcmp(nm + n - 7, ".tsv.gz") != 0 ||
                !valid_snap_name(nm, n - 7))
                continue; /* not named YYYY-MM-DDTHHMM.tsv.gz */
            if (!snapname || strncmp(nm, snapname, n - 7) > 0) {
                free(snapname);
                snapname = str_dup((str_t){(const unsigned char *)nm, n - 7});
            }
        }
        for (size_t i = 0; i < nkeys; i++) free(keys[i]);
        free(keys);
        if (!snapname) {
            fprintf(stderr, "s3cab-restore: set %s has no snapshots in s3://%s\n", set, bucket);
            return 1;
        }
        buf_free(&prefix);
    }
    buf_t key = {0};
    buf_addf(&key, "snapshots/%s/%s.tsv.gz", set, snapname);
    printf("snapshot: s3://%s/%s\n", bucket, (char *)key.p);

    /* Fetch, decompress, parse. */
    buf_t gz = {0};
    s3_sink_t sink = {mem_reset, mem_write, &gz};
    int rc = s3_get(&R.s3, (char *)key.p, &sink, err, sizeof err);
    if (rc == S3_NOT_FOUND) {
        fprintf(stderr, "s3cab-restore: no such snapshot: s3://%s/%s\n", bucket, (char *)key.p);
        return 1;
    }
    if (rc != S3_OK) {
        fprintf(stderr, "s3cab-restore: fetching the snapshot failed: %s\n", err);
        return 1;
    }
    snap_t s = {0};
    if (!gunzip_all(gz.p, gz.len, &s.text, err, sizeof err)) {
        fprintf(stderr, "s3cab-restore: snapshot refused: %s; nothing restored\n", err);
        return 1;
    }
    buf_free(&gz);
    if (!snap_parse(&s, err, sizeof err)) {
        fprintf(stderr, "s3cab-restore: snapshot refused: %s; nothing restored\n", err);
        return 1;
    }
    if (s.spec.n) printf("spec: %.*s\n", (int)s.spec.n, (const char *)s.spec.p);
    snap_check(&s);
    if (s.set_name.n && !str_eqz(s.set_name, set)) {
        say_path(stderr, "s3cab-restore: warning: @SET NAME is '", s.set_name, "'");
        fprintf(stderr, ", not the set it was found under (%s)\n", set);
    }
    if (s.snap_name.n && !str_eqz(s.snap_name, snapname)) {
        say_path(stderr, "s3cab-restore: warning: @SNAPSHOT NAME is '", s.snap_name, "'");
        fprintf(stderr, ", not its key's name (%s)\n", snapname);
    }

    /* Report refused rows. */
    for (size_t i = 0; i < s.nrows; i++) {
        frow_t *r = &s.rows[i];
        if (r->ok) continue;
        R.refused++;
        fprintf(stderr, "REFUSED: line %zu: ", r->line);
        if (r->raw.n) {
            put_escaped(stderr, r->raw.p, r->raw.n);
            fputs(": ", stderr);
        }
        fprintf(stderr, "%s\n", r->why);
    }

    /* s3cab's own layout refuses some restores outright. */
    buf_t why = {0};
    if (!snap_layout_ok(&s, &why)) {
        fputs((char *)why.p, stderr);
        fprintf(stderr, "s3cab-restore: restore refused; nothing written\n");
        return 1;
    }
    buf_free(&why);

    /* Restore, in row order. */
    bool stopped = false;
    for (size_t i = 0; i < s.nrows && !stopped; i++) {
        frow_t *r = &s.rows[i];
        if (!r->ok) continue;
        dir_t *dir = &s.dirs[r->dir];
        dest_t d = {0};
        d.seg = xmalloc((r->path.nseg + 1) * sizeof *d.seg);
        if (dir->has_folder) d.seg[d.n++] = dir->name;
        for (size_t k = dir->path.nseg; k < r->path.nseg; k++) d.seg[d.n++] = r->path.seg[k];
        buf_adds(&d.shown, R.outpath);
        for (size_t k = 0; k < d.n; k++) {
            buf_adds(&d.shown, "/");
            buf_add(&d.shown, d.seg[k].p, d.seg[k].n);
        }
        if (!ensure_output()) {
            stopped = true;
        } else if (!restore_one(&s, r, &d)) {
            stopped = true;
        }
        free(d.seg);
        buf_free(&d.shown);
    }

    size_t failures = R.refused + R.damaged + R.in_way + R.collided + R.unwritable + R.time_off;
    printf("restored %zu file(s), %ju byte(s), to %s\n", R.restored, (uintmax_t)R.bytes, R.outpath);
    if (R.skipped) printf("skipped %zu file(s) already at the destination\n", R.skipped);
    if (R.deleted) printf("%zu file(s) deliberately deleted, not restored\n", R.deleted);
    if (R.time_rounded) printf("%zu file(s) had their modification time rounded by the filesystem\n", R.time_rounded);
    if (failures || stopped) {
        printf("NOT A FULL RESTORE:");
        if (R.refused) printf(" %zu row(s) refused;", R.refused);
        if (R.damaged) printf(" %zu damaged;", R.damaged);
        if (R.in_way) printf(" %zu blocked by something in the way;", R.in_way);
        if (R.collided) printf(" %zu landing on another row's file;", R.collided);
        if (R.unwritable) printf(" %zu could not be written;", R.unwritable);
        if (R.time_off) printf(" %zu with a modification time not kept;", R.time_off);
        if (stopped) printf(" stopped early;");
        printf("\n");
    }
    if (R.verbose) fprintf(stderr, "s3cab-restore: %lu signed request(s)\n", R.s3.requests);
    snap_free(&s);
    s3_free(&R.s3);
    free(snapname);
    buf_free(&key);
    return failures || stopped ? 1 : 0;
}
