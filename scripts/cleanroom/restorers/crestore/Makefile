# Built against the platform's packages only: libcurl runtime (declared by hand,
# no header is packaged here), OpenSSL 3 and zlib development packages.
CC      ?= gcc
CFLAGS  ?= -std=c2x -O2 -Wall -Wextra -Wno-unused-parameter
LDLIBS   = -l:libcurl.so.4 -lcrypto -lz

s3cab-restore: s3cab-restore.c
	$(CC) $(CFLAGS) -o $@ $< $(LDLIBS)

clean:
	rm -f s3cab-restore
.PHONY: clean
