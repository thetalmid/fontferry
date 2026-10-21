#!/usr/bin/env node
/**
 * FontFerry builder
 * --------------------
 * Produces, for each configured font, a verifiable plain-text delivery bundle:
 *   out/manifest.json          - machine-readable manifest (text/plain when served)
 *   out/manifest.txt           - byte-identical copy with .txt extension (safe on
 *                                static hosts that don't force text/plain)
 *   out/chunks/<id>/NNN.txt    - chunk pages: base64 wrapped at 76 cols, LF only,
 *                                header/footer lines, one chunk per file
 *   out/fonts/<id>.woff2       - original binary (human/browser downloads)
 *   out/rebuilt/<id>.woff2     - decoded from chunks by the builder itself (self-test)
 *   out/scripts/<id>.sh        - single-shot paste-ready heredoc script when the
 *                                base64 payload fits comfortably in one response
 *   out/licenses/              - OFL license texts (redistribution requirement)
 *   out/ROOT.txt               - human-readable index of the store
 *   web/index.html             - demo page with @font-face data: URIs
 *
 * Determinism: fixed chunk naming, sorted keys, stable output. Re-running the
 * builder with identical inputs yields identical bytes.
 *
 * Chunking model: chunks are BYTE ranges of the original file (multiples of 3
 * bytes so base64 groups stay aligned; each chunk is padded to %4 == 0).
 * Whole-file and per-chunk SHA-256 are computed on the binary bytes, so checks
 * are independent of line wrapping / whitespace.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'sources');
const OUT = join(ROOT, 'out');
const WEB = join(ROOT, 'web');

const LINE_WIDTH = 76;            // base64 columns per line (MIME standard)
const CHUNK_RAW_BYTES = 8190;     // multiple of 3, ≈ 8 KiB per chunk

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex').toUpperCase();

function b64wrap(buf) {
  const b64 = buf.toString('base64'); // no line breaks
  const lines = [];
  for (let i = 0; i < b64.length; i += LINE_WIDTH) lines.push(b64.slice(i, i + LINE_WIDTH));
  return lines; // LF joined on write
}

/** Slice a buffer into byte ranges aligned to multiples of 3. */
function chunkRanges(totalBytes) {
  const ranges = [];
  let start = 0;
  while (start < totalBytes) {
    const end = Math.min(start + CHUNK_RAW_BYTES, totalBytes);
    ranges.push([start, end]);
    start = end;
  }
  return ranges;
}

const fonts = [
  {
    id: 'chakra-petch-700',
    family: 'Chakra Petch',
    weight: 700,
    style: 'normal',
    subset: 'latin',
    sourceFile: 'chakra-latin.woff2',
    kind: 'copy',
    upstream: [{
      url: 'https://fonts.gstatic.com/s/chakrapetch/v13/cIflMapbsEk7TDLdtEz1BwkeJI91R5_F.woff2',
      note: 'Google Fonts gstatic v13 (latin subset)',
    }],
    license: {
      spdx: 'OFL-1.1',
      notice: 'Copyright 2018 The Chakra Petch Project Authors (https://github.com/m4rc1e/Chakra-Petch.git)',
      textFile: 'OFL-ChakraPetch.txt',
    },
    rebuildName: 'chakra-petch-700.woff2',
  },
  {
    id: 'open-sauce-sans-400',
    family: 'Open Sauce Sans',
    weight: 400,
    style: 'normal',
    subset: 'latin',
    ttf: 'oss-regular.ttf',
    kind: 'convert',
    upstream: [{
      url: 'https://raw.githubusercontent.com/marcologous/Open-Sauce-Fonts/master/fonts/ttf/OpenSauceSans-Regular.ttf',
      note: 'Open Sauce Sans foundry TTF v1.478 (OFL)',
    }],
    license: {
      spdx: 'OFL-1.1',
      notice: 'Copyright (c) 2020 The Open Sauce Sans Authors (https://github.com/marcologous/Open-Sauce-Fonts)',
      textFile: 'OFL-OpenSauceSans.txt',
    },
    rebuildName: 'open-sauce-sans-400.woff2',
  },
  {
    id: 'open-sauce-sans-600',
    family: 'Open Sauce Sans',
    weight: 600,
    style: 'normal',
    subset: 'latin',
    ttf: 'oss-semibold.ttf',
    kind: 'convert',
    upstream: [{
      url: 'https://raw.githubusercontent.com/marcologous/Open-Sauce-Fonts/master/fonts/ttf/OpenSauceSans-SemiBold.ttf',
      note: 'Open Sauce Sans foundry TTF v1.478 (OFL)',
    }],
    license: {
      spdx: 'OFL-1.1',
      notice: 'Copyright (c) 2020 The Open Sauce Sans Authors (https://github.com/marcologous/Open-Sauce-Fonts)',
      textFile: 'OFL-OpenSauceSans.txt',
    },
    rebuildName: 'open-sauce-sans-600.woff2',
  },
  {
    id: 'open-sauce-sans-700',
    family: 'Open Sauce Sans',
    weight: 700,
    style: 'normal',
    subset: 'latin',
    ttf: 'oss-bold.ttf',
    kind: 'convert',
    upstream: [{
      url: 'https://raw.githubusercontent.com/marcologous/Open-Sauce-Fonts/master/fonts/ttf/OpenSauceSans-Bold.ttf',
      note: 'Open Sauce Sans foundry TTF v1.478 (OFL)',
    }],
    license: {
      spdx: 'OFL-1.1',
      notice: 'Copyright (c) 2020 The Open Sauce Sans Authors (https://github.com/marcologous/Open-Sauce-Fonts)',
      textFile: 'OFL-OpenSauceSans.txt',
    },
    rebuildName: 'open-sauce-sans-700.woff2',
  },
];

async function loadWoff2(font) {
  if (font.kind === 'copy') {
    const p = join(SRC, font.sourceFile);
    if (!existsSync(p)) throw new Error(`missing source: ${p}`);
    const buf = readFileSync(p);
    if (buf.slice(0, 4).toString('latin1') !== 'wOF2') throw new Error(`not a WOFF2 (magic): ${p}`);
    return buf;
  }
  // convert foundry TTF -> WOFF2 with wawoff2 (Google woff2 wasm port)
  const ttfPath = join(SRC, font.ttf);
  if (!existsSync(ttfPath)) throw new Error(`missing TTF: ${ttfPath}`);
  const { compress } = await import('wawoff2');
  const ttf = readFileSync(ttfPath);
  const woff2 = Buffer.from(await compress(ttf));
  if (woff2.slice(0, 4).toString('latin1') !== 'wOF2') throw new Error(`conversion failed for ${font.ttf}`);
  return woff2;
}

function buildChunkPage(font, lines, idx, total, range, chunkSha) {
  const [start, end] = range;
  const header = `# fonttext/1 chunk ${idx}/${total} font=${font.id} sha256=${chunkSha} bytes=${end - start} range=${start}-${end - 1}`;
  const footer = `# end chunk ${idx}/${total}`;
  return [header, ...lines, footer].join('\n') + '\n';
}

function buildManifest(font, woff2, chunks, rebuildName) {
  const b64chars = Math.ceil(woff2.length / 3) * 4;
  const manifest = {
    protocol: 'fonttext/1',
    font_id: font.id,
    family: font.family,
    weight: font.weight,
    style: font.style,
    subset: font.subset,
    format: 'woff2',
    rebuilt_name: rebuildName,
    encoding: 'base64',
    line_width: LINE_WIDTH,
    newline: 'lf',
    chunk_raw_bytes: CHUNK_RAW_BYTES,
    whole_file_sha256: sha256(woff2),
    original_size_bytes: woff2.length,
    base64_chars: b64chars,
    chunks,
    upstream: font.upstream,
    license: {
      spdx: font.license.spdx,
      notice: font.license.notice,
      text_url: `/licenses/${font.license.textFile}`,
    },
  };
  return manifest;
}

function buildScript(font, woff2, rebuildName) {
  const b64 = woff2.toString('base64');
  const lines = [];
  for (let i = 0; i < b64.length; i += LINE_WIDTH) lines.push(b64.slice(i, i + LINE_WIDTH));
  const body = lines.join('\n');
  const sh = `#!/usr/bin/env bash
# FontFerry single-shot rebuild: ${font.id}
# source: ${font.upstream[0].url}
# decode: base64 -d (whitespace ignored) -> sha256 verification
set -eu
expected="${sha256(woff2)}"
out="${rebuildName}"
cat > "\${out}.b64" <<'EOF'
${body}
EOF
tr -d '[:space:]' < "\${out}.b64" | base64 -d > "\${out}"
rm -f "\${out}.b64"
actual=$(sha256sum "\${out}" | awk '{print toupper($1)}')
if [ "$actual" = "$expected" ]; then
  echo "OK \${out} sha256=\${actual}"
else
  echo "FAIL \${out} sha256=\${actual} expected=\${expected}" >&2
  exit 1
fi
`;
  return sh;
}

function buildDemoPage(fontsData) {
  const faces = fontsData.map((f) => {
    const dataUri = `data:font/woff2;base64,${f.woff2.toString('base64')}`;
    return `  @font-face {\n    font-family: '${f.font.family}';\n    font-weight: ${f.font.weight};\n    font-style: ${f.font.style};\n    src: url("${dataUri}") format("woff2");\n  }`;
  }).join('\n');
  const sample = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FontFerry demo</title>
<style>
${faces}
  body { font-family: system-ui, sans-serif; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; }
  h1, h2 { font-weight: 700; }
  .chakra { font-family: 'Chakra Petch', sans-serif; }
  .oss { font-family: 'Open Sauce Sans', sans-serif; }
  .w400 { font-weight: 400; } .w600 { font-weight: 600; } .w700 { font-weight: 700; }
  .card { border: 1px solid #ddd; border-radius: 8px; padding: 1rem 1.25rem; margin: 1rem 0; }
  .card h2 { margin: 0 0 .25rem; } .card small { color: #666; }
</style>
</head>
<body>
<h1>FontFerry · rendered from embedded data: URIs</h1>
<p>This page embeds the four WOFF2 fonts built by <code>builder/build.mjs</code> as
<code>data:font/woff2;base64,...</code> URIs. No external requests.</p>
<div class="card"><h2>Chakra Petch 700</h2><small>latin subset · OFL-1.1</small>
  <p class="chakra w700" style="font-size:1.6rem">The quick brown fox jumps over the lazy dog — 0123456789</p></div>
<div class="card"><h2>Open Sauce Sans 400</h2><small>latin · OFL-1.1</small>
  <p class="oss w400" style="font-size:1.4rem">The quick brown fox jumps over the lazy dog — 0123456789</p></div>
<div class="card"><h2>Open Sauce Sans 600</h2><small>latin · OFL-1.1</small>
  <p class="oss w600" style="font-size:1.4rem">The quick brown fox jumps over the lazy dog — 0123456789</p></div>
<div class="card"><h2>Open Sauce Sans 700</h2><small>latin · OFL-1.1</small>
  <p class="oss w700" style="font-size:1.4rem">The quick brown fox jumps over the lazy dog — 0123456789</p></div>
</body>
</html>
`;
  return sample;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  for (const d of ['chunks', 'fonts', 'rebuilt', 'scripts', 'licenses']) mkdirSync(join(OUT, d), { recursive: true });
  mkdirSync(WEB, { recursive: true });

  const allManifests = [];
  const fontsData = [];

  for (const font of fonts) {
    const woff2 = await loadWoff2(font);
    const whole = sha256(woff2);
    const ranges = chunkRanges(woff2.length);
    const fontDir = join(OUT, 'chunks', font.id);
    mkdirSync(fontDir, { recursive: true });

    const chunks = [];
    for (let i = 0; i < ranges.length; i++) {
      const [s, e] = ranges[i];
      const slice = woff2.subarray(s, e);
      const chunkSha = sha256(slice);
      const lines = b64wrap(slice);
      const page = buildChunkPage(font, lines, i, ranges.length, ranges[i], chunkSha);
      const fname = `${String(i).padStart(3, '0')}.txt`;
      writeFileSync(join(fontDir, fname), page, 'utf8');
      chunks.push({
        index: i,
        url: `/chunks/${font.id}/${fname}`,
        sha256: chunkSha,
        bytes: slice.length,
        first_byte: s,
        last_byte: e - 1,
        lines: lines.length + 2,
      });
    }

    const manifest = buildManifest(font, woff2, chunks, font.rebuildName);
    allManifests.push(manifest);
    fontsData.push({ font, woff2, manifest });

    // simple line-based reassembly manifest (parseable with pure bash, no jq)
    const simple = [
      '# FontFerry reassembly manifest — protocol fonttext/1',
      `# Font: ${font.id} (${font.family} ${font.weight})`,
      '# How to rebuild: place this file and every chunk file below in one dir, then',
      '#   sh rebuild.sh MANIFEST.txt <dir> <out.woff2>',
      `font_id=${font.id}`,
      'format=woff2',
      'encoding=base64',
      `line_width=${LINE_WIDTH}`,
      'newline=lf',
      `chunk_raw_bytes=${CHUNK_RAW_BYTES}`,
      `whole_file_sha256=${whole}`,
      `original_size_bytes=${woff2.length}`,
      `chunk_count=${chunks.length}`,
      ...chunks.map((c, i) => [
        `chunk_${i}_sha256=${c.sha256}`,
        `chunk_${i}_file=${String(i).padStart(3, '0')}.txt`,
      ].join('\n')),
      '',
    ].join('\n');
    writeFileSync(join(fontDir, 'MANIFEST.txt'), simple, 'utf8');

    // binary copies (human/browser paths)
    writeFileSync(join(OUT, 'fonts', font.id + '.woff2'), woff2);

    // self-test: decode chunks from disk and re-verify
    const parts = [];
    for (const c of chunks) {
      const text = readFileSync(join(OUT, 'chunks', font.id, c.url.split('/').pop()), 'utf8');
      const body = text.split('\n').filter((l) => !l.startsWith('# ')).join('');
      const dec = Buffer.from(body, 'base64');
      if (sha256(dec) !== c.sha256) throw new Error(`self-test chunk ${c.index} hash mismatch for ${font.id}`);
      parts.push(dec);
    }
    const rebuilt = Buffer.concat(parts);
    if (sha256(rebuilt) !== whole) throw new Error(`self-test whole-file hash mismatch for ${font.id}`);
    writeFileSync(join(OUT, 'rebuilt', font.rebuildName), rebuilt);

    // single-shot script (only when it fits a single web_fetch response comfortably)
    const b64chars = manifest.base64_chars;
    if (b64chars <= 16000) {
      writeFileSync(join(OUT, 'scripts', font.id + '.sh'), buildScript(font, woff2, font.rebuildName), 'utf8');
    }
  }

  // licenses
  for (const font of fonts) {
    copyFileSync(join(SRC, font.license.textFile), join(OUT, 'licenses', font.license.textFile));
  }

  // store-level manifest (index)
  const store = {
    protocol: 'fonttext/1',
    role: 'store-index',
    generated_utc: new Date().toISOString(),
    builder: 'builder/build.mjs',
    chunk_raw_bytes: CHUNK_RAW_BYTES,
    line_width: LINE_WIDTH,
    fonts: allManifests.map((m) => ({
      font_id: m.font_id,
      weight: m.weight,
      whole_file_sha256: m.whole_file_sha256,
      original_size_bytes: m.original_size_bytes,
      chunks: m.chunks.length,
      url: `/chunks/${m.font_id}/000.txt`,
      rebuilt_name: m.rebuilt_name,
    })),
  };

  writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(allManifests, null, 2) + '\n', 'utf8');
  writeFileSync(join(OUT, 'manifest.txt'), JSON.stringify(allManifests, null, 2) + '\n', 'utf8');
  writeFileSync(join(OUT, 'store.json'), JSON.stringify(store, null, 2) + '\n', 'utf8');
  writeFileSync(join(OUT, 'store.txt'), JSON.stringify(store, null, 2) + '\n', 'utf8');

  // per-font manifests (single-font URL for agents/fetch_sandbox.sh)
  const mDir = join(OUT, 'manifests');
  mkdirSync(mDir, { recursive: true });
  for (const m of allManifests) {
    const s = JSON.stringify(m, null, 2) + '\n';
    writeFileSync(join(mDir, m.font_id + '.json'), s, 'utf8');
    writeFileSync(join(mDir, m.font_id + '.txt'), s, 'utf8');
  }

  // human-readable root
  const lines = [
    'FontFerry store · protocol fonttext/1',
    '',
    `generated (UTC): ${store.generated_utc}`,
    `fonts: ${allManifests.length}`,
    '',
    ...allManifests.map((m) => {
      const c = m.chunks.length;
      return `- ${m.font_id} (${m.family} ${m.weight}) ${m.original_size_bytes} bytes · ${c} chunk${c === 1 ? '' : 's'} · sha256 ${m.whole_file_sha256} · rebuilt as ${m.rebuilt_name}`;
    }),
    '',
    'Consuming (agent, offline sandbox):',
    '  1. fetch /manifest.txt (or per-font /chunks/<id>/000.txt …) as plain text',
    '  2. save each chunk page verbatim to <dir>/<nnn>.txt',
    '  3. run  client/rebuild.sh <manifest.json> <dir> <out.woff2>',
    '',
    'Consuming (networked sandbox):',
    '  sh client/fetch_sandbox.sh <manifest-url> <out.woff2>',
    '',
    'Licenses: OFL-1.1 for every font (see /licenses/).',
  ];
  writeFileSync(join(OUT, 'ROOT.txt'), lines.join('\n') + '\n', 'utf8');

  // demo page
  writeFileSync(join(WEB, 'index.html'), buildDemoPage(fontsData), 'utf8');

  const summary = allManifests.map((m) => ({
    font_id: m.font_id,
    bytes: m.original_size_bytes,
    b64_chars: m.base64_chars,
    chunks: m.chunks.length,
    whole_file_sha256: m.whole_file_sha256,
  }));
  console.log(JSON.stringify({ ok: true, generated_utc: store.generated_utc, fonts: summary }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
