#!/bin/sh
# Builds ./s3cab-restore with the platform's default Swift toolchain (xcode-select), Swift 6 mode.
set -e
cd "$(dirname "$0")"
mkdir -p "${TMPDIR:-/tmp}/s3cab-swift-cache"
exec swiftc -swift-version 6 -O \
  -module-cache-path "${TMPDIR:-/tmp}/s3cab-swift-cache" \
  -I shim \
  -o s3cab-restore \
  Sources/*.swift
