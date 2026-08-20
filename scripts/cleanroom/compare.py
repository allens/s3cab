#!/usr/bin/env python3
"""Differential verifier: compare a restored tree against the reference tree.

Byte-level comparison of: the set of paths (as raw bytes), file contents, and
file mtimes (st_mtime_ns). Directory mtimes are reported separately: both tools
create directories implicitly at restore time, so their mtimes reflect the run,
not the format. Symlinks anywhere are reported (the format stores none).
"""
import os, sys, hashlib

def walk(root: bytes):
    files, dirs, links = {}, set(), []
    for dirpath, dirnames, filenames in os.walk(root):
        rel = os.path.relpath(dirpath, root)
        if rel != b'.':
            dirs.add(rel)
        for d in dirnames:
            p = os.path.join(dirpath, d)
            if os.path.islink(p):
                links.append(os.path.relpath(p, root))
        for f in filenames:
            p = os.path.join(dirpath, f)
            if os.path.islink(p):
                links.append(os.path.relpath(p, root))
                continue
            st = os.lstat(p)
            h = hashlib.sha256()
            with open(p, 'rb') as fh:
                for chunk in iter(lambda: fh.read(1 << 20), b''):
                    h.update(chunk)
            files[os.path.relpath(p, root)] = (st.st_size, st.st_mtime_ns, h.hexdigest())
    return files, dirs, links

def show(b: bytes) -> str:
    return repr(b)[1:]  # repr keeps control chars visible

def main(mine: str, ref: str) -> int:
    mf, md, ml = walk(os.fsencode(mine))
    rf, rd, rl = walk(os.fsencode(ref))
    problems = []
    for p in sorted(rf.keys() - mf.keys()):
        problems.append(f"MISSING in mine: {show(p)}")
    for p in sorted(mf.keys() - rf.keys()):
        problems.append(f"EXTRA in mine:   {show(p)}")
    for p in sorted(mf.keys() & rf.keys()):
        (msz, mmt, mh), (rsz, rmt, rh) = mf[p], rf[p]
        if mh != rh or msz != rsz:
            problems.append(f"CONTENT differs: {show(p)} mine={msz}B/{mh[:12]} ref={rsz}B/{rh[:12]}")
        if mmt != rmt:
            problems.append(f"MTIME differs:   {show(p)} mine={mmt} ref={rmt} (ns)")
    for p in sorted(rd - md):
        problems.append(f"DIR missing in mine: {show(p)}")
    for p in sorted(md - rd):
        problems.append(f"DIR extra in mine:   {show(p)}")
    if ml or rl:
        problems.append(f"SYMLINKS present: mine={ml} ref={rl}")
    tag = os.path.basename(ref.rstrip('/'))
    if problems:
        print(f"== {tag}: {len(problems)} difference(s)")
        for x in problems:
            print("   " + x)
        return 1
    print(f"== {tag}: IDENTICAL ({len(rf)} files, {len(rd)} dirs)")
    return 0

if __name__ == '__main__':
    sys.exit(main(sys.argv[1], sys.argv[2]))
