# FontFerry

A delivery service for binary font files (WOFF2) over a **text-only channel**,
built for AI agents whose only intake is a `web_fetch`-style tool and whose
only output is text.

It solves a specific problem: an agent in a networkless sandbox cannot download
a font, and every byte must pass through the model's context as text. So this
repo turns fonts into **chunked base64 plain-text pages with per-chunk and
whole-file SHA-256 verification** — cheap to copy, and errors are detectable
and cheap to fix.

The protocol is `fonttext/1`, specified in [SPEC.md](./SPEC.md).

## Layout

```
builder/build.mjs               deterministic build: chunks, manifests, scripts, self-test
builder/package.json            build tooling (dep: wawoff2)
server/serve.mjs                text/plain static server (no deps; ETag = sha256)
client/rebuild.sh               pure-POSIX-sh reassembly + verification (offline sandbox)
client/fetch_sandbox.sh         curl-based fetch + rebuild (networked sandbox)
sources/                        upstream fonts + OFL texts (pinned, see sources.lock)
sources/sources.lock            SHA-256 pin of every build input; the build refuses drift
out/                            generated store (see below)
out/chunks/<id>/NNN.txt         chunk pages: base64 @ 76 cols, LF, framing lines
out/chunks/<id>/MANIFEST.txt    line-based reassembly manifest (no jq needed)
out/manifests/<id>.json/.txt    per-font JSON manifest, text/plain (byte-identical pair)
out/fonts/<id>.woff2            binary originals (humans/browsers)
out/scripts/<id>.sh             single-shot heredoc rebuild (when payload fits one fetch)
out/rebuilt/<id>.woff2          self-test output (expected to equal fonts/<id>.woff2)
out/licenses/                   OFL 1.1 texts (redistribution requirement)
out/ROOT.txt / store.json/.txt  store index (generated_utc differs per build)
web/index.html                  demo page with @font-face data: URIs + OFL notice
```

`out/` is generated; rebuild it anytime with `node builder/build.mjs`.
Deterministic: identical inputs ⇒ identical bytes everywhere except the
`generated_utc` timestamp in `out/store.json`, `out/store.txt` and
`out/ROOT.txt`. CI (`./.github/workflows/determinism.yml`) enforces this by
rebuilding and diffing the committed store.

## Build and serve

```sh
cd builder && npm install          # dep: wawoff2 (Google woff2 wasm port)
node build.mjs                     # regenerates ../out/ and ../web/index.html
node ../server/serve.mjs --port 8737
```

That serves `http://127.0.0.1:8737/` — store index (text/plain), per-font
manifests, chunk pages, licenses, and `/web/` demo.

## Fonts

| id | family / weight | source | license |
| --- | --- | --- | --- |
| `chakra-petch-700` | Chakra Petch 700 (latin subset) | Google Fonts gstatic v13 | OFL-1.1 |
| `open-sauce-sans-400` | Open Sauce Sans 400 | foundry TTF → wawoff2 | OFL-1.1 |
| `open-sauce-sans-600` | Open Sauce Sans 600 | foundry TTF → wawoff2 | OFL-1.1 |
| `open-sauce-sans-700` | Open Sauce Sans 700 | foundry TTF → wawoff2 | OFL-1.1 |

Why OSS 400 is converted, not copied: the `@fontsource/open-sauce-sans` 400
"WOFF2" on CDNs is actually a PostScript Type-1 body (round-trip fails, magic
is not WOFF2). The build takes the foundry's own TTFs and converts with
`wawoff2`, verifying round-trip and stable output.

## Using it from an agent (text-only fetch)

1. Fetch `/manifests/<id>.txt` — it lists every chunk URL in full, with hashes.
2. Fetch each `/chunks/<id>/NNN.txt` page; save it verbatim.
3. Run `client/rebuild.sh` — strips the `#` framing lines, ignores all
   whitespace (incl. CRLF), base64-decodes, verifies every chunk, then the
   whole file.
4. On any mismatch, re-fetch only the failing chunk and re-run; verified parts
   are reused.

A networked sandbox can skip steps 1–2 manually:

```sh
sh client/fetch_sandbox.sh \
  http://127.0.0.1:8737/manifests/open-sauce-sans-400.txt \
  /tmp/oss-400.woff2
```

### Failure behaviour

| Situation | What happens |
| --- | --- |
| Chunk page missing | aborts, names the missing file |
| Chunk hash mismatch | aborts, names chunk index; only that chunk needs re-fetching |
| Whole-file hash mismatch | aborts; output file never left in a partial state (temp file + rename) |
| Corrupt/undecodable base64 | fails at decode; same selective-retry guidance |
| Output path is a directory | fails fast with a clear message |
| Corporate proxy intercepts loopback | `fetch_sandbox.sh` adds `localhost,127.0.0.1,::1` to `NO_PROXY`; remote hosts still use the configured proxy |
| Wrong/updated manifest hash | `fetch_sandbox.sh` verifies every chunk against the server's manifest SHA-256 before reassembling |

Exit code is `0` only when the final whole-file hash matches the manifest.

## Why this design

- **Fetch tools reject binary.** `web_fetch` accepts text/HTML/PDF only, so
  everything the agent ingests is `text/plain` — never HTML, which would get
  markdown-mangled.
- **Models are not verbatim copiers.** Long random strings are exactly where a
  silent slip happens, so the agent never re-types bytes: it orchestrates
  fetch + a deterministic, verifying script. That is why hashes are
  mandatory, not optional.
- **Chunking localizes failures.** ~8 KiB raw per chunk (~11 KB base64 ≈ ~6k
  tokens) stays under response caps and rate limits, and a bad chunk costs one
  re-fetch, not a whole file redo.
- **Base64, not hex/base85.** Hex doubles the length; base85's alphabet
  invites mangling in text pipelines. Lines are wrapped at 76 columns (MIME),
  LF-only; the client strips all whitespace before decoding.
- **Per-chunk + whole-file SHA-256** — whole-file is authoritative, per-chunk
  enables selective refetch. For 10–60 KB files, send-once + verify +
  selective refetch beats erasure coding.
- **Content-addressed, immutable serving.** Stable chunk URLs, `ETag` = SHA-256,
  `Cache-Control: public, max-age=31536000, immutable`, no redirects.

Research grounding for each of these is in the Sources section below.

## What is tracked, and why

| File | Reason |
| --- | --- |
| `builder/build.mjs` | The whole pipeline: chunking, manifests, self-test, demo page |
| `server/serve.mjs` | Plain-text serving semantics (text/plain, ETag, no redirects) |
| `client/rebuild.sh` | The offline reassembly path — the piece the agent actually runs |
| `client/fetch_sandbox.sh` | Networked version of the same flow |
| `sources/` | Upstream fonts + OFL texts — the build's only inputs, pinned by `sources/sources.lock` (SHA-256 per file; the build refuses to proceed on drift) |
| `out/` | The generated store (committed so the repo works without a build) |
| `SPEC.md` | The protocol contract (`fonttext/1`) |
| `web/index.html` | Demo page with the four fonts embedded as data: URIs |

## What is deliberately excluded

- **`builder/node_modules/`** — generated by `npm install`; `wawoff2` is
  version-pinned in `builder/package.json`.
- **The Fontsource 400 "WOFF2"** — it is a Type-1 body, not a WOFF2. Keeping it
  in `sources/` would invite shipping a broken file.
- **Temp/test artifacts** — no logs, pid files, or scratch files in the repo
  (`.gitignore`).
- **No credentials anywhere** — this repo holds no tokens; it is public-clean
  by construction.

## License and attribution

All four fonts are **SIL Open Font License 1.1**. Serving and embedding are
permitted under OFL terms; license texts ship in `out/licenses/` and the
copyright notices are repeated in each manifest:

- Chakra Petch: `Copyright 2018 The Chakra Petch Project Authors (https://github.com/m4rc1e/Chakra-Petch.git)`
- Open Sauce Sans: `Copyright (c) 2020 The Open Sauce Sans Authors (https://github.com/marcologous/Open-Sauce-Fonts)`

This repo's own code is MIT (see [LICENSE](./LICENSE)). The fonts are not
covered by the MIT license — they keep their OFL terms.

## Not covered here

- **Variable fonts** — only the four static weights above. If you need other
  weights, add them to the `fonts` array in `builder/build.mjs` and rebuild.
- **Erasure coding** — deliberately not implemented; selective refetch covers
  the failure modes of this size class. If you ever need tolerance to whole
  chunks vanishing *without* retry, zfec (k=10, m=12) is the upgrade path.
- **A public host** — the server binds `127.0.0.1` by default. Deploy behind
  TLS if you expose it; the protocol assumes stable, absolute, HTTPS URLs.

## Sources

- `web_fetch` tool constraints (text/HTML/PDF only; URL must appear in prior
  context; rate limits) — <https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-fetch-tool>
- Claude Code WebFetch behavior (HTML→Markdown conversion; plain text passes
  through) — <https://code.claude.com/docs/en/tools-reference#webfetch-tool-behavior>
- Model transcription failure evidence — <https://github.com/anthropics/claude-code/issues/67684>
- Token-cost audits for base64 (~2–2.5 chars/token) —
  <https://llm4agents.com/blog/tokenizer-drift-402-quote-input-estimate-audit>
- Content-addressed transfer design (ANP Profile 7, x0x ADR 0055) —
  <https://agent-network-protocol.com/specs/1.1/message/attachments-object-transfer>
- Heredoc/base64 portability — <https://base64.dev/articles/base64-bash>
- Google Fonts / OFL — <https://github.com/google/fonts>
- Open Sauce Sans foundry — <https://github.com/marcologous/Open-Sauce-Fonts>
