#!/bin/sh
# Builds ./s3cab-restore from src/ with the Swift that ships with Xcode, in Swift 6 language
# mode. Links only what macOS itself provides: libcurl, zlib and libicucore (CommonCrypto is
# in libSystem).
set -eu
cd "$(dirname "$0")"
mkdir -p .build/modcache
swiftc -swift-version 6 -O \
    -module-cache-path .build/modcache \
    -import-objc-header src/bridge.h \
    src/Util.swift src/Text.swift src/Paths.swift src/Snapshot.swift src/S3.swift src/Repository.swift src/Restore.swift src/main.swift \
    -lcurl -lz -licucore \
    -o s3cab-restore 2>.build/build.log || { grep -v -e DVTFilePathFSEvents -e xcrun_db .build/build.log >&2; exit 1; }
grep -v -e DVTFilePathFSEvents -e xcrun_db .build/build.log >&2 || true
echo "built ./s3cab-restore"
