package main

// s3cab-restore: a clean-room restorer for the s3cab storage format, written from
// format.md alone. Talks to S3 over plain HTTPS with hand-rolled SigV4 signing.
//
//   s3cab-restore list
//   s3cab-restore restore  -set S -snap 2026-08-23T0031 -out DIR
//   s3cab-restore restore-all -out DIR     # every snapshot, to DIR/<set>-<name>

import (
	"bytes"
	"flag"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/klauspost/compress/zstd"
)

func newClient(bucket, region string) *S3Client {
	ak := os.Getenv("AWS_ACCESS_KEY_ID")
	sk := os.Getenv("AWS_SECRET_ACCESS_KEY")
	tok := os.Getenv("AWS_SESSION_TOKEN")
	if ak == "" || sk == "" {
		fmt.Fprintln(os.Stderr, "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set")
		os.Exit(1)
	}
	return &S3Client{
		Bucket: bucket, Region: region,
		AccessKey: ak, SecretKey: sk, Token: tok,
		HTTP: &http.Client{Timeout: 5 * time.Minute},
	}
}

// listSnapshots returns set -> sorted snapshot names, from snapshots/<set>/<name>.tsv.zst keys.
func listSnapshots(c *S3Client) (map[string][]string, error) {
	keys, _, err := c.List("snapshots/", "")
	if err != nil {
		return nil, err
	}
	m := map[string][]string{}
	for _, k := range keys {
		rest := strings.TrimPrefix(k, "snapshots/")
		slash := strings.IndexByte(rest, '/')
		if slash < 0 || !strings.HasSuffix(rest, ".tsv.zst") {
			fmt.Fprintf(os.Stderr, "warning: unexpected key under snapshots/: %q\n", k)
			continue
		}
		set := rest[:slash]
		name := strings.TrimSuffix(rest[slash+1:], ".tsv.zst")
		m[set] = append(m[set], name)
	}
	for set := range m {
		sort.Strings(m[set])
	}
	return m, nil
}

func fetchSnapshot(c *S3Client, set, name string) (*Snapshot, error) {
	raw, err := c.GetObject("snapshots/" + set + "/" + name + ".tsv.zst")
	if err != nil {
		return nil, fmt.Errorf("fetch snapshot: %w", err)
	}
	dec, err := zstd.NewReader(bytes.NewReader(raw))
	if err != nil {
		return nil, err
	}
	defer dec.Close()
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(dec); err != nil {
		return nil, fmt.Errorf("zstd decompress: %w", err)
	}
	return ParseSnapshot(buf.Bytes())
}

func cmdList(c *S3Client) int {
	snaps, err := listSnapshots(c)
	if err != nil {
		fmt.Fprintln(os.Stderr, "list snapshots:", err)
		return 1
	}
	_, setPrefixes, err := c.List("sets/", "/")
	if err != nil {
		fmt.Fprintln(os.Stderr, "list sets:", err)
		return 1
	}
	var sets []string
	for _, p := range setPrefixes {
		sets = append(sets, strings.TrimSuffix(strings.TrimPrefix(p, "sets/"), "/"))
	}
	sort.Strings(sets)
	fmt.Println("sets:")
	for _, s := range sets {
		info, err := c.GetObject("sets/" + s + "/info")
		infoLine := ""
		if err == nil {
			infoLine = " (" + strings.ReplaceAll(strings.TrimRight(string(info), "\n"), "\n", ", ") + ")"
		}
		fmt.Printf("  %s%s\n", s, infoLine)
		for _, n := range snaps[s] {
			fmt.Printf("    %s\n", n)
		}
		if len(snaps[s]) == 0 {
			fmt.Printf("    (no snapshots)\n")
		}
	}
	for set, names := range snaps {
		found := false
		for _, s := range sets {
			if s == set {
				found = true
			}
		}
		if !found {
			fmt.Printf("  %s (snapshots but no sets/ entry)\n", set)
			for _, n := range names {
				fmt.Printf("    %s\n", n)
			}
		}
	}
	del, files, err := LoadDeletions(c)
	if err != nil {
		fmt.Fprintln(os.Stderr, "deletion records:", err)
		return 1
	}
	fmt.Printf("deletion records: %v (%d distinct hashes)\n", files, len(del))
	objKeys, _, err := c.List("objects/", "")
	if err == nil {
		fmt.Printf("objects: %d\n", len(objKeys))
	}
	return 0
}

func restoreSnapshot(c *S3Client, set, name, out string, workers int) int {
	// The output directory exists as soon as the restore is attempted, even when
	// the snapshot turns out damaged — matching what the reference restores show.
	if err := os.MkdirAll(out, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	snap, err := fetchSnapshot(c, set, name)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s/%s: %v\n", set, name, err)
		return 1
	}
	if snap.SetName != set {
		fmt.Fprintf(os.Stderr, "warning: snapshot header names set %q, requested %q\n", snap.SetName, set)
	}
	if snap.Name != name {
		fmt.Fprintf(os.Stderr, "warning: snapshot header names itself %q, key says %q\n", snap.Name, name)
	}
	for _, w := range snap.Warnings {
		fmt.Fprintf(os.Stderr, "warning: %s/%s: %s\n", set, name, w)
	}
	plan, err := PlanRestore(snap, out)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s/%s: %v\n", set, name, err)
		return 1
	}
	res := ExecuteRestore(c, plan, workers, false)
	fmt.Printf("%s/%s: %d files restored", set, name, res.Restored)
	if snap.Excluded+snap.Skipped+snap.Errored > 0 {
		fmt.Printf(" (snapshot notes: %d excluded, %d skipped, %d errored at backup time)",
			snap.Excluded, snap.Skipped, snap.Errored)
	}
	fmt.Println()
	for _, s := range res.SkippedDeleted {
		fmt.Printf("  skipped (deliberate delete): %s\n", s)
	}
	for _, f := range res.Faults {
		fmt.Printf("  FAULT: %s\n", f)
	}
	if len(res.Faults) > 0 {
		return 2
	}
	return 0
}

func main() {
	bucket := flag.String("bucket", os.Getenv("BUCKET"), "S3 bucket (repository)")
	region := flag.String("region", os.Getenv("AWS_REGION"), "AWS region")
	flag.Parse()
	if *bucket == "" || *region == "" || flag.NArg() < 1 {
		fmt.Fprintln(os.Stderr, "usage: s3cab-restore -bucket B -region R {list | restore -set S -snap N -out D | restore-all -out D}")
		os.Exit(1)
	}
	c := newClient(*bucket, *region)

	switch flag.Arg(0) {
	case "cat":
		// cat <key>: raw object to stdout, .tsv.zst keys decompressed. A debugging
		// window onto the real bytes.
		if flag.NArg() != 2 {
			fmt.Fprintln(os.Stderr, "usage: cat <key>")
			os.Exit(1)
		}
		data, err := c.GetObject(flag.Arg(1))
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if strings.HasSuffix(flag.Arg(1), ".zst") {
			dec, err := zstd.NewReader(bytes.NewReader(data))
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
			var buf bytes.Buffer
			buf.ReadFrom(dec)
			dec.Close()
			data = buf.Bytes()
		}
		os.Stdout.Write(data)
		os.Exit(0)
	case "list":
		os.Exit(cmdList(c))
	case "restore":
		fs := flag.NewFlagSet("restore", flag.ExitOnError)
		set := fs.String("set", "", "backup set name")
		snap := fs.String("snap", "", "snapshot name (YYYY-MM-DDTHHMM)")
		out := fs.String("out", "", "output directory")
		workers := fs.Int("workers", 8, "parallel downloads")
		fs.Parse(flag.Args()[1:])
		if *set == "" || *snap == "" || *out == "" {
			fmt.Fprintln(os.Stderr, "restore needs -set, -snap, -out")
			os.Exit(1)
		}
		os.Exit(restoreSnapshot(c, *set, *snap, *out, *workers))
	case "restore-all":
		fs := flag.NewFlagSet("restore-all", flag.ExitOnError)
		out := fs.String("out", "", "output directory; snapshots land at out/<set>-<name>")
		workers := fs.Int("workers", 8, "parallel downloads")
		fs.Parse(flag.Args()[1:])
		if *out == "" {
			fmt.Fprintln(os.Stderr, "restore-all needs -out")
			os.Exit(1)
		}
		snaps, err := listSnapshots(c)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		var sets []string
		for s := range snaps {
			sets = append(sets, s)
		}
		sort.Strings(sets)
		worst := 0
		for _, s := range sets {
			for _, n := range snaps[s] {
				code := restoreSnapshot(c, s, n, *out+"/"+s+"-"+n, *workers)
				if code > worst {
					worst = code
				}
			}
		}
		os.Exit(worst)
	default:
		fmt.Fprintln(os.Stderr, "unknown command:", flag.Arg(0))
		os.Exit(1)
	}
}
