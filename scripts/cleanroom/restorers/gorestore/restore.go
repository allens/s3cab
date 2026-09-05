package main

// Restore planning and execution: match rows to #DIR headers, re-root under the
// output directory, fetch each unique object once, write every destination, set
// mtimes through a nanosecond interface.

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

type dirHeader struct {
	Raw  string
	Segs []string
	Base string
}

// splitSegs splits a path on '/' and '\' and drops empty segments, which makes a
// trailing or doubled separator harmless and lets either OS's paths be read anywhere.
func splitSegs(p string) []string {
	return strings.FieldsFunc(p, func(r rune) bool { return r == '/' || r == '\\' })
}

func isDriveLetter(seg string) bool {
	return len(seg) == 2 && seg[1] == ':' &&
		(seg[0] >= 'A' && seg[0] <= 'Z' || seg[0] >= 'a' && seg[0] <= 'z')
}

// matchDir reports whether dir claims path. Whole segments, never a string prefix.
// Windows paths (leading drive-letter segment) compare case-insensitively; paths
// without a drive letter compare exactly.
func matchDir(pathSegs []string, dir dirHeader) bool {
	if len(pathSegs) <= len(dir.Segs) {
		return false
	}
	fold := len(pathSegs) > 0 && isDriveLetter(pathSegs[0])
	for i, ds := range dir.Segs {
		ps := pathSegs[i]
		if fold {
			if !strings.EqualFold(ds, ps) {
				return false
			}
		} else if ds != ps {
			return false
		}
	}
	return true
}

type target struct {
	Dest  string
	MTime time.Time
	Row   FileRow
}

type RestorePlan struct {
	ByHash map[string][]target // unique object -> destinations
	Sizes  map[string]int64    // size column per hash (advisory)
	Faults []string            // per-row planning faults
}

// PlanRestore maps every row to its destination under out.
func PlanRestore(snap *Snapshot, out string) (*RestorePlan, error) {
	if len(snap.Dirs) == 0 && len(snap.Rows) > 0 {
		return nil, fmt.Errorf("snapshot has file rows but no #DIR headers: nowhere to land")
	}
	dirs := make([]dirHeader, 0, len(snap.Dirs))
	baseSeen := map[string]string{}
	for _, d := range snap.Dirs {
		segs := splitSegs(d)
		if len(segs) == 0 {
			return nil, fmt.Errorf("#DIR %q has no path segments", d)
		}
		base := segs[len(segs)-1]
		if base == "." || base == ".." || isDriveLetter(base) {
			return nil, fmt.Errorf("#DIR %q has no usable basename", d)
		}
		if prev, ok := baseSeen[base]; ok && prev != d {
			return nil, fmt.Errorf("#DIR basename collision: %q and %q both want <out>/%s — refusing, as s3cab does", prev, d, base)
		}
		baseSeen[base] = d
		dirs = append(dirs, dirHeader{d, segs, base})
	}

	// A path appears at most once; a damaged file that repeats one gets last-wins,
	// as s3cab's own reader does, with a warning.
	lastByPath := map[string]int{}
	for i, r := range snap.Rows {
		if j, dup := lastByPath[r.Path]; dup {
			snap.Warnings = append(snap.Warnings,
				fmt.Sprintf("path %q appears on lines %d and %d: malformed snapshot, taking the last", r.Path, snap.Rows[j].Line, r.Line))
		}
		lastByPath[r.Path] = i
	}

	plan := &RestorePlan{ByHash: map[string][]target{}, Sizes: map[string]int64{}}
	for i, r := range snap.Rows {
		if lastByPath[r.Path] != i {
			continue // superseded duplicate
		}
		segs := splitSegs(r.Path)
		best := -1
		for di, d := range dirs {
			if matchDir(segs, d) {
				if best < 0 || len(d.Segs) > len(dirs[best].Segs) {
					best = di
				}
			}
		}
		if best < 0 {
			plan.Faults = append(plan.Faults,
				fmt.Sprintf("line %d: path %q is under no #DIR header: nowhere to land", r.Line, r.Path))
			continue
		}
		rest := segs[len(dirs[best].Segs):]
		bad := false
		for _, s := range rest {
			if s == "." || s == ".." {
				plan.Faults = append(plan.Faults,
					fmt.Sprintf("line %d: path %q contains a %q segment below its #DIR: refusing to re-root it", r.Line, r.Path, s))
				bad = true
				break
			}
		}
		if bad {
			continue
		}
		dest := filepath.Join(append([]string{out, dirs[best].Base}, rest...)...)
		if prev, ok := plan.Sizes[r.Hash]; ok && prev != r.Size {
			plan.Faults = append(plan.Faults,
				fmt.Sprintf("hash %s appears with sizes %d and %d: snapshot inconsistent", r.Hash, prev, r.Size))
		}
		plan.Sizes[r.Hash] = r.Size
		plan.ByHash[r.Hash] = append(plan.ByHash[r.Hash], target{dest, r.MTime, r})
	}
	return plan, nil
}

type RestoreResult struct {
	Restored int
	SkippedDeleted []string // explained by a deletion record — expected, not damage
	Faults         []string // integrity faults and errors — exit nonzero
}

// ExecuteRestore downloads every unique object once and writes all its targets.
// Deletion records are loaded lazily, only when a fetch actually misses.
func ExecuteRestore(c *S3Client, plan *RestorePlan, workers int, verbose bool) *RestoreResult {
	res := &RestoreResult{Faults: append([]string{}, plan.Faults...)}
	var mu sync.Mutex

	var delOnce sync.Once
	var del Deletions
	var delFiles []string
	var delErr error
	loadDel := func() (Deletions, error) {
		delOnce.Do(func() { del, delFiles, delErr = LoadDeletions(c) })
		_ = delFiles
		return del, delErr
	}

	hashes := make([]string, 0, len(plan.ByHash))
	for h := range plan.ByHash {
		hashes = append(hashes, h)
	}
	sort.Strings(hashes)

	sem := make(chan struct{}, workers)
	var wg sync.WaitGroup
	for _, h := range hashes {
		wg.Add(1)
		sem <- struct{}{}
		go func(hash string) {
			defer wg.Done()
			defer func() { <-sem }()
			targets := plan.ByHash[hash]
			faults, skipped, n := restoreOne(c, hash, plan.Sizes[hash], targets, loadDel)
			mu.Lock()
			res.Faults = append(res.Faults, faults...)
			res.SkippedDeleted = append(res.SkippedDeleted, skipped...)
			res.Restored += n
			mu.Unlock()
			if verbose {
				for _, t := range targets {
					fmt.Printf("  %s\n", t.Dest)
				}
			}
		}(h)
	}
	wg.Wait()
	sort.Strings(res.Faults)
	sort.Strings(res.SkippedDeleted)
	return res
}

func restoreOne(c *S3Client, hash string, size int64, targets []target,
	loadDel func() (Deletions, error)) (faults, skipped []string, restored int) {

	body, _, err := c.GetObjectStream("objects/" + hash)
	if err == ErrNotFound {
		del, derr := loadDel()
		if derr != nil {
			faults = append(faults, fmt.Sprintf("objects/%s missing and deletion records unreadable: %v", hash, derr))
			return
		}
		if entry, ok := del[hash]; ok {
			for _, t := range targets {
				skipped = append(skipped, fmt.Sprintf("%s (path %s): content deliberately deleted %s by %s",
					t.Dest, t.Row.Path, entry.When.UTC().Format("2006-01-02T15:04:05.000Z"), entry.Who))
			}
			return
		}
		for _, t := range targets {
			faults = append(faults, fmt.Sprintf("objects/%s missing and no deletion record explains it: integrity fault (wanted for %s)",
				hash, t.Row.Path))
		}
		return
	}
	if err != nil {
		faults = append(faults, fmt.Sprintf("objects/%s: %v", hash, err))
		return
	}
	defer body.Close()

	first := targets[0]
	if err := os.MkdirAll(filepath.Dir(first.Dest), 0o755); err != nil {
		faults = append(faults, fmt.Sprintf("%s: %v", first.Dest, err))
		return
	}
	f, err := os.Create(first.Dest)
	if err != nil {
		faults = append(faults, fmt.Sprintf("%s: %v", first.Dest, err))
		return
	}
	hasher := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, hasher), body)
	cerr := f.Close()
	if err != nil || cerr != nil {
		faults = append(faults, fmt.Sprintf("%s: write: %v/%v", first.Dest, err, cerr))
		return
	}
	got := hex.EncodeToString(hasher.Sum(nil))
	if got != hash {
		faults = append(faults, fmt.Sprintf("objects/%s: downloaded bytes hash to %s: object corrupt (still written to %s)", hash, got, first.Dest))
	}
	if n != size {
		faults = append(faults, fmt.Sprintf("objects/%s: stored %d bytes but snapshot says %d", hash, n, size))
	}

	for _, t := range targets[1:] {
		if err := os.MkdirAll(filepath.Dir(t.Dest), 0o755); err != nil {
			faults = append(faults, fmt.Sprintf("%s: %v", t.Dest, err))
			continue
		}
		if err := copyFile(first.Dest, t.Dest); err != nil {
			faults = append(faults, fmt.Sprintf("%s: %v", t.Dest, err))
			continue
		}
	}
	for _, t := range targets {
		// os.Chtimes goes through utimensat: nanosecond interface, so the stored
		// millisecond value is reproduced exactly. atime isn't stored; use mtime.
		if err := os.Chtimes(t.Dest, t.MTime, t.MTime); err != nil {
			faults = append(faults, fmt.Sprintf("%s: set mtime: %v", t.Dest, err))
			continue
		}
		restored++
	}
	return
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
