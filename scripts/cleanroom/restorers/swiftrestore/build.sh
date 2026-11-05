#!/bin/sh
# Builds ./s3cab-restore from src/ with the Swift that ships in Xcode's command-line tools. No packages.
set -e
cd "$(dirname "$0")"
DEV="$(xcode-select -p 2>/dev/null || echo /Applications/Xcode.app/Contents/Developer)"
SDK="$DEV/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
SWIFTC="$DEV/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc"
CACHE="${TMPDIR:-/tmp}/s3cab-restore-modcache"
mkdir -p "$CACHE"
exec "$SWIFTC" -swift-version 6 -O -sdk "$SDK" -module-cache-path "$CACHE" \
  -import-objc-header src/bridge.h -lcurl -lz -o s3cab-restore src/*.swift
