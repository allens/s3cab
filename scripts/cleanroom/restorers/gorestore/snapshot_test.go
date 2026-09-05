package main

// Synthetic parser/planner tests for the format corners the integration bucket
// does not stage: Windows paths, case-insensitive #DIR matching, collisions,
// traversal, and malformed files. The bucket's snapshots are all POSIX-path,
// well-formed-or-deliberately-truncated; everything here is spec-derived.

import (
	"strings"
	"testing"
)

const pad64 = "                                                       " // 55 spaces after #SNAPSHOT

func header(set string) string {
	return "#SNAPSHOT" + pad64 + "\t" + set + "\t2026-06-12T08:15:32.123Z\t2026-06-12T0915 Europe/London\n"
}

func dirLine(d string) string  { return "#DIR\t\t\t" + d + "\n" }
func trailer() string          { return "#END\tCOMPLETE\t2026-06-12T08:15:33.000Z\t\n" }
func row(hash, size, mtime, path string) string {
	return hash + "\t" + size + "\t" + mtime + "\t" + path + "\n"
}

const h1 = "3b8e000000000000000000000000000000000000000000000000000000000000"
const h2 = "5e21000000000000000000000000000000000000000000000000000000000000"
const t1 = "2026-06-01T12:00:00.000Z"

func mustParse(t *testing.T, s string) *Snapshot {
	t.Helper()
	snap, err := ParseSnapshot([]byte(s))
	if err != nil {
		t.Fatalf("ParseSnapshot: %v", err)
	}
	return snap
}

func planOf(t *testing.T, snap *Snapshot) *RestorePlan {
	t.Helper()
	plan, err := PlanRestore(snap, "/out")
	if err != nil {
		t.Fatalf("PlanRestore: %v", err)
	}
	return plan
}

func soleDest(t *testing.T, plan *RestorePlan, hash string) string {
	t.Helper()
	ts := plan.ByHash[hash]
	if len(ts) != 1 {
		t.Fatalf("want 1 target for %s, got %d (faults: %v)", hash, len(ts), plan.Faults)
	}
	return ts[0].Dest
}

func TestWindowsPathsMatchCaseInsensitively(t *testing.T) {
	s := header("photos") +
		dirLine(`C:\Users\me\Photos`) +
		row(h1, "10", t1, `c:\users\ME\photos\2024\beach.jpg`) +
		trailer()
	plan := planOf(t, mustParse(t, s))
	if got := soleDest(t, plan, h1); got != "/out/Photos/2024/beach.jpg" {
		t.Fatalf("dest = %q", got)
	}
}

func TestPosixPathsMatchExactly(t *testing.T) {
	s := header("x") +
		dirLine("/data/Photos") +
		row(h1, "10", t1, "/data/photos/a.jpg") + // different directory on POSIX
		trailer()
	plan := planOf(t, mustParse(t, s))
	if len(plan.Faults) != 1 || !strings.Contains(plan.Faults[0], "no #DIR") {
		t.Fatalf("want nowhere-to-land fault, got %v", plan.Faults)
	}
}

func TestSegmentsNeverStringPrefix(t *testing.T) {
	s := header("x") +
		dirLine(`/trees/edge`) +
		row(h1, "10", t1, `/trees/edgeX/file.txt`) +
		trailer()
	plan := planOf(t, mustParse(t, s))
	if len(plan.Faults) != 1 {
		t.Fatalf("edgeX must not match edge: %v", plan.Faults)
	}
}

func TestLongestDirWins(t *testing.T) {
	s := header("x") +
		dirLine("/a/outer") +
		dirLine("/a/outer/inner") +
		row(h1, "10", t1, "/a/outer/inner/f.txt") +
		trailer()
	plan := planOf(t, mustParse(t, s))
	if got := soleDest(t, plan, h1); got != "/out/inner/f.txt" {
		t.Fatalf("dest = %q, want the nested member dir to claim it", got)
	}
}

func TestTrailingAndDoubledSeparatorsHarmless(t *testing.T) {
	s := header("x") +
		dirLine("/a//outer/") +
		row(h1, "10", t1, "/a/outer/f.txt") +
		trailer()
	plan := planOf(t, mustParse(t, s))
	if got := soleDest(t, plan, h1); got != "/out/outer/f.txt" {
		t.Fatalf("dest = %q", got)
	}
}

func TestBasenameCollisionRefused(t *testing.T) {
	s := header("x") +
		dirLine(`C:\a\Photos`) +
		dirLine(`D:\b\Photos`) +
		trailer()
	if _, err := PlanRestore(mustParse(t, s), "/out"); err == nil {
		t.Fatal("colliding #DIR basenames must refuse the snapshot")
	}
}

func TestDriveRootDirRefused(t *testing.T) {
	s := header("x") + dirLine(`C:\`) + trailer()
	if _, err := PlanRestore(mustParse(t, s), "/out"); err == nil {
		t.Fatal(`#DIR C:\ has no basename and must be refused`)
	}
}

func TestTraversalBelowDirRefused(t *testing.T) {
	s := header("x") +
		dirLine("/a/outer") +
		row(h1, "10", t1, "/a/outer/../../etc/passwd") +
		trailer()
	plan := planOf(t, mustParse(t, s))
	if len(plan.ByHash) != 0 || len(plan.Faults) != 1 {
		t.Fatalf("dot-dot below #DIR must fault, got %v", plan.Faults)
	}
}

func TestDuplicatePathLastWins(t *testing.T) {
	s := header("x") +
		dirLine("/d") +
		row(h1, "10", t1, "/d/f.txt") +
		row(h2, "20", t1, "/d/f.txt") +
		trailer()
	snap := mustParse(t, s)
	plan := planOf(t, snap)
	if _, ok := plan.ByHash[h1]; ok {
		t.Fatal("first duplicate row must be superseded")
	}
	if len(plan.ByHash[h2]) != 1 {
		t.Fatal("last duplicate row must win")
	}
	found := false
	for _, w := range snap.Warnings {
		found = found || strings.Contains(w, "appears on lines")
	}
	if !found {
		t.Fatal("duplicate path must be warned about")
	}
}

func TestPathsTakenVerbatim(t *testing.T) {
	// leading/trailing spaces, NEL, VT, FF all legal in a path and never trimmed
	odd := "/d/ \u0085\v\f notes.txt "
	s := header("x") + dirLine("/d") + row(h1, "10", t1, odd) + trailer()
	snap := mustParse(t, s)
	if snap.Rows[0].Path != odd {
		t.Fatalf("path %q mangled to %q", odd, snap.Rows[0].Path)
	}
}

func TestBareEndAndExtraColumnsAreTrailers(t *testing.T) {
	for _, tr := range []string{"#END\n", "#END\t2026-06-12\n", "#END\tCOMPLETE\tx\ty\tz\n"} {
		if _, err := ParseSnapshot([]byte(header("x") + dirLine("/d") + tr)); err != nil {
			t.Fatalf("trailer %q rejected: %v", tr, err)
		}
	}
}

func TestEndXIsNotATrailer(t *testing.T) {
	if _, err := ParseSnapshot([]byte(header("x") + "#ENDX\n")); err == nil {
		t.Fatal("#ENDX must not close a snapshot")
	}
}

func TestMissingTrailerMeansTruncated(t *testing.T) {
	s := header("x") + dirLine("/d") + row(h1, "10", t1, "/d/f.txt")
	if _, err := ParseSnapshot([]byte(s)); err == nil {
		t.Fatal("no trailer must read as truncated")
	}
}

func TestMissingFinalLFMeansTruncated(t *testing.T) {
	s := header("x") + dirLine("/d") + "#END\tCOMPLETE\tt\t" // no \n
	if _, err := ParseSnapshot([]byte(s)); err == nil {
		t.Fatal("no final LF must read as truncated")
	}
}

func TestBOMAndBadUTF8Refused(t *testing.T) {
	if _, err := ParseSnapshot([]byte("\xef\xbb\xbf" + header("x") + trailer())); err == nil {
		t.Fatal("BOM must be refused")
	}
	if _, err := ParseSnapshot([]byte(header("x") + "#DIR\t\t\t/d\xff\n" + trailer())); err == nil {
		t.Fatal("invalid UTF-8 must be refused")
	}
}

func TestOversizeColumnOverflows(t *testing.T) {
	s := header("x") + dirLine("/d") +
		row(h1, "12345678901234", t1, "/d/huge.bin") + // 14 digits: wider than the 10-column minimum
		trailer()
	snap := mustParse(t, s)
	if snap.Rows[0].Size != 12345678901234 {
		t.Fatalf("size = %d", snap.Rows[0].Size)
	}
}

func TestEmptySnapshotLegal(t *testing.T) {
	snap := mustParse(t, header("x")+dirLine("/d")+trailer())
	if len(snap.Rows) != 0 || snap.Status != "COMPLETE" {
		t.Fatalf("rows=%d status=%q", len(snap.Rows), snap.Status)
	}
}

func TestMtimeShapeStrict(t *testing.T) {
	for _, bad := range []string{
		"2026-06-01T12:00:00.000+00:00", // offset, not Z
		"2026-06-01T12:00:00,000Z",      // comma
		"2026-06-01T12:00:00.0000Z",     // four digits
		"2026-06-01T12:00:00Z",          // no fraction
	} {
		s := header("x") + dirLine("/d") + row(h1, "10", bad, "/d/f.txt") + trailer()
		if _, err := ParseSnapshot([]byte(s)); err == nil {
			t.Fatalf("mtime %q must be refused", bad)
		}
	}
}

func TestUppercaseHashRefused(t *testing.T) {
	s := header("x") + dirLine("/d") +
		row(strings.ToUpper(h1), "10", t1, "/d/f.txt") + trailer()
	if _, err := ParseSnapshot([]byte(s)); err == nil {
		t.Fatal("hashes are lowercase hex; uppercase must be refused")
	}
}

func TestDeletionRecordParsing(t *testing.T) {
	rec := "#DELETED\t\t2026-08-22T11:04:55.120Z\tprose for a human\n" +
		h1 + "\t15\t2026-08-14T09:31:07.412Z\tallen@DESKTOP\n" +
		h1 + "\t15\t2026-08-19T22:10:41.006Z\tallen@LAPTOP\n" + // duplicate: newest wins
		"#END\n"
	del := Deletions{}
	if err := parseRecord([]byte(rec), del); err != nil {
		t.Fatal(err)
	}
	e, ok := del[h1]
	if !ok || e.Who != "allen@LAPTOP" {
		t.Fatalf("want newest row to win, got %+v", e)
	}
}
