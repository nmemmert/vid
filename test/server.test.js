'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const webpush = require('../push');
const { createServer } = require('../server');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'famtube-'));
const server = createServer({ dataDir, pin: 'secret', allowInsecurePush: true });
let base;
test.before(() => new Promise((r) => server.listen(0, () => { base = 'http://127.0.0.1:' + server.address().port; r(); })));
test.after(() => { server.flush(); server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

async function login(name, pin = 'secret', password = 'pass-' + name) {
  const r = await fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ name, pin, password }), headers: { 'content-type': 'application/json' } });
  return { r, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const call = (cookie, p, opt = {}) => fetch(base + p, { ...opt, headers: { cookie, 'content-type': 'application/json', ...(opt.headers || {}) } });

test('requires login and the family code', async () => {
  assert.strictEqual((await fetch(base + '/api/videos')).status, 401);
  assert.strictEqual((await login('Mom', 'nope')).r.status, 401);
  const { r, cookie } = await login('Mom');
  assert.strictEqual(r.status, 200);
  assert.ok((await call(cookie, '/api/me').then((x) => x.json())).user.admin, 'first person is admin');
});

test('upload, convert, stream with ranges, like, comment, delete', async (t) => {
  const mk = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=2', '-f', 'lavfi', '-i', 'sine=duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path.join(dataDir, 'in.mp4')]);
  if (mk.status !== 0 || !server.hasFfmpeg) return t.skip('ffmpeg not available');
  const { cookie } = await login('Dad');
  const body = fs.readFileSync(path.join(dataDir, 'in.mp4'));
  const up = await call(cookie, '/api/upload?title=Beach%20day', { method: 'POST', body, headers: { 'content-type': 'video/mp4' } });
  assert.strictEqual(up.status, 201);
  const v = await up.json();
  assert.strictEqual(v.status, 'processing');
  await server.idle();
  const ready = await call(cookie, '/api/videos/' + v.id).then((x) => x.json());
  assert.strictEqual(ready.status, 'ready');
  assert.ok(ready.duration >= 1);

  const ranged = await call(cookie, '/media/' + v.id, { headers: { range: 'bytes=0-99' } });
  assert.strictEqual(ranged.status, 206);
  assert.strictEqual((await ranged.arrayBuffer()).byteLength, 100);
  assert.strictEqual((await call(cookie, '/media/' + v.id + '/thumb')).status, 200);
  assert.strictEqual((await fetch(base + '/media/' + v.id)).status, 401);

  assert.strictEqual((await call(cookie, `/api/videos/${v.id}/like`, { method: 'POST' }).then((x) => x.json())).likes, 1);
  await call(cookie, `/api/videos/${v.id}/comments`, { method: 'POST', body: JSON.stringify({ text: 'Love it' }) });
  assert.strictEqual((await call(cookie, `/api/videos/${v.id}/comments`).then((x) => x.json())).length, 1);
  assert.strictEqual((await call(cookie, '/api/videos?q=beach').then((x) => x.json())).length, 1);
  assert.strictEqual((await call(cookie, '/api/videos?q=zzz').then((x) => x.json())).length, 0);

  const other = (await login('Kid')).cookie;
  assert.strictEqual((await call(other, '/api/videos/' + v.id, { method: 'DELETE' })).status, 403);
  assert.strictEqual((await call(cookie, '/api/videos/' + v.id, { method: 'DELETE' })).status, 200);
  assert.strictEqual((await call(cookie, '/api/videos').then((x) => x.json())).length, 0);
});

test('rejects non-video uploads', async () => {
  const { cookie } = await login('Mom');
  const r = await call(cookie, '/api/upload?title=x', { method: 'POST', body: 'hi', headers: { 'content-type': 'text/plain' } });
  assert.strictEqual(r.status, 415);
});

test('personal passwords: set on first login, enforced after, admin can reset', async () => {
  assert.strictEqual((await login('Gran', 'secret', 'abc')).r.status, 400, 'too short');
  assert.strictEqual((await login('Gran')).r.status, 200);
  const bad = await login('Gran', 'secret', 'wrong-one');
  assert.strictEqual(bad.r.status, 401);
  assert.strictEqual((await login('Gran')).r.status, 200);
  const admin = (await login('Mom')).cookie;
  const users = await call(admin, '/api/users').then((x) => x.json());
  const gran = users.find((u) => u.name === 'Gran');
  const gc = (await login('Gran')).cookie;
  assert.strictEqual((await call(gc, `/api/users/${gran.id}/reset-password`, { method: 'POST' })).status, 403);
  assert.strictEqual((await call(admin, `/api/users/${gran.id}/reset-password`, { method: 'POST' })).status, 200);
  assert.strictEqual((await call(gc, '/api/me')).status, 401, 'old sessions end on reset');
  assert.strictEqual((await login('Gran', 'secret', 'brand-new')).r.status, 200);
  const g2 = (await login('Gran', 'secret', 'brand-new')).cookie;
  assert.strictEqual((await call(g2, '/api/me/password', { method: 'POST', body: JSON.stringify({ current: 'nope', next: 'xxxx' }) })).status, 401);
  assert.strictEqual((await call(g2, '/api/me/password', { method: 'POST', body: JSON.stringify({ current: 'brand-new', next: 'xxxx' }) })).status, 200);
});

test('playlists: create, add, order, permissions, cleanup', async (t) => {
  const mom = (await login('Mom')).cookie, kid = (await login('Kid')).cookie;
  const pl = await call(mom, '/api/playlists', { method: 'POST', body: JSON.stringify({ name: 'Summer' }) }).then((x) => x.json());
  assert.strictEqual(pl.name, 'Summer');
  // a video can only be added if it exists
  assert.strictEqual((await call(kid, `/api/playlists/${pl.id}/videos`, { method: 'POST', body: JSON.stringify({ video: 'abcd' }) })).status, 404);
  assert.strictEqual((await call(kid, `/api/playlists/${pl.id}`, { method: 'DELETE' })).status, 403);
  assert.strictEqual((await call(kid, '/api/playlists').then((x) => x.json())).length, 1);
  assert.strictEqual((await call(mom, `/api/playlists/${pl.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Summer 2026' }) }).then((x) => x.json())).name, 'Summer 2026');
  assert.strictEqual((await call(mom, `/api/playlists/${pl.id}`, { method: 'DELETE' })).status, 200);
});

test('push: subscribe, encrypted delivery on new video, dead subscriptions pruned', async (t) => {
  if (!server.hasFfmpeg) return t.skip('needs ffmpeg');
  const mom = (await login('Mom')).cookie, dad = (await login('Dad')).cookie;
  const key = (await call(mom, '/api/push/key').then((x) => x.json())).key;
  assert.strictEqual(Buffer.from(key, 'base64url').length, 65);
  assert.strictEqual((await call(mom, '/api/push/subscribe', { method: 'POST', body: JSON.stringify({ endpoint: 'ftp://x', keys: { p256dh: 'a', auth: 'b' } }) })).status, 400);

  // pretend to be the browser's push service + keys
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys(); const auth = crypto.randomBytes(16);
  const got = []; let status = 201;
  const svc = http.createServer((req, res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => { got.push({ h: req.headers, body: Buffer.concat(c) }); res.writeHead(status); res.end(); }); });
  await new Promise((r) => svc.listen(0, r));
  const endpoint = `http://127.0.0.1:${svc.address().port}/push/1`;
  const keys = { p256dh: webpush.b64u(ua.getPublicKey()), auth: webpush.b64u(auth) };
  assert.strictEqual((await call(mom, '/api/push/subscribe', { method: 'POST', body: JSON.stringify({ endpoint, keys }) })).status, 201);

  const mk = path.join(dataDir, 'in2.mp4');
  spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1', '-pix_fmt', 'yuv420p', mk]);
  // Mom's own upload must not notify Mom
  await call(mom, '/api/upload?title=Mine', { method: 'POST', body: fs.readFileSync(mk), headers: { 'content-type': 'video/mp4' } });
  await server.idle();
  assert.strictEqual(got.length, 0);
  // Dad's upload notifies Mom
  await call(dad, '/api/upload?title=Fishing%20trip', { method: 'POST', body: fs.readFileSync(mk), headers: { 'content-type': 'video/mp4' } });
  await server.idle();
  assert.strictEqual(got.length, 1);
  const { h, body } = got[0];
  assert.match(h.authorization, /^vapid t=.+\..+\..+, k=/);
  assert.strictEqual(h['content-encoding'], 'aes128gcm');
  const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const hk = (s, i, info, l) => Buffer.from(crypto.hkdfSync('sha256', i, s, info, l));
  const prk = hk(auth, ua.computeSecret(asPub), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub]), 32);
  const d = crypto.createDecipheriv('aes-128-gcm', hk(salt, prk, Buffer.from('Content-Encoding: aes128gcm\0'), 16), hk(salt, prk, Buffer.from('Content-Encoding: nonce\0'), 12));
  d.setAuthTag(ct.subarray(-16));
  const msg = JSON.parse(Buffer.concat([d.update(ct.subarray(0, -16)), d.final()]).toString().replace(/\x02$/, ''));
  assert.strictEqual(msg.title, 'New video from Dad');
  assert.strictEqual(msg.body, 'Fishing trip');
  assert.match(msg.url, /^\/#\/watch\//);

  // a gone subscription (410) is removed
  status = 410;
  await call(dad, '/api/upload?title=Again', { method: 'POST', body: fs.readFileSync(mk), headers: { 'content-type': 'video/mp4' } });
  await server.idle();
  assert.strictEqual(got.length, 2);
  await call(dad, '/api/upload?title=Third', { method: 'POST', body: fs.readFileSync(mk), headers: { 'content-type': 'video/mp4' } });
  await server.idle();
  assert.strictEqual(got.length, 2, 'no more pushes after 410');
  svc.close();
});

test('resumable upload: chunks, resume after a drop, out-of-sync rejected', async (t) => {
  if (!server.hasFfmpeg) return t.skip('needs ffmpeg');
  const dad = (await login('Dad')).cookie, kid = (await login('Kid')).cookie;
  const f = path.join(dataDir, 'in3.mp4');
  spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10:duration=1', '-pix_fmt', 'yuv420p', f]);
  const data = fs.readFileSync(f), cut = Math.floor(data.length / 3);
  const start = await call(dad, '/api/uploads', { method: 'POST', body: JSON.stringify({ size: data.length, type: 'video/mp4', title: 'Chunky' }) });
  assert.strictEqual(start.status, 201);
  const { id } = await start.json();
  const put = (c, offset, body) => call(c, `/api/uploads/${id}?offset=${offset}`, { method: 'PUT', body, headers: { 'content-type': 'application/octet-stream' } });
  assert.strictEqual((await put(kid, 0, data.subarray(0, cut))).status, 404, "someone else's upload");
  const r1 = await put(dad, 0, data.subarray(0, cut));
  assert.strictEqual(r1.status, 200); assert.strictEqual((await r1.json()).offset, cut);
  // phone thinks nothing arrived and resends from 0: server says where it really is
  const bad = await put(dad, 0, data.subarray(0, cut));
  assert.strictEqual(bad.status, 409); assert.strictEqual((await bad.json()).offset, cut);
  assert.strictEqual((await call(dad, `/api/uploads/${id}`).then((x) => x.json())).offset, cut);
  assert.strictEqual((await put(dad, cut, data.subarray(cut, cut * 2))).status, 200);
  const last = await put(dad, cut * 2, data.subarray(cut * 2));
  assert.strictEqual(last.status, 201);
  const out = await last.json();
  assert.ok(out.done); assert.strictEqual(out.video.title, 'Chunky');
  await server.idle();
  assert.strictEqual((await call(dad, '/api/videos/' + out.video.id).then((x) => x.json())).status, 'ready');
  assert.strictEqual((await call(dad, `/api/uploads/${id}`)).status, 404, 'session closed');
  assert.strictEqual((await call(dad, '/api/uploads', { method: 'POST', body: JSON.stringify({ size: 10, type: 'text/plain' }) })).status, 415);
});

test('comment notifications go to the owner and other commenters, respect prefs', async (t) => {
  if (!server.hasFfmpeg) return t.skip('needs ffmpeg');
  const dad = (await login('Dad')).cookie, mom = (await login('Mom')).cookie, kid = (await login('Kid')).cookie;
  const got = {};
  const subscribe = async (name, cookie) => {
    const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
    const svc = http.createServer((req, res) => { req.resume(); req.on('end', () => { got[name] = (got[name] || 0) + 1; res.writeHead(201); res.end(); }); });
    await new Promise((r) => svc.listen(0, r));
    await call(cookie, '/api/push/subscribe', { method: 'POST', body: JSON.stringify({ endpoint: `http://127.0.0.1:${svc.address().port}/p`, keys: { p256dh: webpush.b64u(ua.getPublicKey()), auth: webpush.b64u(crypto.randomBytes(16)) } }) });
    return svc;
  };
  const svcs = [await subscribe('dad', dad), await subscribe('mom', mom), await subscribe('kid', kid)];
  // Dad's video; his own push subscription from earlier tests may exist, so count from here
  await call(dad, '/api/me/notify', { method: 'POST', body: JSON.stringify({ videos: false }) });
  const mk = path.join(dataDir, 'in3.mp4');
  const v = await call(dad, '/api/upload?title=Comments', { method: 'POST', body: fs.readFileSync(mk), headers: { 'content-type': 'video/mp4' } }).then((x) => x.json());
  await server.idle();
  for (const k of Object.keys(got)) got[k] = 0;
  const say = (c, text) => call(c, `/api/videos/${v.id}/comments`, { method: 'POST', body: JSON.stringify({ text }) });
  await say(mom, 'first!'); await server.idle();
  assert.strictEqual(got.dad, 1, 'owner hears about it'); assert.ok(!got.mom && !got.kid, 'author and bystanders do not');
  await say(kid, 'me too'); await server.idle();
  assert.strictEqual(got.dad, 2); assert.strictEqual(got.mom, 1, 'earlier commenter hears the next one');
  await call(mom, '/api/me/notify', { method: 'POST', body: JSON.stringify({ comments: false }) });
  await say(kid, 'again'); await server.idle();
  assert.strictEqual(got.mom, 1, 'opted out');
  assert.strictEqual((await call(mom, '/api/me').then((x) => x.json())).notify.comments, false);
  svcs.forEach((s) => s.close());
});
