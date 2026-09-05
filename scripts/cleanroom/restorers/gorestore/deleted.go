package main

// Deletion records: every objects.deleted-<n>.tsv at the bucket root, read as one
// set. Consulted only when a fetch actually misses — presence always wins.

import (
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

type deletionEntry struct {
	When time.Time
	Who  string
}

// Deletions maps a lowercase hash to its newest record row.
type Deletions map[string]deletionEntry

var recordKeyRE = regexp.MustCompile(`^objects\.deleted-[0-9]+\.tsv$`)

func isHex64AnyCase(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F') {
			return false
		}
	}
	return true
}

// LoadDeletions lists and reads every deletion record in the bucket.
func LoadDeletions(c *S3Client) (Deletions, []string, error) {
	keys, _, err := c.List("objects.deleted-", "")
	if err != nil {
		return nil, nil, err
	}
	del := Deletions{}
	var read []string
	for _, key := range keys {
		if !recordKeyRE.MatchString(key) {
			continue
		}
		data, err := c.GetObject(key)
		if err != nil {
			return nil, nil, fmt.Errorf("read %s: %w", key, err)
		}
		if err := parseRecord(data, del); err != nil {
			return nil, nil, fmt.Errorf("%s: %w", key, err)
		}
		read = append(read, key)
	}
	return del, read, nil
}

func parseRecord(data []byte, del Deletions) error {
	if !utf8.Valid(data) {
		return fmt.Errorf("not valid UTF-8")
	}
	text := string(data)
	if len(text) > 0 && text[len(text)-1] == '\n' {
		text = text[:len(text)-1]
	} else {
		// records land in one atomic PUT, so this should not happen; note and go on
		return fmt.Errorf("no final LF")
	}
	for i, line := range strings.Split(text, "\n") {
		first := line
		if t := strings.IndexByte(line, '\t'); t >= 0 {
			first = line[:t]
		}
		// a line is a row only if its first tab-separated field is 64 hex chars
		if !isHex64AnyCase(first) {
			continue
		}
		parts := strings.SplitN(line, "\t", 4)
		if len(parts) < 4 {
			return fmt.Errorf("row on line %d has %d fields, want 4", i+1, len(parts))
		}
		when, err := parseInstant(parts[2])
		if err != nil {
			return fmt.Errorf("row on line %d: %v", i+1, err)
		}
		hash := strings.ToLower(first)
		// when two rows list the same hash, show the newest row's date
		if prev, ok := del[hash]; !ok || when.After(prev.When) {
			del[hash] = deletionEntry{when, parts[3]}
		}
	}
	return nil
}
