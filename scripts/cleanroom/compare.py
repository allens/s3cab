#!/usr/bin/env python3
"""Differential verifier: compare a restored tree against the reference tree.

Byte-level comparison of: the set of paths (as raw bytes), file contents, and
file mtimes to the millisecond. guide/format.md promises no finer, and the
reference is the imprecise side: s3cab sets times through fs.utimes float
seconds, which ext4 records tens of ns off (the resolved mtime-precision entry
in proposals/bugs.md), so an exact restorer differs from it below 1 ms forever.
Those are counted in the summary, not charged. Directory mtimes are reported
separately: both tools create directories implicitly at restore time, so their
mtimes reflect the run, not the format. Symlinks anywhere are reported (the
format stores none).

Exits 0 when the trees match, 1 when they differ (a path in mine it can't read
is a difference), and 2 when it fails itself, the reference unreadable included.
"""
import os, sys, hashlib, traceback

def fail(error: OSError):
    raise error  # else os.walk reads an unopenable folder as empty, and two pass as IDENTICAL

def walk(root: bytes):
    files, dirs, links = {}, set(), []
    # Keys cut the root off, not relpath: on Windows that strips a trailing space or dot.
    cut = len(root) + 1
    for dirpath, dirnames, filenames in os.walk(root, onerror=fail):
        rel = dirpath[cut:]
        if rel:
            dirs.add(rel)
        for d in dirnames:
            p = os.path.join(dirpath, d)
            if os.path.islink(p):
                links.append(p[cut:])
        for f in filenames:
            p = os.path.join(dirpath, f)
            if os.path.islink(p):
                links.append(p[cut:])
                continue
            st = os.lstat(p)
            h = hashlib.sha256()
            with open(p, 'rb') as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b''):
                    h.update(chunk)
            files[p[cut:]] = (st.st_size, st.st_mtime_ns, h.hexdigest())
    return files, dirs, links

def ms(ns: int) -> int:
    return (ns + 500_000) // 1_000_000

def show(b: bytes) -> str:
    return repr(b)[1:]  # repr keeps control chars visible

def root(path: str) -> bytes:
    # Not abspath: it drops a trailing dot or space too (guide/format.md).
    path = os.path.normpath(os.path.join(os.getcwd(), path))
    # Without \\?\ Windows strips a name's trailing spaces and dots, so lstat
    # can't find ' both ends.txt ' (edge) even though walk listed it.
    if os.name == 'nt' and not path.startswith('\\\\?\\'):
        if path.startswith('\\\\'):
            path = '\\\\?\\UNC\\' + path[2:]
        else:
            path = '\\\\?\\' + path
    return os.fsencode(path)

def main(mine: str, ref: str) -> int:
    tag = os.path.basename(ref.rstrip('/'))
    try:
        mf, md, ml = walk(root(mine))
    except OSError as error:
        print(f"== {tag}: unreadable in mine: {error}")
        return 1
    rf, rd, rl = walk(root(ref))
    problems = []
    below_ms = 0
    for p in sorted(rf.keys() - mf.keys()):
        problems.append(f"MISSING in mine: {show(p)}")
    for p in sorted(mf.keys() - rf.keys()):
        problems.append(f"EXTRA in mine:   {show(p)}")
    for p in sorted(mf.keys() & rf.keys()):
        (msz, mmt, mh), (rsz, rmt, rh) = mf[p], rf[p]
        if mh != rh or msz != rsz:
            problems.append(f"CONTENT differs: {show(p)} mine={msz}B/{mh[:12]} ref={rsz}B/{rh[:12]}")
        if ms(mmt) != ms(rmt):
            problems.append(f"MTIME differs:   {show(p)} mine={mmt} ref={rmt} (ns)")
        elif mmt != rmt:
            below_ms += 1
    for p in sorted(rd - md):
        problems.append(f"DIR missing in mine: {show(p)}")
    for p in sorted(md - rd):
        problems.append(f"DIR extra in mine:   {show(p)}")
    if ml or rl:
        problems.append(f"SYMLINKS present: mine={ml} ref={rl}")
    if problems:
        print(f"== {tag}: {len(problems)} difference(s); {below_ms} below 1 ms")
        for x in problems:
            print("   " + x)
        return 1
    print(f"== {tag}: IDENTICAL ({len(rf)} files, {len(rd)} dirs; {below_ms} below 1 ms)")
    return 0

if __name__ == '__main__':
    try:
        code = main(sys.argv[1], sys.argv[2])
    except Exception:
        traceback.print_exc()  # not left uncaught: Python exits 1 for that, which reads as a difference
        code = 2
    sys.exit(code)
