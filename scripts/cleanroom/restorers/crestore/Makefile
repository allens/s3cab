# Ubuntu 24.04's cc is gcc 13, whose newest C mode is -std=c2x (C23 as gcc 13 has it).
CC      = gcc
CFLAGS  = -std=c2x -D_GNU_SOURCE -O2 -g -Wall -Wextra -Wno-format-truncation
LDLIBS  = -lssl -lcrypto -lz -lexpat -licuuc

SRC     = src/restore.c src/format.c src/s3.c src/http.c src/util.c
HDR     = src/format.h src/s3.h src/http.h src/util.h

s3cab-restore: $(SRC) $(HDR)
	$(CC) $(CFLAGS) -o $@ $(SRC) $(LDLIBS)

# A local parser check: reads a snapshot (or record) from disk, prints what a restore would do.
snapcheck: tools/snapcheck.c src/format.c src/util.c $(HDR)
	$(CC) $(CFLAGS) -Isrc -o $@ tools/snapcheck.c src/format.c src/util.c $(LDLIBS)

clean:
	rm -f s3cab-restore snapcheck

.PHONY: clean
