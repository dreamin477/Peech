'use strict';
// Server penerus (pass-through) tanpa dependensi.
// Tidak menyimpan API key apa pun: key milik pengunjung dikirim lewat header "x-dm-key" per permintaan,
// diteruskan ke DebridMaster, lalu dilupakan. Key tidak pernah ditulis ke log atau disk.
const http = require('http'), fs = require('fs'), path = require('path');

const PORT = +process.env.PORT || 3000, API = 'https://api.debridmaster.com';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const UUID = /^[0-9a-f-]{36}$/i, KEYRE = /^dm_live_[A-Za-z0-9]{16,128}$/;
const hits = new Map(); // batas submit per IP

function send(res, status, obj, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(obj));
}
const fail = (res, status, code, message, extra) => send(res, status, { error: { code, message } }, extra);

async function dm(key, method, p, body) {
  const r = await fetch(API + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  let json = null; try { json = await r.json(); } catch {}
  return { status: r.status, json, retry: r.headers.get('retry-after') };
}
const fwd = (res, r) => send(res, r.status, r.json ?? { error: { code: 'internal', message: 'Respons tidak valid dari DebridMaster.' } }, r.retry ? { 'Retry-After': r.retry } : {});

function readBody(req) {
  return new Promise((ok, no) => {
    let s = ''; req.on('data', c => { s += c; if (s.length > 20000) { no(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { no(e); } });
  });
}

let hostCache = { at: 0, data: null };

async function api(req, res, url) {
  const p = url.pathname.replace(/^\/api/, '');

  if (p === '/hosts' && req.method === 'GET') { // publik, tanpa key
    if (!hostCache.data || Date.now() - hostCache.at > 5 * 60 * 1000) {
      const r = await dm(null, 'GET', '/v1/hosts');
      if (r.status === 200) hostCache = { at: Date.now(), data: r.json }; else return fwd(res, r);
    }
    return send(res, 200, hostCache.data);
  }

  const key = String(req.headers['x-dm-key'] || '').trim();
  if (!KEYRE.test(key)) return fail(res, 401, 'unauthorized', 'API key belum diisi atau formatnya salah.');

  if (p === '/account' && req.method === 'GET') return fwd(res, await dm(key, 'GET', '/v1/account'));

  if (p === '/unrestrict' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || 'x', now = Date.now();
    const arr = (hits.get(ip) || []).filter(t => now - t < 60000);
    if (arr.length >= 30) return fail(res, 429, 'rate_limited', 'Terlalu banyak permintaan. Coba lagi sebentar.', { 'Retry-After': '10' });
    arr.push(now); hits.set(ip, arr);
    const b = await readBody(req);
    let u; try { u = new URL(b.link); } catch {}
    if (!u || !/^https?:$/.test(u.protocol) || String(b.link).length > 2048) return fail(res, 400, 'invalid_link', 'Link tidak valid.');
    const payload = { link: String(b.link) };
    if (b.free === true) payload.free = true;
    return fwd(res, await dm(key, 'POST', '/v1/unrestrict', payload));
  }

  const m = p.match(/^\/unrestrict\/([^/]+)$/);
  if (m && req.method === 'GET') {
    if (!UUID.test(m[1])) return fail(res, 400, 'invalid_id', 'ID tidak valid.');
    return fwd(res, await dm(key, 'GET', '/v1/unrestrict/' + m[1]));
  }

  if (p === '/history' && req.method === 'GET') {
    const page = Math.max(1, parseInt(url.searchParams.get('page')) || 1);
    return fwd(res, await dm(key, 'GET', `/v1/unrestrict?page=${page}&per_page=20`));
  }
  return fail(res, 404, 'not_found', 'Endpoint tidak ditemukan.');
}

http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const root = path.join(__dirname, 'public');
    const f = path.normalize(path.join(root, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
    fs.readFile(f, (e, d) => {
      if (e) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      res.end(d);
    });
  } catch (e) {
    if (!res.headersSent) fail(res, 502, 'upstream_error', 'Gagal menghubungi DebridMaster.');
  }
}).listen(PORT, () => console.log(`Leech site berjalan di http://localhost:${PORT}`));
