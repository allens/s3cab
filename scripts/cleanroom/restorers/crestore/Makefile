CC ?= gcc
CFLAGS ?= -std=gnu2x -O2 -Wall -Wextra -Wno-unused-parameter
LDLIBS = -l:libcurl.so.4 -lcrypto -lz

s3cab-restore: s3cab-restore.c
	$(CC) $(CFLAGS) -o $@ $< $(LDLIBS)

clean:
	rm -f s3cab-restore
