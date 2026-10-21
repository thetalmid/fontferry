#!/usr/bin/env bash
# FontFerry networked-sandbox fetch + verify (protocol fonttext/1)
#
# Usage:
#   sh fetch_sandbox.sh <per-font-manifest-url> <out.woff2> [work-dir]
#
# Fetches a single-font JSON manifest (text/plain from the service), then
# every chunk page from its absolute URL, stores them in a work directory,
# and runs rebuild.sh. This is exactly the flow an agent with a curl-capable
# sandbox would use; the same chunk pages are what a web_fetch-style text-only
# tool would ingest.
#
# Requirements: curl, base64, sha256sum, grep, sed, awk (standard Unix).
set -eu

# Local/loopback fetches must not go through a corporate proxy (407 risk).
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}localhost,127.0.0.1,::1"
export no_proxy="$NO_PROXY"
# Override CURL_BIN (e.g. /mnt/c/WINDOWS/system32/curl.exe on Windows) where
# the system curl is forced through an intercepting proxy.
CURL_BIN="${CURL_BIN:-curl}"
CURL="$CURL_BIN --noproxy '*'"

MANIFEST_URL="${1:?usage: fetch_sandbox.sh <manifest-url> <out.woff2> [work-dir]}"
OUT="${2:?output path required}"
WORK="${3:-$(mktemp -d)}"
mkdir -p "$WORK"

echo "fetch: manifest $MANIFEST_URL"
$CURL -fsSL "$MANIFEST_URL" -o "$WORK/manifest.json"

ID=$(grep -o '"font_id": "[^"]*"' "$WORK/manifest.json" | head -n1 | cut -d\" -f4)
WHOLE=$(grep -o '"whole_file_sha256": "[^"]*"' "$WORK/manifest.json" | head -n1 | cut -d\" -f4)
[ -n "$ID" ] || { echo "fetch: manifest has no font_id" >&2; exit 1; }
[ -n "$WHOLE" ] || { echo "fetch: manifest has no whole_file_sha256" >&2; exit 1; }

BASE=$(echo "$MANIFEST_URL" | sed -E 's|(https?://[^/]+).*|\1|')
FDIR="$WORK/$ID"
mkdir -p "$FDIR"

# For each chunk URL in the manifest, fetch the page and compute the decoded
# part's SHA-256 (so rebuild.sh can verify per chunk).
> "$FDIR/chunks.lst"
COUNT=0
grep -o '"url": "/chunks/[^"]*"' "$WORK/manifest.json" | sed 's/.*chunks\///; s/"//' > "$FDIR/chunkurls.lst"
while IFS= read -r rel; do
  FULL="$BASE/chunks/$rel"
  FILE=$(basename "$rel")
  if $CURL -fsSL --retry 2 --retry-delay 1 "$FULL" -o "$FDIR/$FILE"; then
    echo "fetch: $FULL -> $FDIR/$FILE"
  else
    echo "fetch: FAILED $FULL" >&2
    exit 1
  fi
  grep -v '^#' "$FDIR/$FILE" | tr -d ' \t\r\n' | base64 -d > "$FDIR/$FILE.part"
  SHA=$(sha256sum "$FDIR/$FILE.part" | awk '{print toupper($1)}')
  rm -f "$FDIR/$FILE.part"
  printf 'chunk_%s_sha256=%s\nchunk_%s_file=%s\n' "$COUNT" "$SHA" "$COUNT" "$FILE" >> "$FDIR/chunks.lst"
  COUNT=$((COUNT+1))
done < "$FDIR/chunkurls.lst"
rm -f "$FDIR/chunkurls.lst"

# Write the simple line-based manifest rebuild.sh consumes.
{
  echo "# FontFerry reassembly manifest — protocol fonttext/1"
  echo "font_id=$ID"
  echo "format=woff2"
  echo "encoding=base64"
  echo "line_width=76"
  echo "newline=lf"
  echo "chunk_raw_bytes=8190"
  echo "whole_file_sha256=$WHOLE"
  echo "chunk_count=$COUNT"
  cat "$FDIR/chunks.lst"
  rm -f "$FDIR/chunks.lst"
} > "$FDIR/MANIFEST.txt"

sh "$(dirname "$0")/rebuild.sh" "$FDIR/MANIFEST.txt" "$FDIR" "${OUT}"

echo "fetch: done — ${OUT}"
