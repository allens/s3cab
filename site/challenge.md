# The day s3cab disappeared

Some years from now, s3cab is gone. The project is archived, the last release won't start on
your new laptop, and nobody remembers the commands. What you still have is the bucket, and
somewhere in it is `beach.jpg`: last summer's photo, the one you edited and made your
wallpaper.

s3cab promised that everything it stores is plain files you can read without it. Time to find
out.

## The bucket

Here it is: [s3cab.plantegral.com/challenge/bucket/](https://s3cab.plantegral.com/challenge/bucket/).
It is a real s3cab repository, served as files on this site instead of from S3, so there is
nothing to sign in to. Opening that address gives the listing an S3 bucket answers with, and
every key in it is a file at that address plus the key: `snapshots/photos.info` is at
`https://s3cab.plantegral.com/challenge/bucket/snapshots/photos.info`. With a real bucket you
would use `aws s3 ls` and `aws s3 cp`, or your provider's web console; here `curl`,
`Invoke-WebRequest` or a browser does the same job.

## The goal

Get `beach.jpg` back, byte for byte, as it was in the **newest** snapshot of the set `photos`.

You need what any computer has or can get: a way to download a file, `gunzip` (or PowerShell,
on Windows), and a SHA-256 check. You've won when the file you downloaded hashes to the value on
its row.

The rules are all in [the format spec](/guide/format), and
[recovering by hand](/guide/format#recovering-by-hand-no-s3cab) is the four-step version. Try it
cold first: the hints are below, one at a time.

## Hints

::: details 1. Where are the snapshots?
Each set keeps its snapshots under `snapshots/` and the set's name, one file per backup, named
for the minute it started on the backed-up machine's clock: `20260101T0930.tsv.gz` would be
1 January 2026 at 09:30. So the newest is the one whose name sorts last. Everything else in the
listing can wait: `objects/` is the content, `snapshots/photos.info` says which machine backs
the set up, and `.s3cab/` is s3cab's own folder, which a restore ignores.
([The layout](/guide/format#the-remote-repository-the-keystone).)
:::

::: details 2. How do I open a snapshot?
It's plain text, gzip-compressed. Download it and run `gunzip` on it, or on Windows, the three
PowerShell lines under [recovering by hand](/guide/format#recovering-by-hand-no-s3cab). Then
look at the last line: it should be a lone `.`, which says the file is whole
([the last line](/guide/format#the-last-line)).
:::

::: details 3. Which row is the file?
Every row has five columns, separated by tabs. A file's row starts with `-`; its second column
is a hash and its last is the path the file had. Find the row whose path ends in `/beach.jpg`.
Careful: the photo has moved since the older snapshot, and its new version shares its content
with another file. ([The columns](/guide/format#the-columns).)
:::

::: details 4. What's the hash for?
Two things. It is the file's name in the bucket: the object at `objects/` plus the hash *is*
`beach.jpg`, whatever it was called. And it is the SHA-256 of the file's bytes, so once you've
downloaded it, hash it yourself: if the two match, you have the file exactly as it was backed up.
:::

## The answer

:::: details Show the whole answer
::: code-group

```bash [bash]
B=https://s3cab.plantegral.com/challenge/bucket

# The newest snapshot of the set: named for its minute, so it sorts last
latest=$(curl -fsS "$B/" | grep -Eo 'snapshots/photos/[0-9]{8}T[0-9]{4}\.tsv\.gz' | sort | tail -n 1)

# Decompress it, and check that its last line is a lone "."
curl -fsS "$B/$latest" | gunzip > latest.tsv
tail -n 1 latest.tsv

# The hash on beach.jpg's row
hash=$(awk -F'\t' '$1 == "-" && $5 ~ /\/beach\.jpg$/ { print $2 }' latest.tsv)

# Download that object, and check that it hashes to its name (on macOS: shasum -a 256 -c)
curl -fsS -o beach.jpg "$B/objects/$hash"
echo "$hash  beach.jpg" | sha256sum -c
```

```powershell [PowerShell]
$B = "https://s3cab.plantegral.com/challenge/bucket"

# The newest snapshot of the set: named for its minute, so it sorts last
$keys = (Invoke-RestMethod "$B/").ListBucketResult.Contents.Key
$latest = $keys | Where-Object { $_ -cmatch '^snapshots/photos/[0-9]{8}T[0-9]{4}\.tsv\.gz$' } | Sort-Object | Select-Object -Last 1
Invoke-WebRequest "$B/$latest" -OutFile latest.tsv.gz

# Decompress it with .NET's GZipStream, and check that its last line is a lone "."
$f = Resolve-Path latest.tsv.gz
$gz = [IO.Compression.GZipStream]::new([IO.File]::OpenRead($f), [IO.Compression.CompressionMode]::Decompress)
$out = [IO.File]::Create(($f -replace "\.gz$", "")); $gz.CopyTo($out); $out.Close(); $gz.Close()
Get-Content latest.tsv -Tail 1

# The hash on beach.jpg's row
$row = Get-Content latest.tsv -Encoding utf8 | Where-Object { $_ -clike "-`t*/beach.jpg" }
$hash = ($row -split "`t")[1].Trim()

# Download that object, and check that it hashes to its name: True
Invoke-WebRequest "$B/objects/$hash" -OutFile beach.jpg
(Get-FileHash beach.jpg -Algorithm SHA256).Hash -eq $hash
```

:::

Now put the two snapshots side by side. Two paths name one object, and one photo moved without
being stored again: a file is stored once per content, however many names it has had. That is
what content-addressable means, and why the bucket stays small.
::::

## Show me how

Three programs restore a whole set the way you just restored one file, each written from
[the format spec](/guide/format) alone by a session that saw nothing else of s3cab: in
[C for Linux](https://github.com/allens/s3cab/tree/main/scripts/cleanroom/restorers/crestore),
[C# for Windows](https://github.com/allens/s3cab/tree/main/scripts/cleanroom/restorers/csrestore)
and [Swift for macOS](https://github.com/allens/s3cab/tree/main/scripts/cleanroom/restorers/swiftrestore).
They sign their own requests to S3, with no AWS SDK, and what they restore is compared byte for
byte with s3cab's own restore.
[How they're made and checked](https://github.com/allens/s3cab/blob/main/scripts/cleanroom/README.md)
is on GitHub.

Or write your own: [writing your own tool](/guide/format#writing-your-own-tool) is the
checklist.
