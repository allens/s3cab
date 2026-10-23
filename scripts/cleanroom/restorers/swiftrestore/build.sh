#!/bin/sh
# Builds ./s3cab-restore from src/ with the Swift that ships with the Xcode command-line tools.
set -e
cd "$(dirname "$0")"
MC="${TMPDIR:-/tmp}/s3cab-restore-modcache"
mkdir -p "$MC"
swiftc -swift-version 6 -O \
  -module-cache-path "$MC" \
  -import-objc-header src/shim.h \
  src/Http.swift src/SigV4.swift src/S3.swift src/Gzip.swift src/Text.swift src/Paths.swift src/Snapshot.swift src/Deleted.swift src/Writer.swift src/main.swift \
  -lcurl -lz \
  -o s3cab-restore 2>&1 | grep -v 'DVTFilePathFSEvents\|xcrun_db' || true
test -x s3cab-restore && echo "built ./s3cab-restore"
