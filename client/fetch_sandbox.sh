#!/usr/bin/env bash
# FontFerry networked-sandbox fetch + verify (protocol fonttext/1)
#
# Usage:
#   sh fetch_sandbox.sh <per-font-manifest-url> <out.woff2> [work-dir]
#
# Fetches a single-font JSON manifest (text/plain from the service), then
# every chunk page from its URL, stores them in a work directory, and runs
# rebuild.sh. This is exactly the flow an agent with a curl-capable sandbox
# would use; the same chunk pages are what a web_fetch-style text-only tool
# would ingest.
#
# Integrity: every chunk's decoded bytes are checked against the SHA-256 the
# *server* lists in the manifest (not against a locally computed hash), so a
# corrupted transfer is caught with the exact chunk index.
#
# Requirements: curl, base64, sha256sum or shasum, grep, sed, awk.
set -eu

# Loopback fetches should not go through a corporate proxy (407 risk); remote
# hosts must keep using the proxy configured via http_proxy/https_proxy.
export NO_PROXY="${NO_PROXY:+$NO_PROXY,}localhost,127.0.0.1,::1"
export no_proxy="$NO_PROXY"
# Override CURL_BIN (e.g. /mnt/c/WINDOWS/system32/curl.exe on Windows) where
# the system curl is forced through an intercepting proxy.
CURL_BIN="${CURL_BIN:-curl}"
CURL="$CURL_BIN --noproxy localhost,127.0.0.1,::1"

MANIFEST_URL="${1:?usage: fetch_sandbox.sh <manifest-url> <out.woff2> [work-dir]}"
OUT="${2:?output path required}"
WORK="${3:-}"
if [ -z "$WORK" ]; then
  WORK=$(mktemp -d)
  TMP_CREATED=1
fi
trap 'if [ "${TMP_CREATED:-0}" = 1 ]; then rm -rf "$WORK"; fi' EXIT
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

# Extract (url, sha256) pairs for every chunk from the manifest JSON.
awk '
  /"url": "\/chunks\// {
    u=$0; sub(/^.*"url": "/, "", u); sub(/",?$/, "", u)
    urls[++n]=u
  }
  /"sha256": "/ {
    h=$0; sub(/^.*"sha256": "/, "", h); sub(/",?$/, "", h)
    hashes[n]=h
  }
  END { for (i=1;i<=n;i++) print urls[i] "\t" hashes[i] }
' "$WORK/manifest.json" > "$FDIR/chunkpairs.lst"

COUNT=0
while IFS=$'\t' read -r rel expected_sha; do
  FULL="${BASE}${rel}"
  FILE=$(basename "$rel")
  if $CURL -fsSL --retry 2 --retry-delay 1 "$FULL" -o "$FDIR/$FILE"; then
    echo "fetch: $FULL -> $FDIR/$FILE"
  else
    echo "fetch: FAILED $FULL" >&2
    exit 1
  fi
  grep -v '^#' "$FDIR/$FILE" | tr -d ' \t\r\n' | base64 -d > "$FDIR/$FILE.part"
  ACTUAL=$(sha256sum "$FDIR/$FILE.part" | awk '{print toupper($1)}')
  rm -f "$FDIR/$FILE.part"
  if [ "$ACTUAL" != "$expected_sha" ]; then
    echo "fetch: chunk $COUNT HASH MISMATCH ($FILE) expected=$expected_sha got=$ACTUAL" >&2
    exit 1
  fi
  printf 'chunk_%s_sha256=%s\nchunk_%s_file=%s\n' "$COUNT" "$expected_sha" "$COUNT" "$FILE" >> "$FDIR/chunks.lst"
  COUNT=$((COUNT+1))
done < "$FDIR/chunkpairs.lst"
rm -f "$FDIR/chunkpairs.lst"

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
