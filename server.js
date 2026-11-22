'use strict';
// Famtube: private family video server. No dependencies; uses ffmpeg (if present) to
// convert iPhone uploads to universally playable H.264 and to make thumbnails.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { Transform, pipeline } = require('stream');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const rid = (n = 6) => crypto.randomBytes(n).toString('hex');
const COLORS = ['#e5484d', '#e5793a', '#d6a216', '#30a46c', '#12a594', '#3e63dd', '#8e4ec6', '#d6409f'];

function createServer(opts = {}) {
  const DATA_DIR = opts.dataDir || process.env.DATA_DIR || path.join(__dirname, 'data');
  const FAMILY_PIN = String(opts.pin || process.env.FAMILY_PIN || '1234');
  const MAX_BYTES = (Number(opts.maxUploadMb || process.env.MAX_UPLOAD_MB) || 4096) * 1024 * 1024;
  const TRUST_PROXY = !!(opts.trustProxy ?? process.env.TRUST_PROXY);
  const FFMPEG = opts.ffmpeg !== undefined ? opts.ffmpeg
    : (spawnSync('ffmpeg', ['-version']).status === 0 ? 'ffmpeg' : null);
  const FFPROBE = FFMPEG && spawnSync('ffprobe', ['-version']).status === 0 ? 'ffprobe' : null;
  const PUBLIC = path.join(__dirname, 'public');

  const dirs = { media: path.join(DATA_DIR, 'videos'), thumbs: path.join(DATA_DIR, 'thumbs'), tmp: path.join(DATA_DIR, 'tmp') };
  Object.values(dirs).forEach((d) => fs.mkdirSync(d, { recursive: true }));
  for (const f of fs.readdirSync(dirs.tmp)) fs.rmSync(path.join(dirs.tmp, f), { force: true });

  // ---------- tiny JSON database ----------
  const dbFile = path.join(DATA_DIR, 'db.json');
  let db;
  try { db = JSON.parse(fs.readFileSync(dbFile, 'utf8')); } catch { db = {}; }
  db.users ||= []; db.sessions ||= {}; db.videos ||= []; db.comments ||= [];
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 150);
  }
  function flush() {
    clearTimeout(saveTimer);
    fs.writeFileSync(dbFile + '.tmp', JSON.stringify(db));
    fs.renameSync(dbFile + '.tmp', dbFile);
  }

  // ---------- helpers ----------
  const send = (res, code, body, headers = {}) => {
    const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
    res.writeHead(code, { 'Content-Type': isObj ? 'application/json' : 'text/plain', 'Cache-Control': 'no-store', ...headers });
    res.end(isObj ? JSON.stringify(body) : body);
  };
  const readJson = (req, limit = 65536) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
  const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  const clientIp = (req) => (TRUST_PROXY && req.headers['x-forwarded-for']) ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress;
  const userFromReq = (req) => {
    const t = cookies(req).ft;
    const s = t && db.sessions[sha(t)];
    return s ? db.users.find((u) => u.id === s.user) : null;
  };
  const pubUser = (u) => u && { id: u.id, name: u.name, color: u.color, admin: !!u.admin };

  const fails = new Map(); // ip -> {n, until}
  function tooManyFails(ip) { const f = fails.get(ip); return f && f.n >= 8 && f.until > Date.now(); }
  function noteFail(ip) { const f = fails.get(ip) || { n: 0 }; f.n++; f.until = Date.now() + 15 * 60 * 1000; fails.set(ip, f); }

  const commentCount = (id) => db.comments.filter((c) => c.video === id).length;
  function shapeVideo(v, me) {
    const owner = db.users.find((u) => u.id === v.owner);
    return {
      id: v.id, title: v.title, desc: v.desc, status: v.status, duration: v.duration, views: v.views,
      created: v.created, owner: pubUser(owner) || { id: v.owner, name: 'Someone', color: '#888' },
      likes: v.likes.length, liked: v.likes.includes(me.id), comments: commentCount(v.id),
      mine: v.owner === me.id, canManage: v.owner === me.id || !!me.admin,
    };
  }
  const visible = (v, me) => v.status === 'ready' || v.owner === me.id || me.admin;
  const removeFiles = (id) => {
    for (const f of [path.join(dirs.media, id + '.mp4'), path.join(dirs.media, id + '.mov'), path.join(dirs.thumbs, id + '.jpg')]) fs.rmSync(f, { force: true });
  };

  // ---------- video processing (one at a time) ----------
  const queue = []; let working = false;
  const run = (cmd, args) => new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', reject);
    p.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(err || 'exit ' + code)));
  });
  async function process1(job) {
    const v = db.videos.find((x) => x.id === job.id);
    if (!v) return fs.rmSync(job.src, { force: true });
    const out = path.join(dirs.media, v.id + '.mp4'), thumb = path.join(dirs.thumbs, v.id + '.jpg');
    try {
      await run(FFMPEG, ['-y', '-i', job.src, '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', "scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out]);
      if (FFPROBE) v.duration = Math.round(parseFloat(await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', out])) || 0);
      await run(FFMPEG, ['-y', '-ss', String(Math.min(1, (v.duration || 2) / 2)), '-i', out, '-frames:v', '1', '-vf', 'scale=640:-2', thumb]).catch(() => {});
      v.size = fs.statSync(out).size; v.status = 'ready';
    } catch (e) {
      v.status = 'failed'; v.error = String(e.message).slice(-300);
    }
    fs.rmSync(job.src, { force: true });
    save();
  }
  async function pump() {
    if (working) return; working = true;
    while (queue.length) await process1(queue.shift());
    working = false;
  }
  const idle = () => new Promise((r) => { const t = setInterval(() => { if (!working && !queue.length) { clearInterval(t); r(); } }, 20); });

  // ---------- handlers ----------
  async function upload(req, res, me, q) {
    const type = (req.headers['content-type'] || '').toLowerCase();
    if (!type.startsWith('video/') && !type.startsWith('application/octet-stream')) return send(res, 415, { error: 'That is not a video file.' });
    const len = Number(req.headers['content-length'] || 0);
    if (len > MAX_BYTES) return send(res, 413, { error: 'That video is too big for this server.' });
    const id = rid(5);
    const ext = type.includes('quicktime') ? '.mov' : '.mp4';
    const tmp = path.join(dirs.tmp, id + '.src');
    let seen = 0;
    const counter = new Transform({ transform(chunk, _e, cb) { seen += chunk.length; cb(seen > MAX_BYTES ? new Error('too big') : null, chunk); } });
    pipeline(req, counter, fs.createWriteStream(tmp), (err) => {
      if (err || seen === 0) { fs.rmSync(tmp, { force: true }); return send(res, err ? 413 : 400, { error: err ? 'Upload failed or was too big.' : 'Empty upload.' }); }
      const v = {
        id, title: String(q.get('title') || 'Untitled').trim().slice(0, 120) || 'Untitled', desc: String(q.get('desc') || '').trim().slice(0, 2000),
        owner: me.id, created: Date.now(), status: 'processing', duration: 0, views: 0, likes: [], size: seen,
      };
      db.videos.push(v);
      if (FFMPEG) { queue.push({ id, src: tmp }); pump(); }
      else { fs.renameSync(tmp, path.join(dirs.media, id + ext)); v.status = 'ready'; v.ext = ext; }
      save();
      send(res, 201, shapeVideo(v, me));
    });
  }

  function serveMedia(req, res, v, kind) {
    if (kind === 'thumb') {
      const f = path.join(dirs.thumbs, v.id + '.jpg');
      if (!fs.existsSync(f)) return send(res, 404, 'no thumb');
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
      return fs.createReadStream(f).pipe(res);
    }
    const ext = v.ext || '.mp4';
    const f = path.join(dirs.media, v.id + ext);
    if (v.status !== 'ready' || !fs.existsSync(f)) return send(res, 404, 'not ready');
    const size = fs.statSync(f).size;
    const type = ext === '.mov' ? 'video/quicktime' : 'video/mp4';
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      let start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
      let end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
      if (start < 0) start = 0;
      if (start >= size || start > end) return send(res, 416, 'bad range', { 'Content-Range': `bytes */${size}` });
      res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, 'Cache-Control': 'private, max-age=3600' });
      return fs.createReadStream(f, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': size, 'Cache-Control': 'private, max-age=3600' });
    fs.createReadStream(f).pipe(res);
  }

  function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? '/index.html' : pathname;
    const f = path.normalize(path.join(PUBLIC, rel));
    if (!f.startsWith(PUBLIC + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(res, 404, 'not found');
    const noCache = /\/(sw\.js|index\.html)$/.test(f);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600' });
    fs.createReadStream(f).pipe(res);
  }

  async function api(req, res, url) {
    const p = url.pathname, q = url.searchParams, M = req.method;
    const secure = (req.headers['x-forwarded-proto'] || '') === 'https';

    if (p === '/api/ping') return send(res, 200, { ok: true });
    if (p === '/api/login' && M === 'POST') {
      const ip = clientIp(req);
      if (tooManyFails(ip)) return send(res, 429, { error: 'Too many wrong tries. Wait a few minutes.' });
      const b = await readJson(req);
      const a = crypto.createHash('sha256').update(String(b.pin || '')).digest(), c = crypto.createHash('sha256').update(FAMILY_PIN).digest();
      if (!crypto.timingSafeEqual(a, c)) { noteFail(ip); return send(res, 401, { error: 'That family code is not right.' }); }
      fails.delete(ip);
      const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 30);
      if (!name) return send(res, 400, { error: 'Type your name.' });
      let u = db.users.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!u) {
        u = { id: rid(4), name, color: COLORS[db.users.length % COLORS.length], admin: db.users.length === 0, created: Date.now() };
        db.users.push(u);
      }
      const token = rid(24);
      db.sessions[sha(token)] = { user: u.id, created: Date.now() };
      save();
      return send(res, 200, { user: pubUser(u) }, { 'Set-Cookie': `ft=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? '; Secure' : ''}` });
    }

    const me = userFromReq(req);
    if (!me) return send(res, 401, { error: 'login' });

    if (p === '/api/me' && M === 'GET') return send(res, 200, { user: pubUser(me) });
    if (p === '/api/logout' && M === 'POST') {
      delete db.sessions[sha(cookies(req).ft)]; save();
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'ft=; Path=/; Max-Age=0' });
    }
    if (p === '/api/users') return send(res, 200, db.users.map(pubUser));
    if (p === '/api/upload' && M === 'POST') return upload(req, res, me, q);

    if (p === '/api/videos' && M === 'GET') {
      const term = (q.get('q') || '').toLowerCase().trim();
      let list = db.videos.filter((v) => visible(v, me));
      if (q.get('user')) list = list.filter((v) => v.owner === q.get('user'));
      if (q.get('liked')) list = list.filter((v) => v.likes.includes(me.id));
      if (term) list = list.filter((v) => (v.title + ' ' + v.desc + ' ' + (db.users.find((u) => u.id === v.owner) || {}).name).toLowerCase().includes(term));
      list.sort((a, b) => b.created - a.created);
      return send(res, 200, list.slice(0, 300).map((v) => shapeVideo(v, me)));
    }

    let m = /^\/api\/videos\/([a-f0-9]+)(?:\/(view|like|comments))?$/.exec(p);
    if (m) {
      const v = db.videos.find((x) => x.id === m[1]);
      if (!v || !visible(v, me)) return send(res, 404, { error: 'Video not found.' });
      const sub = m[2];
      if (!sub && M === 'GET') return send(res, 200, shapeVideo(v, me));
      if (!sub && M === 'PATCH') {
        if (v.owner !== me.id && !me.admin) return send(res, 403, { error: 'Not yours.' });
        const b = await readJson(req);
        if (typeof b.title === 'string' && b.title.trim()) v.title = b.title.trim().slice(0, 120);
        if (typeof b.desc === 'string') v.desc = b.desc.trim().slice(0, 2000);
        save(); return send(res, 200, shapeVideo(v, me));
      }
      if (!sub && M === 'DELETE') {
        if (v.owner !== me.id && !me.admin) return send(res, 403, { error: 'Not yours.' });
        db.videos = db.videos.filter((x) => x !== v);
        db.comments = db.comments.filter((c) => c.video !== v.id);
        removeFiles(v.id); save(); return send(res, 200, { ok: true });
      }
      if (sub === 'view' && M === 'POST') { v.views++; save(); return send(res, 200, { views: v.views }); }
      if (sub === 'like' && M === 'POST') {
        v.likes = v.likes.includes(me.id) ? v.likes.filter((x) => x !== me.id) : [...v.likes, me.id];
        save(); return send(res, 200, shapeVideo(v, me));
      }
      if (sub === 'comments' && M === 'GET') {
        return send(res, 200, db.comments.filter((c) => c.video === v.id).sort((a, b) => b.created - a.created)
          .map((c) => ({ id: c.id, text: c.text, created: c.created, user: pubUser(db.users.find((u) => u.id === c.user)) || { name: 'Someone', color: '#888' }, mine: c.user === me.id })));
      }
      if (sub === 'comments' && M === 'POST') {
        const text = String((await readJson(req)).text || '').trim().slice(0, 1000);
        if (!text) return send(res, 400, { error: 'Write something first.' });
        const c = { id: rid(4), video: v.id, user: me.id, text, created: Date.now() };
        db.comments.push(c); save();
        return send(res, 201, { id: c.id, text, created: c.created, user: pubUser(me), mine: true });
      }
    }
    m = /^\/api\/comments\/([a-f0-9]+)$/.exec(p);
    if (m && M === 'DELETE') {
      const c = db.comments.find((x) => x.id === m[1]);
      if (!c) return send(res, 404, { error: 'Gone.' });
      if (c.user !== me.id && !me.admin) return send(res, 403, { error: 'Not yours.' });
      db.comments = db.comments.filter((x) => x !== c); save();
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'Not found' });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      const m = /^\/media\/([a-f0-9]+)(?:\/(thumb))?$/.exec(url.pathname);
      if (m) {
        const me = userFromReq(req);
        if (!me) return send(res, 401, 'login');
        const v = db.videos.find((x) => x.id === m[1]);
        if (!v || !visible(v, me)) return send(res, 404, 'not found');
        return serveMedia(req, res, v, m[2]);
      }
      return serveStatic(req, res, decodeURIComponent(url.pathname));
    } catch (e) {
      if (!res.headersSent) send(res, 400, { error: e.message });
    }
  });
  server.flush = flush; server.idle = idle; server.hasFfmpeg = !!FFMPEG;
  return server;
}

module.exports = { createServer };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const s = createServer();
  if (!process.env.FAMILY_PIN) console.warn('WARNING: FAMILY_PIN not set, using the default 1234. Set it!');
  if (!s.hasFfmpeg) console.warn('ffmpeg not found: videos are stored as uploaded (no thumbnails or conversion).');
  s.listen(port, () => console.log(`Famtube on :${port}`));
  const bye = () => { s.flush(); process.exit(0); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
}
