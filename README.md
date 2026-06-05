# s3cab

Eternally open S3 content addressable backup

```
.s3cab.conf {
    remote: "s3://bucket/prefix"
    include: [
        "C:\Users\myusername"
    ],
    exclude: []
}
```

snapshot - takes fileset and ignores, uploads to bucket
snapshot <set> <bucket>

setname.txt
setname.ignore.txt

remotes

Commands:
init <uri> [--name]
switch <name>

upload <file>
download <oid> [--output,-o name]

backup <snapshot>

snapsot <snapshot> --add|a --remove [dir...]
snapshot rm [dir...]
snapshot

snapshot <name=USER> <remote>
list

.s3cab/<snapshotName=user>.txt
.s3cab/<snapshotName=user/2011-12-03T1130.csv

s3://bucket/objects.txt
s3://bucket/objects/xxxxxxx
s3://bucket/<hostname>/<snapshotName>/2011-12-03T1130.csv
