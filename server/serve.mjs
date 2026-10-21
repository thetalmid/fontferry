#!/usr/bin/env node
/**
 * FontFerry — plain-text delivery server (protocol fonttext/1)
 * ----------------------------------------------------------------
 * Serves the built store (`out/`) with semantics designed for agent fetch
 * tools (web_fetch-style):
 *
 *  - text/plain (never HTML) for every manifest, chunk page and license,
 *    so no HTML→Markdown conversion can mangle base64.
 *  - stable, content-addressed chunk URLs under /chunks/<font_id>/NNN.txt.
 *  - deterministic bytes: ETag = SHA-256 of the payload; long-lived cache
 *    on success only.
 *  - no redirects, no auth, no HTML view; optional /web/ demo page.
 *  - binary originals under /fonts/ are served as font/woff2 for humans
 *    and browsers (agent fetch tools will typically reject those — by
 *    design, the text path is /chunks/).
 *
 * Usage: node serve.mjs [--port 8737] [--host 127.0.0.1] [--root out]
 *        --root is absolute, or relative to the repo root (default: out).
 *
 * HEAD/GET supported (304 on If-None-Match); 400 on malformed URLs;
 * 403/404/405 as plain text; error responses are never cached.
 */

import { createServer } from 'node:http';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve, normalize, extname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const value = process.argv[i + 1];
  return (value === undefined || value.startsWith('--')) ? '' : value;
}

const PORT_RAW = arg('--port') ?? process.env.PORT ?? '8737';
const PORT = parseInt(PORT_RAW, 10);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  console.error(`serve: --port must be a port number (0-65535), got ${JSON.stringify(PORT_RAW)}`);
  process.exit(2);
}
const HOST = arg('--host') || process.env.HOST || '127.0.0.1';
const ROOT = resolve(join(__dirname, '..', arg('--root') || 'out'));
if (!existsSync(ROOT) || !statSync(ROOT).isDirectory()) {
  console.error(`serve: root does not exist or is not a directory: ${ROOT}`);
  process.exit(2);
}
const WEB_ROOT = resolve(join(ROOT, '..', 'web'));

const MIME = {
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.html': 'text/html; charset=utf-8',
};

const OK_CACHE = 'public, max-age=31536000, immutable';
const ERR_CACHE = 'no-store';

// payload SHA-256 cache (path -> hex); files are immutable while serving
const etagCache = new Map();

function sendText(req, res, status, body, extraHeaders) {
  const buf = Buffer.from(body, 'utf8');
  const etag = `"${createHash('sha256').update(buf).digest('hex')}"`;
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': ERR_CACHE,
    'ETag': etag,
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(buf);
}

const server = createServer((req, res) => {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    return sendText(req, res, 405, 'method not allowed\n', { Allow: 'GET, HEAD' });
  }

  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    return sendText(req, res, 400, 'bad request: malformed URL encoding\n');
  }
  if (!urlPath.startsWith('/')) {
    return sendText(req, res, 400, 'bad request\n');
  }

  // map URL → file under ROOT (or the bundled web demo)
  let file;
  if (urlPath === '/' || urlPath === '/index.txt') file = join(ROOT, 'ROOT.txt');
  else if (urlPath === '/web/' || urlPath === '/web/index.html') file = join(WEB_ROOT, 'index.html');
  else {
    const rel = normalize(urlPath).replace(/^(\.\.[\\/])+/, '');
    file = join(ROOT, rel);
  }

  const resolved = resolve(file);
  const insideRoot = resolved === ROOT || resolved.startsWith(ROOT + sep) || resolved.startsWith(ROOT + '/');
  const insideWeb = resolved === WEB_ROOT || resolved.startsWith(WEB_ROOT + sep) || resolved.startsWith(WEB_ROOT + '/');
  if (!insideRoot && !insideWeb) {
    return sendText(req, res, 403, 'forbidden\n');
  }

  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    return sendText(req, res, 404, 'not found\n');
  }

  const ext = extname(resolved).toLowerCase();
  const type = MIME[ext] || 'text/plain; charset=utf-8';

  const buf = readFileSync(resolved);
  let etag = etagCache.get(resolved);
  if (!etag) {
    etag = `"${createHash('sha256').update(buf).digest('hex')}"`;
    etagCache.set(resolved, etag);
  }

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, {
      ETag: etag,
      'Cache-Control': OK_CACHE,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end();
    return;
  }

  const headers = {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': OK_CACHE,
    'ETag': etag,
    'X-Content-Type-Options': 'nosniff',
  };
  if (method === 'HEAD') {
    res.writeHead(200, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  res.end(buf);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`serve: port ${PORT} already in use`);
  else console.error(e);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`FontFerry listening on http://${HOST}:${PORT}/  (root: ${ROOT})`);
});
