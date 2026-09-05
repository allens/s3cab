#!/usr/bin/env python3
"""Differential comparison: reference/<snap> vs restored/<snap>.

Compares relative path sets, byte contents, and mtimes. mtimes are compared at
millisecond resolution as the spec instructs ("compare at that resolution, not
finer"), but any nonzero raw nanosecond difference is shown so the sub-ms
float-path signature the spec describes is visible.
"""
import os, sys, filecmp

ref_root, got_root = sys.argv[1], sys.argv[2]

def tree(root):
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        for f in filenames:
            p = os.path.join(dirpath, f)
            rel = os.path.relpath(p, root)
            st = os.lstat(p)
            out[rel] = (st.st_size, st.st_mtime_ns)
    return out

names = sorted(set(os.listdir(ref_root)) | set(os.listdir(got_root)))
grand = 0
for name in names:
    ref_dir, got_dir = os.path.join(ref_root, name), os.path.join(got_root, name)
    print(f"== {name}")
    if not os.path.isdir(ref_dir):
        print(f"  ONLY IN RESTORED (no reference dir)")
        grand += 1
        continue
    if not os.path.isdir(got_dir):
        print(f"  MISSING FROM RESTORED (reference dir exists, "
              f"{sum(len(fs) for _,_,fs in os.walk(ref_dir))} files)")
        grand += 1
        continue
    ref, got = tree(ref_dir), tree(got_dir)
    diffs = 0
    for rel in sorted(set(ref) | set(got)):
        if rel not in got:
            print(f"  only in reference: {rel}"); diffs += 1; continue
        if rel not in ref:
            print(f"  only in restored:  {rel}"); diffs += 1; continue
        rsz, rmt = ref[rel]; gsz, gmt = got[rel]
        if rsz != gsz or not filecmp.cmp(os.path.join(ref_dir, rel),
                                         os.path.join(got_dir, rel), shallow=False):
            print(f"  BYTES DIFFER: {rel} (ref {rsz}B, got {gsz}B)"); diffs += 1
        dt = gmt - rmt
        if abs(dt) > 500_000:  # > 0.5 ms: a real mtime mismatch
            print(f"  MTIME DIFFERS: {rel}: ref {rmt} got {gmt} ({dt} ns)"); diffs += 1
        elif dt != 0:
            print(f"  (sub-ms mtime skew, spec-permitted: {rel}: {dt:+d} ns)")
    n = len(set(ref) | set(got))
    print(f"  {n} paths compared, {diffs} differences")
    grand += diffs
print(f"TOTAL differences: {grand}")
sys.exit(1 if grand else 0)
