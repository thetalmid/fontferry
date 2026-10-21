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
 *  - deterministic bytes: ETag = SHA-256 of the payload, long-lived cache.
 *  - no redirects, no auth, no HTML view; optional /web/ demo page.
 *  - binary originals under /fonts/ are served as font/woff2 for humans
 *    and browsers (agent fetch tools will typically reject those — by
 *    design, the text path is /chunks/).
 *
 * Usage: node serve.mjs [--port 8737] [--host 127.0.0.1] [--root ../out]
 *
 * HEAD/GET supported; safe path resolution; 404 as plain text.
 */

import { createServer } from 'node:http';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, resolve, normalize, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const PORT = parseInt(arg('--port', process.env.PORT || '8737'), 10);
const HOST = arg('--host', process.env.HOST || '127.0.0.1');
const ROOT = resolve(join(__dirname, '..', 'out'));

const MIME = {
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.html': 'text/html; charset=utf-8',
};

// payload SHA-256 cache (path -> hex)
const etagCache = new Map();
function etagFor(file) {
  if (etagCache.has(file)) return etagCache.get(file);
  const h = createHash('sha256').update(readFileSync(file)).digest('hex');
  etagCache.set(file, h);
  return h;
}

function send(req, res, status, body, type, file, extraHeaders) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const etag = file ? `"${etagFor(file)}"` : `"${createHash('sha256').update(buf).digest('hex')}"`;
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'ETag': etag,
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(buf);
}

const server = createServer((req, res) => {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    return send(req, res, 405, 'method not allowed\n', 'text/plain; charset=utf-8', null);
  }

  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (!urlPath.startsWith('/')) {
    return send(req, res, 400, 'bad request\n', 'text/plain; charset=utf-8', null);
  }

  // map URL → file under ROOT
  let file;
  if (urlPath === '/' || urlPath === '/index.txt') file = join(ROOT, 'ROOT.txt');
  else if (urlPath === '/web/' || urlPath === '/web/index.html') file = join(ROOT, '..', 'web', 'index.html');
  else {
    const rel = normalize(urlPath).replace(/^(\.\.[\\/])+/, '');
    file = join(ROOT, rel);
  }

  const resolved = resolve(file);
  if (!resolved.startsWith(resolve(ROOT)) && !resolved.startsWith(resolve(join(ROOT, '..', 'web')))) {
    return send(req, res, 403, 'forbidden\n', 'text/plain; charset=utf-8', null);
  }

  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    return send(req, res, 404, 'not found\n', 'text/plain; charset=utf-8', null);
  }

  const ext = extname(resolved).toLowerCase();
  const type = MIME[ext] || 'text/plain; charset=utf-8';

  if (method === 'HEAD') {
    const buf = readFileSync(resolved);
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'ETag': `"${etagFor(resolved)}"`,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end();
    return;
  }

  const body = readFileSync(resolved);
  send(req, res, 200, body, type, resolved);
});

server.listen(PORT, HOST, () => {
  console.log(`FontFerry listening on http://${HOST}:${PORT}/  (root: ${ROOT})`);
});
