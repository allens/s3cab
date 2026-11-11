CC      ?= gcc
CFLAGS  ?= -std=c2x -O2 -g -Wall -Wextra -Wno-unused-parameter
LDLIBS   = -lssl -lcrypto -lz
SRC      = src/util.c src/http.c src/s3.c src/text.c src/gz.c src/snap.c src/main.c

s3cab-restore: $(SRC) src/common.h src/snap.h
	$(CC) $(CFLAGS) -Isrc -o $@ $(SRC) $(LDLIBS)

clean:
	rm -f s3cab-restore

.PHONY: clean
