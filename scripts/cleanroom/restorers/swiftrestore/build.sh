#!/bin/sh
# Builds ./s3cab-restore from src/ with the Swift that ships with Xcode. The module cache goes to
# $TMPDIR because the default location under /var/folders isn't writable in this sandbox.
set -e
cd "$(dirname "$0")"
CACHE="${TMPDIR:-/tmp}/s3cab-modcache"
mkdir -p "$CACHE"
exec swiftc -O -swift-version 6 \
  -module-cache-path "$CACHE" -Xcc -fmodules-cache-path="$CACHE" \
  -import-objc-header src/bridge.h -lcurl -lz \
  src/Util.swift src/S3.swift src/Gzip.swift src/Snapshot.swift src/Records.swift src/Restore.swift src/main.swift \
  -o s3cab-restore
