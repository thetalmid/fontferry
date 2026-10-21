# FontFerry — protocol `fonttext/1`

Delivery of binary font files (WOFF2) to AI agents whose only intake is a
plain-text fetch tool (web_fetch-style) and whose only output channel is text.
Every byte of a font travels as base64 *text* through the agent's context;
nothing is promised to be binary-safe except the final local file.

## Why this protocol

Research grounding (see `README.md` → "Design notes" for sources):

- Fetch tools accept only text/HTML/PDF; a raw WOFF2 URL is rejected
  (`unsupported_content_type`). So the service serves **text/plain** with the
  base64 payload — never HTML, which would be markdown-mangled.
- A model is not a reliable verbatim copier of long random strings (silent
  single-token corruption is observed in production). So we never ask the model
  to *re-type* bytes; it orchestrates fetch + a deterministic verifiable
  reassembly script. Error detection is therefore mandatory.
- Checksums: whole-file SHA-256 + per-chunk SHA-256, so a corrupted chunk is
  localized and only that chunk needs re-fetching (no whole-file redo).
- Chunking: byte-range chunks of ~8 KiB raw (~11 KB base64 ≈ ~6k tokens), far
  under fetch response caps, and a sensible number of requests under rate
  limits. Each chunk page is self-describing and self-verifying.
- Base64 (not hex/base85): best efficiency/robustness balance; standard
  alphabet, `+ / =` documented; lines wrapped at 76 chars (MIME).
- Determinism: content-addressed URL layout, immutable caching, ETag = SHA-256.

## URL layout (served by `server/serve.mjs` from `out/`)

| URL | Content | Content-Type |
|---|---|---|
| `/` | human-readable store index | text/plain |
| `/manifest.txt` | array of per-font JSON manifests | text/plain |
| `/manifests/<font_id>.txt` | **per-font manifest** (same as .json) | text/plain |
| `/manifests/<font_id>.json` | per-font manifest (byte-identical) | text/plain |
| `/chunks/<font_id>/NNN.txt` | chunk page (base64 body) | text/plain |
| `/chunks/<font_id>/MANIFEST.txt` | simple line-based reassembly manifest | text/plain |
| `/fonts/<font_id>.woff2` | **binary** original (humans/browsers) | font/woff2 |
| `/licenses/<file>` | OFL license texts | text/plain |
| `/web/` | demo page with `data:` URI fonts | text/html |

Chunk URLs in the manifest are root-relative (`/chunks/<font_id>/NNN.txt`),
short (<250 chars), and appear only in the manifest itself — satisfying "URL
must appear in prior context" style whitelisting, if any. Clients resolve them
against the manifest's own base URL (see `client/fetch_sandbox.sh`); the
service never redirects.

## The manifest (per font)

```json
{
  "protocol": "fonttext/1",
  "font_id": "chakra-petch-700",
  "family": "Chakra Petch",
  "weight": 700,
  "format": "woff2",
  "rebuilt_name": "chakra-petch-700.woff2",
  "encoding": "base64",
  "line_width": 76,
  "newline": "lf",
  "chunk_raw_bytes": 8190,
  "whole_file_sha256": "CE5095…",
  "original_size_bytes": 9900,
  "base64_chars": 13200,
  "chunks": [
    {
      "index": 0,
      "url": "/chunks/chakra-petch-700/000.txt",
      "sha256": "1CD908…",
      "bytes": 8190,
      "first_byte": 0,
      "last_byte": 8189
    }
  ],
  "upstream": [ { "url": "…", "note": "…" } ],
  "license": { "spdx": "OFL-1.1", "notice": "…", "text_url": "/licenses/…" }
}
```

## Chunk page format (spec)

```
# fonttext/1 chunk 0/2 font=chakra-petch-700 sha256=1CD908… bytes=8190 range=0-8189
<base64, wrapped at 76 columns, LF only>
# end chunk 0/2
```

- Framing lines start with `# `; client strips them (`grep -v '^#'`).
- Body: standard base64 (with padding). Whitespace (incl. newlines and any
  stray CR) must be ignored when decoding: `tr -d ' \t\r\n' | base64 -d`.
- `sha256` in header is over the **binary bytes of the chunk**, not the text.
- EOF: exactly one trailing LF after the footer.

## Client protocol

1. Fetch the per-font manifest (`/manifests/<id>.txt`).
2. For each `chunks[i].url`, fetch the page (absolute URL from manifest), save
   verbatim as `<dir>/NNN.txt` (filenames from manifest).
3. Run `client/rebuild.sh <dir>/MANIFEST.txt <dir> <out.woff2>`:
   - per-chunk: strip `#` lines → strip whitespace → `base64 -d` →
     `sha256sum` compare with manifest; mismatch ⇒ fail loudly naming chunk.
   - concatenate parts → whole-file `sha256sum -c` vs `whole_file_sha256`.
4. On a chunk mismatch: re-fetch only that chunk URL (max ~2 retries), then
   re-run the same script — verified parts are reused.

`client/fetch_sandbox.sh` automates steps 1–3 for a networked sandbox (curl).

## Failure semantics

- Any missing chunk page, malformed framing, or hash mismatch aborts with a
  non-zero exit and the exact chunk index. No silent partial output: the
  output file is built via a temp file and moved only after whole-file
  verification passes.
- The service never redirects, never serves HTML for data routes, and uses
  immutable HTTP caching (`Cache-Control: public, max-age=31536000, immutable`,
  `ETag: "<sha256>"`).

## Rebuilding deliverables from source

```sh
# prerequisites: Node.js ≥ 20, bash (Git Bash/WSL/macOS/Linux), curl,
# and either sha256sum (coreutils) or shasum -a 256 (macOS)
cd builder && npm install          # wawoff2 (Google woff2 wasm port)
node build.mjs                     # regenerates ../out/ and ../web/index.html
node ../server/serve.mjs --port 8737   # serve out/ as described above
```

The build verifies `sources/sources.lock` before emitting anything: every
input's SHA-256 must match the pin, and for TTF sources the WOFF2 conversion
is round-trip-checked (decompress must reproduce the same table structure).

Deterministic output: identical inputs ⇒ identical chunk pages, manifests
(except the `generated_utc` field in the store index) and hashes. CI
(`.github/workflows/determinism.yml`) rebuilds and diffs the committed store.
