package main

// Snapshot parsing, implementing format.md's four reading rules:
//   - strict UTF-8, no BOM
//   - split on LF exactly, last line terminated like the rest
//   - nothing is quoted or escaped
//   - trim leading fields (spaces only), never trim the path

import (
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type FileRow struct {
	Hash  string
	Size  int64
	MTime time.Time
	Path  string
	Line  int // 1-based line number, for reporting
}

type Snapshot struct {
	SetName string // from the #SNAPSHOT header
	Started string // header's start instant, verbatim
	Name    string // snapshot's own name (local wall clock, minute precision)
	Zone    string // the zone that name was minted in
	Dirs    []string
	Rows    []FileRow
	Status  string // trailer column 2: COMPLETE or PARTIAL
	Ended   string // trailer column 3, verbatim
	// counts of metadata rows, for reporting only
	Excluded, Skipped, Errored int
	Warnings                   []string
}

// trimField trims the space padding off a leading field. Only ASCII space: tabs are
// separators and other whitespace is never padding.
func trimField(s string) string { return strings.Trim(s, " ") }

func isLowerHex64(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// parseInstant parses the format's one timestamp shape: YYYY-MM-DDTHH:MM:SS.sssZ,
// exactly 24 characters, three fractional digits, literal trailing Z.
func parseInstant(s string) (time.Time, error) {
	// Go's time parser accepts a comma before the fraction; the format commits to
	// a dot ("never a comma for the decimal point"), so check the shape ourselves.
	if len(s) != 24 || s[23] != 'Z' || s[19] != '.' {
		return time.Time{}, fmt.Errorf("timestamp %q is not YYYY-MM-DDTHH:MM:SS.sssZ", s)
	}
	t, err := time.ParseInLocation("2006-01-02T15:04:05.000", s[:23], time.UTC)
	if err != nil {
		return time.Time{}, fmt.Errorf("timestamp %q: %v", s, err)
	}
	return t, nil
}

// ParseSnapshot parses a decompressed snapshot. A structural fault (bad UTF-8,
// missing trailer, malformed row) returns an error: the file is damaged goods and
// the row grammar can no longer be trusted.
func ParseSnapshot(data []byte) (*Snapshot, error) {
	if !utf8.Valid(data) {
		return nil, fmt.Errorf("not valid UTF-8: file is damaged")
	}
	if len(data) == 0 {
		return nil, fmt.Errorf("empty file: truncated")
	}
	if strings.HasPrefix(string(data[:min(3, len(data))]), "\xef\xbb\xbf") {
		return nil, fmt.Errorf("UTF-8 BOM present: format forbids one")
	}
	if data[len(data)-1] != '\n' {
		return nil, fmt.Errorf("no final LF: treating as truncated")
	}
	lines := strings.Split(string(data), "\n")
	lines = lines[:len(lines)-1] // the terminator after the last line, not a line

	snap := &Snapshot{}
	warn := func(f string, a ...any) {
		snap.Warnings = append(snap.Warnings, fmt.Sprintf(f, a...))
	}

	// Trailer first: it is what says the rows we read are all of them.
	last := lines[len(lines)-1]
	lastFirst := trimField(strings.SplitN(last, "\t", 2)[0])
	if lastFirst != "#END" {
		return nil, fmt.Errorf("last line is not the #END trailer: treating as truncated")
	}

	for i, line := range lines {
		lineNo := i + 1
		firstField := line
		if t := strings.IndexByte(line, '\t'); t >= 0 {
			firstField = line[:t]
		}
		marker := trimField(firstField)

		if strings.HasPrefix(marker, "#") {
			parts := strings.SplitN(line, "\t", 4)
			switch marker {
			case "#SNAPSHOT":
				if lineNo != 1 {
					warn("#SNAPSHOT header on line %d, not line 1", lineNo)
				}
				if len(parts) >= 4 {
					snap.SetName = trimField(parts[1])
					snap.Started = trimField(parts[2])
					nameZone := parts[3]
					if sp := strings.IndexByte(nameZone, ' '); sp >= 0 {
						snap.Name, snap.Zone = nameZone[:sp], nameZone[sp+1:]
					} else {
						snap.Name = nameZone
					}
				} else {
					warn("#SNAPSHOT header has %d fields, expected 4", len(parts))
				}
			case "#DIR":
				if len(parts) < 4 || parts[3] == "" {
					return nil, fmt.Errorf("line %d: #DIR with no directory", lineNo)
				}
				snap.Dirs = append(snap.Dirs, parts[3])
			case "#END":
				if lineNo != len(lines) {
					warn("#END on line %d is not the last line", lineNo)
					continue
				}
				if len(parts) >= 2 {
					snap.Status = trimField(parts[1])
				}
				if len(parts) >= 3 {
					snap.Ended = trimField(parts[2])
				}
				// ignore anything after: tolerated by commitment
			case "#EXCLUDED":
				snap.Excluded++
			case "#SKIPPED":
				snap.Skipped++
			case "#ERROR":
				snap.Errored++
			default:
				// new metadata kinds may appear; the commitment is that skipping
				// every # line leaves exactly the file rows
			}
			continue
		}

		// A file row. Four tab-separated fields; the path is verbatim after the
		// third tab.
		parts := strings.SplitN(line, "\t", 4)
		if len(parts) != 4 {
			return nil, fmt.Errorf("line %d: file row has %d fields, want 4", lineNo, len(parts))
		}
		hash := trimField(parts[0])
		if !isLowerHex64(hash) {
			return nil, fmt.Errorf("line %d: hash %q is not 64 lowercase hex chars", lineNo, hash)
		}
		sizeStr := trimField(parts[1])
		size, err := strconv.ParseInt(sizeStr, 10, 64)
		if err != nil || size < 0 {
			return nil, fmt.Errorf("line %d: bad size %q", lineNo, sizeStr)
		}
		mtime, err := parseInstant(trimField(parts[2]))
		if err != nil {
			return nil, fmt.Errorf("line %d: %v", lineNo, err)
		}
		path := parts[3] // verbatim: never trimmed
		if path == "" {
			return nil, fmt.Errorf("line %d: empty path", lineNo)
		}
		if strings.ContainsAny(path, "\t\r") {
			return nil, fmt.Errorf("line %d: path contains a tab or CR, which the format forbids", lineNo)
		}
		snap.Rows = append(snap.Rows, FileRow{hash, size, mtime, path, lineNo})
	}

	if snap.Status != "" && snap.Status != "COMPLETE" && snap.Status != "PARTIAL" {
		warn("trailer status %q is neither COMPLETE nor PARTIAL", snap.Status)
	}
	if snap.Status == "PARTIAL" {
		warn("trailer says PARTIAL: rows are not all of the set; restoring what is listed")
	}
	return snap, nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
