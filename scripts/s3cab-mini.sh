#!/usr/bin/env bash
# SPIKE (preserved) — s3cab-mini: snapshot, upload, restore in bash. Writes the s3cab format
# (guide/format.md), nothing else: no exclude patterns, no hash reuse, no retries beyond the aws
# CLI's own, no files over 5 GB (single put-object), no #ERROR/#SKIPPED rows (an unreadable
# file stops the run; symlinks are left out silently), GNU/Linux only. The starting sketch for the
# clean-room backup (ADR-0096), not a tool: tested only against a fake local `aws`, never a real
# bucket. Needs: bash 4+, GNU find/coreutils, zstd, aws CLI v2.
#
#   s3cab-mini snapshot <set> <dir>...           walk + hash into a local snapshot
#   s3cab-mini upload   <set> <bucket>           newest local snapshot: objects first, snapshot last
#   s3cab-mini restore  <set> <bucket> <output> [<snapshot-name>]
set -euo pipefail

die() { printf 's3cab-mini: %s\n' "$*" >&2; exit 1; }
row() { printf '%-64s\t%10s\t%-24s\t%s\n' "$@"; } # the format's padded columns
now() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
snapdir() { printf '%s/sets/%s/snapshots' "${S3CAB_HOME:-$HOME/.s3cab}" "$1"; }

snapshot() {
  local set=$1 dirs=() d; shift
  [[ $# -gt 0 ]] || die "usage: snapshot <set> <dir>..."
  for d; do dirs+=("$(realpath -e -- "$d")"); done

  local name zone out
  name=$(date +%Y-%m-%dT%H%M)
  zone=${TZ:-$(readlink /etc/localtime | sed 's|.*zoneinfo/||')}
  out="$(snapdir "$set")/$name.tsv.zst"
  [[ ! -e $out ]] || die "snapshot $name already exists — snapshots are never overwritten"
  mkdir -p "${out%/*}"

  {
    row '#SNAPSHOT' "$set" "$(now)" "$name ${zone:-UTC}"
    for d in "${dirs[@]}"; do row '#DIR' '' '' "$d"; done
    # One walk for size + mtime, then one sha256sum stream over the same list, read in
    # lockstep. -z keeps sha256sum from escaping odd filenames.
    local list size mtime path sum
    list=$(mktemp)
    TZ=UTC find "${dirs[@]}" -name .s3cab -prune -o -type f \
      -printf '%s\t%TY-%Tm-%TdT%TH:%TM:%TS\t%p\0' | sort -z -t $'\t' -k3 >"$list"
    while IFS=$'\t' read -r -d '' size mtime path; do
      [[ $path != *$'\t'* && $path != *$'\r'* && $path != *$'\n'* ]] ||
        die "path holds a tab, CR or LF, which the format can't store: $path"
      # An unreadable file gets no sha256sum line, so the hash stream can run out
      # early (the last file) or slip by a row (any other): both are fatal.
      IFS= read -r -d '' sum <&3 && [[ ${sum#*  } == "$path" ]] ||
        die "could not hash $path (unreadable?)"
      row "${sum%% *}" "$size" "${mtime:0:23}Z" "$path"
    done <"$list" 3< <(cut -z -f3- "$list" | xargs -0r sha256sum -z)
    rm -f "$list"
    row '#END' COMPLETE "$(now)" ''
  } | zstd -q -f -o "$out.part" # -f: a failed earlier attempt leaves a .part
  mv "$out.part" "$out"
  echo "$out"
}

upload() {
  local set=$1 bucket=${2:?usage: upload <set> <bucket>} snap
  snap=$(ls -1 "$(snapdir "$set")"/*.tsv.zst 2>/dev/null | tail -1)
  [[ -n $snap ]] || die "no local snapshot for set '$set' — run: s3cab-mini snapshot $set <dir>"

  # One LIST of the store, then upload only the hashes it lacks.
  declare -A stored=()
  local key
  while read -r key; do stored[${key#objects/}]=1; done < <(
    aws s3api list-objects-v2 --bucket "$bucket" --prefix objects/ \
      --query 'Contents[].Key' --output text | tr '\t' '\n' | grep -v '^None$' || true)

  # Decompress in full first: a damaged snapshot must stop the upload, not end the
  # loop early and still publish a snapshot whose objects never went up.
  local rows hash size mtime path sent=0
  rows=$(mktemp); trap "rm -f '$rows'" EXIT
  zstd -dc "$snap" >"$rows"
  [[ $(tail -1 "$rows") == '#END'* ]] || die "local snapshot ${snap##*/} is truncated (no #END trailer)"
  while IFS=$'\t' read -r hash size mtime path; do
    [[ $hash == '#'* || -n ${stored[$hash]:-} ]] && continue
    # S3 checks the body against the expected SHA-256, so a file that changed since
    # the snapshot is refused rather than stored as wrong bytes under the old hash.
    aws s3api put-object --bucket "$bucket" --key "objects/$hash" --body "$path" \
      --checksum-sha256 "$(printf "$(sed 's/../\\x&/g' <<<"$hash")" | base64)" >/dev/null ||
      die "upload failed (changed since snapshot?): $path"
    stored[$hash]=1; sent=$((sent + 1))
  done <"$rows"

  aws s3 cp --quiet "$snap" "s3://$bucket/snapshots/$set/${snap##*/}" # snapshot last
  echo "uploaded $sent objects and ${snap##*/}"
}

restore() {
  local set=$1 bucket=$2 output=${3:?usage: restore <set> <bucket> <output> [<snapshot-name>]}
  local name=${4:-} tmp
  if [[ -z $name ]]; then
    name=$(aws s3 ls "s3://$bucket/snapshots/$set/" | awk '{print $4}' | sort | tail -1)
    [[ -n $name ]] || die "set '$set' has no snapshots in $bucket"
  fi
  name=${name%.tsv.zst}.tsv.zst
  tmp=$(mktemp); trap "rm -f '$tmp'" EXIT
  aws s3 cp --quiet "s3://$bucket/snapshots/$set/$name" - | zstd -dc >"$tmp"
  [[ $(tail -1 "$tmp") == '#END'* ]] || die "snapshot $name is truncated (no #END trailer)"

  # Each file lands at <output>/<basename of its #DIR>/<path below it>; longest #DIR wins.
  local -a dirs=()
  mapfile -t dirs < <(grep '^#DIR' "$tmp" | cut -f4- | awk '{print length "\t" $0}' |
                      sort -rn | cut -f2-)
  local hash size mtime path d dest n=0
  while IFS=$'\t' read -r hash size mtime path; do
    [[ $hash == '#'* ]] && continue
    dest=
    for d in "${dirs[@]}"; do
      if [[ $path == "$d"/* ]]; then dest="$output/${d##*/}/${path#"$d"/}"; break; fi
    done
    [[ -n $dest ]] || die "no #DIR covers $path"
    mkdir -p "${dest%/*}"
    aws s3 cp --quiet "s3://$bucket/objects/$hash" "$dest.part"
    [[ $(sha256sum <"$dest.part" | cut -d' ' -f1) == "$hash" ]] ||
      { rm -f "$dest.part"; die "object $hash failed its hash check"; }
    mv "$dest.part" "$dest"
    touch -d "$mtime" "$dest"
    n=$((n + 1))
  done <"$tmp"
  echo "restored $n files from $name into $output"
}

cmd=${1:-}; shift || true
case $cmd in
  snapshot | upload | restore) "$cmd" "$@" ;;
  *) die "usage: s3cab-mini {snapshot|upload|restore} …" ;;
esac
