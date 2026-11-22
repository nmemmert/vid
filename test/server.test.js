'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createServer } = require('../server');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'famtube-'));
const server = createServer({ dataDir, pin: 'secret' });
let base;
test.before(() => new Promise((r) => server.listen(0, () => { base = 'http://127.0.0.1:' + server.address().port; r(); })));
test.after(() => { server.flush(); server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

async function login(name, pin = 'secret') {
  const r = await fetch(base + '/api/login', { method: 'POST', body: JSON.stringify({ name, pin }), headers: { 'content-type': 'application/json' } });
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
