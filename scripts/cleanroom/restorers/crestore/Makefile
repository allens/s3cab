# s3cab-restore: an independent restorer for the s3cab storage format.
#
# Needs a C23 compiler and the platform's own packages for TLS and hashing (OpenSSL),
# inflate (zlib), XML (expat) and Unicode case mapping (ICU). No AWS SDK, no S3 library.

CC      ?= cc
CFLAGS  ?= -O2 -g
WARN     = -Wall -Wextra -Wpedantic -Wshadow -Wconversion -Wno-sign-conversion
STD      = -std=c23
PKGS     = openssl zlib expat icu-uc
PKG_CFLAGS := $(shell pkg-config --cflags $(PKGS))
PKG_LIBS   := $(shell pkg-config --libs $(PKGS))

SRC = restore.c s3.c snapshot.c util.c
HDR = s3.h snapshot.h util.h

all: s3cab-restore

s3cab-restore: $(SRC) $(HDR) Makefile
	$(CC) $(STD) $(CFLAGS) $(WARN) $(PKG_CFLAGS) -o $@ $(SRC) $(PKG_LIBS)

# Development aids and test helpers, not part of the restorer.
tools: build/s3probe build/snapcheck build/errbody build/linux_hints

build/s3probe: tools/s3probe.c s3.c util.c $(HDR) Makefile
	@mkdir -p build
	$(CC) $(STD) $(CFLAGS) $(WARN) $(PKG_CFLAGS) -o $@ tools/s3probe.c s3.c util.c $(PKG_LIBS)

build/snapcheck: tools/snapcheck.c snapshot.c util.c $(HDR) Makefile
	@mkdir -p build
	$(CC) $(STD) $(CFLAGS) $(WARN) $(PKG_CFLAGS) -o $@ tools/snapcheck.c snapshot.c util.c $(PKG_LIBS)

build/errbody: tools/errbody.c s3.c util.c $(HDR) Makefile
	@mkdir -p build
	$(CC) $(STD) $(CFLAGS) $(WARN) $(PKG_CFLAGS) -o $@ tools/errbody.c s3.c util.c $(PKG_LIBS)

build/linux_hints: tests/linux_hints.c Makefile
	@mkdir -p build
	$(CC) $(STD) $(CFLAGS) -Wall -o $@ tests/linux_hints.c

clean:
	rm -rf s3cab-restore build

.PHONY: all tools clean
