'use strict';
const $ = (s, r = document) => r.querySelector(s);
const view = $('#view');
let me = null;
let pollTimer = null;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  const u = [[60, 'minute'], [3600, 'hour'], [86400, 'day'], [604800, 'week'], [2592000, 'month'], [31536000, 'year']];
  let best = ['second', 1, 1];
  for (const [n, name] of [[1, 'second'], ...u]) if (s >= n) best = [name, n];
  const v = Math.floor(s / best[1]);
  return `${v} ${best[0]}${v === 1 ? '' : 's'} ago`;
}
const dur = (s) => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
const views = (n) => `${n} view${n === 1 ? '' : 's'}`;
const avatar = (u, cls = '') => `<span class="av ${cls}" style="background:${esc(u.color)}">${esc((u.name || '?')[0].toUpperCase())}</span>`;

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}

async function api(path, opt = {}) {
  const init = { credentials: 'same-origin', ...opt };
  if (opt.json) { init.method = init.method || 'POST'; init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(opt.json); }
  const r = await fetch(path, init);
  if (r.status === 401 && path !== '/api/login') { me = null; showLogin(); throw new Error('login'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

// ---------- login ----------
function showLogin(msg = '') {
  document.body.className = 'login';
  document.title = 'Famtube';
  view.innerHTML = `<form class="login" id="lf">
    <span class="logo">▶</span><h1>Famtube</h1>
    <p style="margin:0;color:var(--mute)">Videos just for our family. New here? Pick a name and make your own password.</p>
    <input type="password" name="pin" placeholder="Family code" autocomplete="off" required>
    <input type="text" name="name" placeholder="Your name" value="${esc(lsGet('ft-name') || '')}" autocomplete="username" autocapitalize="words" maxlength="30" required>
    <input type="password" name="password" placeholder="Your password" autocomplete="current-password" minlength="4" required>
    <div class="err" id="err">${esc(msg)}</div>
    <button class="btn">Come on in</button></form>`;
  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target, btn = $('button', f); btn.disabled = true;
    try {
      const r = await api('/api/login', { json: { pin: f.pin.value, name: f.name.value, password: f.password.value } });
      lsSet('ft-name', r.user.name); me = r.user; boot();
    } catch (er) { $('#err').textContent = er.message; btn.disabled = false; }
  };
}

// ---------- cards ----------
function card(v, list = '') {
  const ready = v.status === 'ready';
  const badge = v.status === 'processing' ? '<span class="badge">Getting ready…</span>' : v.status === 'failed' ? '<span class="badge bad">Could not convert</span>' : '';
  return `<a class="card" href="#/watch/${v.id}${list ? '/' + list : ''}">
    <div class="thumb">${ready ? `<img loading="lazy" src="/media/${v.id}/thumb" alt="" onerror="this.remove()">` : ''}${badge}${ready && v.duration ? `<span class="dur">${dur(v.duration)}</span>` : ''}</div>
    <div class="meta">${avatar(v.owner)}<div><h3>${esc(v.title)}</h3><p>${esc(v.owner.name)} · ${views(v.views)} · ${ago(v.created)}</p></div></div></a>`;
}
function listHtml(list, empty, plId = '') {
  if (!list.length) return `<div class="empty"><b>${esc(empty[0])}</b>${esc(empty[1] || '')}</div>`;
  return `<div class="grid">${list.map((v) => card(v, plId)).join('')}</div>`;
}
function pollIfProcessing(list, reload) {
  clearTimeout(pollTimer);
  if (list.some((v) => v.status === 'processing')) pollTimer = setTimeout(reload, 4000);
}

// ---------- pages ----------
async function pageHome() {
  const list = await api('/api/videos');
  view.innerHTML = listHtml(list, ['No videos yet', 'Tap the + button to add the first one.']);
  pollIfProcessing(list, () => location.hash === '#/' && pageHome().catch(() => {}));
}

async function pageSearch() {
  view.innerHTML = `<div class="pad"><input type="search" id="q" placeholder="Search videos or people" autocomplete="off"></div><div id="res"></div>`;
  const q = $('#q'); let timer;
  const go = async () => {
    const term = q.value.trim();
    const list = await api('/api/videos?q=' + encodeURIComponent(term));
    $('#res').innerHTML = listHtml(list, [term ? 'Nothing found' : 'No videos yet', term ? 'Try another word.' : '']);
  };
  q.oninput = () => { clearTimeout(timer); timer = setTimeout(() => go().catch(() => {}), 250); };
  go();
}

function pageUpload() {
  view.innerHTML = `<form class="form" id="uf">
    <h1>Add a video</h1>
    <label class="pick"><b id="pn">Choose a video</b><span id="ps">From your camera roll or files</span>
      <input type="file" id="file" accept="video/*" hidden></label>
    <input type="text" id="title" placeholder="Title" maxlength="120">
    <textarea id="desc" rows="3" placeholder="Say something about it (optional)" maxlength="2000"></textarea>
    <div class="bar" hidden><div></div></div>
    <div class="err" id="err"></div>
    <button class="btn" id="go" disabled>Upload</button>
    <p style="color:var(--mute);font-size:13px;margin:0">If your signal drops, just choose the same video again and it carries on where it stopped. Long videos take a minute to get ready afterwards.</p></form>`;
  const file = $('#file'), go = $('#go');
  file.onchange = () => {
    const f = file.files[0]; if (!f) return;
    $('#pn').textContent = f.name; $('#ps').textContent = (f.size / 1048576).toFixed(0) + ' MB';
    if (!$('#title').value) $('#title').value = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 120);
    go.disabled = false;
  };
  $('#uf').onsubmit = async (e) => {
    e.preventDefault();
    const f = file.files[0]; if (!f) return;
    go.disabled = true; go.textContent = 'Uploading…';
    const bar = $('.bar'); bar.hidden = false; $('#err').textContent = '';
    let lock = null; try { if (navigator.wakeLock) lock = await navigator.wakeLock.request('screen'); } catch { /* optional */ }
    const meta = { title: $('#title').value.trim() || 'Untitled', desc: $('#desc').value };
    try {
      await uploadFile(f, meta, (done, note) => {
        const p = done / f.size * 100; $('div', bar).style.width = p + '%';
        go.textContent = note || `Uploading… ${Math.round(p)}%`;
      });
      toast('Uploaded! Getting it ready…'); location.hash = '#/';
    } catch (er) { $('#err').textContent = er.message; go.disabled = false; go.textContent = 'Try again (it picks up where it stopped)'; }
    finally { if (lock) lock.release().catch(() => {}); }
  };
}

// Chunked, resumable upload: survives flaky cellular, locked screens and even closing the app.
const CHUNK = 4 * 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function putChunk(id, offset, blob, onBytes) {
  return new Promise((resolve) => {
    const x = new XMLHttpRequest();
    x.open('PUT', `/api/uploads/${id}?offset=${offset}`);
    x.timeout = 120000;
    x.upload.onprogress = (e) => onBytes(offset + e.loaded);
    x.onload = () => { let data = {}; try { data = JSON.parse(x.responseText); } catch { /* ignore */ } resolve({ status: x.status, data }); };
    x.onerror = x.ontimeout = x.onabort = () => resolve({ status: 0, data: {} });
    x.send(blob);
  });
}
async function uploadFile(f, meta, onProgress) {
  const key = `ft-up:${me.id}:${f.name}:${f.size}:${f.lastModified}`;
  let id = lsGet(key) || '', offset = 0;
  if (id) { try { offset = (await api('/api/uploads/' + id)).offset; } catch (e) { if (e.message === 'login') throw e; id = ''; } }
  if (!id) { id = (await api('/api/uploads', { json: { size: f.size, type: f.type || 'video/mp4', ...meta } })).id; lsSet(key, id); }
  let fails = 0;
  while (offset < f.size) {
    onProgress(offset);
    const r = await putChunk(id, offset, f.slice(offset, Math.min(offset + CHUNK, f.size)), (n) => onProgress(n));
    if (r.status === 200 || r.status === 201) {
      fails = 0; offset = r.data.offset;
      if (r.data.done) { lsSet(key, ''); return r.data.video; }
    } else if (r.status === 401) { me = null; showLogin(); throw new Error('Please sign in again, then pick the video again.'); }
    else if (r.status === 404) { lsSet(key, ''); throw new Error('That upload expired. Try again.'); }
    else if (r.status === 413 || r.status === 415) { lsSet(key, ''); throw new Error(r.data.error || 'This video can not be uploaded.'); }
    else { // dropped connection, or the server and phone disagree about the offset: ask, then retry
      if (++fails > 10) throw new Error('Connection kept dropping. Try again when you have a better signal.');
      onProgress(offset, 'Connection lost. Retrying…');
      await sleep(Math.min(1500 * fails, 12000));
      if (typeof r.data.offset === 'number') offset = r.data.offset;
      else { try { offset = (await api('/api/uploads/' + id)).offset; } catch (e) { if (e.message === 'login') throw e; } }
    }
  }
}

// ---------- push notifications ----------
const b64uToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
async function pushSub() { const reg = await navigator.serviceWorker.ready; return { reg, sub: await reg.pushManager.getSubscription() }; }
async function pushOn() {
  if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications are blocked. Turn them on for Famtube in Settings → Notifications.');
  const { reg, sub } = await pushSub();
  const { key } = await api('/api/push/key');
  const s = sub || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(key) });
  await api('/api/push/subscribe', { json: s.toJSON() });
}
async function pushOff() {
  const { sub } = await pushSub();
  if (sub) { await api('/api/push/unsubscribe', { json: { endpoint: sub.endpoint } }).catch(() => {}); await sub.unsubscribe(); }
}
async function renderPushCard() {
  const el = $('#push'); if (!el) return;
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (!pushSupported()) {
    el.innerHTML = standalone ? 'This device does not support notifications.'
      : '<b>Want a buzz when someone adds a video?</b><br>Tap <b>Share</b> in Safari → <b>Add to Home Screen</b>, open Famtube from your Home Screen, then turn on notifications here.';
    return;
  }
  const { sub } = await pushSub();
  const on = !!sub && Notification.permission === 'granted';
  el.innerHTML = `<b>New video alerts</b><br>${on ? 'On for this phone.' : 'Get a notification when someone adds a video.'}<div style="margin-top:10px"><button class="btn sm ${on ? 'ghost' : ''}" id="pt">${on ? 'Turn off' : 'Turn on notifications'}</button></div>
    ${on ? `<div style="margin-top:12px;display:grid;gap:8px"><label><input type="checkbox" id="nv"> New videos</label><label><input type="checkbox" id="nc"> Comments on videos I'm part of</label></div>` : ''}`;
  if (on) {
    const prefs = (await api('/api/me')).notify;
    $('#nv').checked = prefs.videos; $('#nc').checked = prefs.comments;
    $('#nv').onchange = (e) => api('/api/me/notify', { json: { videos: e.target.checked } });
    $('#nc').onchange = (e) => api('/api/me/notify', { json: { comments: e.target.checked } });
  }
  $('#pt').onclick = async () => {
    try { on ? await pushOff() : await pushOn(); toast(on ? 'Notifications off' : 'Notifications on'); } catch (e) { toast(e.message); }
    renderPushCard();
  };
}
async function syncPush() { // keep this device's subscription tied to whoever is signed in
  try { if (pushSupported() && Notification.permission === 'granted') { const { sub } = await pushSub(); if (sub) await api('/api/push/subscribe', { json: sub.toJSON() }); } } catch { /* ignore */ }
}

// ---------- playlists ----------
function plRow(p) {
  return `<a class="pl" href="#/pl/${p.id}"><div class="pt">${p.cover ? `<img src="/media/${p.cover}/thumb" alt="" onerror="this.remove()">` : ''}</div>
    <div><b>${esc(p.name)}</b><br><small>${p.count} video${p.count === 1 ? '' : 's'} · ${esc(p.owner ? p.owner.name : '')}</small></div></a>`;
}
async function newPlaylist() {
  const name = prompt('Name your playlist (like "Summer trip")'); if (!name || !name.trim()) return null;
  return api('/api/playlists', { json: { name } });
}
async function savePicker(vid) {
  const pls = await api('/api/playlists');
  const d = document.createElement('div'); d.className = 'sheet';
  d.innerHTML = `<div class="box"><h3>Save to…</h3>${pls.map((p) => `<button data-id="${p.id}">${esc(p.name)} <small>${p.count}</small></button>`).join('')}
    <button data-new>＋ New playlist</button><button data-x class="x">Close</button></div>`;
  const close = () => d.remove();
  d.onclick = async (e) => {
    const b = e.target.closest('button');
    if (e.target === d || (b && 'x' in b.dataset)) return close();
    if (!b) return;
    try {
      let id = b.dataset.id;
      if ('new' in b.dataset) { const p = await newPlaylist(); if (!p) return; id = p.id; }
      await api(`/api/playlists/${id}/videos`, { json: { video: vid } }); close(); toast('Saved');
    } catch (er) { toast(er.message); }
  };
  document.body.append(d);
}
async function pagePlaylist(id) {
  const p = await api('/api/playlists/' + id);
  view.innerHTML = `<div class="pad"><h1>${esc(p.name)}</h1><p style="color:var(--mute);margin:0 0 12px">${p.count} video${p.count === 1 ? '' : 's'} · by ${esc(p.owner.name)}</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap">${p.videos.length ? `<a class="btn sm" href="#/watch/${p.videos.find((v) => v.status === 'ready') ? p.videos.find((v) => v.status === 'ready').id : p.videos[0].id}/${p.id}" style="display:inline-block">▶ Play all</a>` : ''}
    ${p.canManage ? '<button class="btn sm ghost" id="rn">Rename</button><button class="btn sm danger" id="dl">Delete playlist</button>' : ''}</div></div>
    ${listHtml(p.videos, ['Empty playlist', 'Open any video and tap Save to add it here.'], p.id)}
    ${p.canManage && p.videos.length ? '<div class="pad"><button class="btn sm ghost" id="rm">Remove a video…</button></div>' : ''}`;
  if (p.canManage) {
    $('#rn').onclick = async () => { const n = prompt('Playlist name', p.name); if (n && n.trim()) { await api('/api/playlists/' + id, { method: 'PATCH', json: { name: n } }); pagePlaylist(id); } };
    $('#dl').onclick = async () => { if (confirm('Delete this playlist? The videos stay.')) { await api('/api/playlists/' + id, { method: 'DELETE' }); location.hash = '#/library'; } };
    const rm = $('#rm');
    if (rm) rm.onclick = async () => {
      const n = prompt('Remove which video? Type its number:\n' + p.videos.map((v, i) => `${i + 1}. ${v.title}`).join('\n'));
      const v = p.videos[Number(n) - 1]; if (!v) return;
      await api(`/api/playlists/${id}/videos/${v.id}`, { method: 'DELETE' }); pagePlaylist(id);
    };
  }
}

async function pageLibrary() {
  const [mine, liked, pls, users] = await Promise.all([api('/api/videos?user=' + me.id), api('/api/videos?liked=1'), api('/api/playlists'), me.admin ? api('/api/users') : []]);
  view.innerHTML = `<div class="profile">${avatar(me, 'lg')}<h1>${esc(me.name)}</h1></div>
    <div class="tip" id="push"></div>
    <h2>Playlists</h2>${pls.length ? pls.map(plRow).join('') : '<div class="empty" style="padding:12px">No playlists yet.</div>'}
    <div class="pad"><button class="btn sm ghost" id="np">＋ New playlist</button></div>
    <h2>Your videos</h2>${listHtml(mine, ['Nothing yet', 'Videos you add will show up here.'])}
    <h2>Videos you liked</h2>${listHtml(liked, ['No likes yet', 'Tap the heart on a video.'])}
    ${me.admin ? `<h2>Family</h2><div class="chips">${users.map((u) => `<span class="chip">${esc(u.name)}${u.id === me.id ? '' : ` <a href="#" data-reset="${u.id}" data-n="${esc(u.name)}" style="color:var(--accent)">reset password</a>`}</span>`).join('')}</div>` : ''}
    <div class="pad" style="display:grid;gap:10px"><button class="btn ghost" id="pw">Change my password</button><button class="btn ghost" id="out">Switch person / log out</button></div>`;
  $('#np').onclick = async () => { const p = await newPlaylist(); if (p) pageLibrary(); };
  $('#pw').onclick = async () => {
    const current = prompt('Your current password'); if (current === null) return;
    const next = prompt('New password (at least 4 characters)'); if (!next) return;
    try { await api('/api/me/password', { json: { current, next } }); toast('Password changed'); } catch (e) { toast(e.message); }
  };
  $('#out').onclick = async () => { await pushOff().catch(() => {}); await api('/api/logout', { method: 'POST' }); me = null; showLogin(); };
  view.querySelectorAll('[data-reset]').forEach((a) => (a.onclick = async (e) => {
    e.preventDefault();
    if (confirm(`Reset ${a.dataset.n}'s password? They will choose a new one next time they sign in.`)) { await api(`/api/users/${a.dataset.reset}/reset-password`, { method: 'POST' }); toast('Password reset'); }
  }));
  renderPushCard();
  pollIfProcessing(mine, () => location.hash === '#/library' && pageLibrary().catch(() => {}));
}

async function pageChannel(id) {
  const [users, list] = await Promise.all([api('/api/users'), api('/api/videos?user=' + id)]);
  const u = users.find((x) => x.id === id);
  if (!u) return (view.innerHTML = '<div class="empty"><b>Not found</b></div>');
  view.innerHTML = `<div class="profile">${avatar(u, 'lg')}<h1>${esc(u.name)}</h1></div>${listHtml(list, ['No videos yet'])}`;
}

async function pageWatch(id, listId = '') {
  document.body.className = 'watching';
  let v;
  try { v = await api('/api/videos/' + id); } catch (e) {
    if (e.message === 'login') return;
    view.innerHTML = `<div class="empty"><b>${esc(e.message)}</b><a class="pill" href="#/">Back home</a></div>`; document.body.className = ''; return;
  }
  document.title = v.title;
  const ready = v.status === 'ready';
  view.innerHTML = `
    <div class="player"><button class="back" aria-label="Back" id="bk">‹</button>
    ${ready ? `<video id="v" src="/media/${v.id}" poster="/media/${v.id}/thumb" controls playsinline preload="metadata" webkit-playsinline></video>`
      : `<div class="status" style="margin:0;border-radius:0;padding:60px 16px;background:#111;color:#fff">${v.status === 'processing' ? 'Getting this video ready…<br><small>It will play here in a moment.</small>' : 'Sorry, this video could not be converted.'}</div>`}
    </div>
    <h1 class="wtitle">${esc(v.title)}</h1>
    <p class="wsub">${views(v.views)} · ${ago(v.created)}</p>
    <div class="row"><a class="who" href="#/u/${v.owner.id}">${avatar(v.owner)}<span>${esc(v.owner.name)}</span></a>
      <button class="pill ${v.liked ? 'on' : ''}" id="like">${v.liked ? '♥' : '♡'} <span>${v.likes}</span></button>
      <button class="pill" id="save">＋ Save</button><button class="pill" id="share">Share</button></div>
    ${v.desc ? `<div class="desc">${esc(v.desc)}</div>` : ''}
    ${v.canManage ? `<div class="row"><button class="pill" id="edit">Edit</button><button class="pill" id="del" style="color:var(--accent)">Delete</button></div>` : ''}
    <h2>Comments <span id="cc" style="color:var(--mute);font-weight:400">${v.comments}</span></h2>
    <form class="cform" id="cf"><input type="text" id="ct" placeholder="Add a comment…" maxlength="1000" autocomplete="off"><button class="btn sm">Post</button></form>
    <div id="cl"></div>
    <h2>Up next</h2><div id="up"></div>`;

  $('#bk').onclick = () => (history.length > 1 ? history.back() : (location.hash = '#/'));
  const nav = { next: '' };
  if (ready) setupPlayer(v, nav);
  $('#save').onclick = () => savePicker(v.id).catch((e) => toast(e.message));
  $('#like').onclick = async () => { const r = await api(`/api/videos/${v.id}/like`, { method: 'POST' }); $('#like').className = 'pill' + (r.liked ? ' on' : ''); $('#like').innerHTML = `${r.liked ? '♥' : '♡'} <span>${r.likes}</span>`; };
  $('#share').onclick = async () => {
    const url = location.origin + '/#/watch/' + v.id;
    try { if (navigator.share) return await navigator.share({ title: v.title, url }); await navigator.clipboard.writeText(url); toast('Link copied'); } catch { /* cancelled */ }
  };
  if (v.canManage) {
    $('#edit').onclick = async () => {
      const t = prompt('Title', v.title); if (t === null) return;
      const d = prompt('Description', v.desc || ''); if (d === null) return;
      await api('/api/videos/' + v.id, { method: 'PATCH', json: { title: t, desc: d } }); pageWatch(v.id);
    };
    $('#del').onclick = async () => {
      if (!confirm('Delete this video for everyone?')) return;
      await api('/api/videos/' + v.id, { method: 'DELETE' }); toast('Deleted'); location.hash = '#/';
    };
  }
  loadComments(v);
  $('#cf').onsubmit = async (e) => {
    e.preventDefault(); const t = $('#ct').value.trim(); if (!t) return;
    try { await api(`/api/videos/${v.id}/comments`, { json: { text: t } }); $('#ct').value = ''; loadComments(v); } catch (er) { toast(er.message); }
  };
  const upTitle = $('#view h2:last-of-type');
  (listId ? api('/api/playlists/' + listId).then((p) => ({ name: p.name, videos: p.videos })) : api('/api/videos').then((all) => ({ name: '', videos: all })))
    .then(({ name, videos }) => {
      const ready = videos.filter((x) => x.status === 'ready');
      const i = ready.findIndex((x) => x.id === v.id);
      const rest = listId && i >= 0 ? [...ready.slice(i + 1), ...ready.slice(0, i)] : ready.filter((x) => x.id !== v.id);
      if (listId && i >= 0 && i < ready.length - 1) nav.next = `#/watch/${ready[i + 1].id}/${listId}`;
      if (listId) upTitle.innerHTML = `${esc(name)} <span style="color:var(--mute);font-weight:400">${i + 1}/${ready.length}</span>`;
      $('#up').innerHTML = rest.length ? `<div class="grid">${rest.map((x) => card(x, listId)).join('')}</div>` : '<div class="empty">That is everything for now.</div>';
    }).catch(() => {});
  if (v.status === 'processing') pollTimer = setTimeout(() => location.hash.startsWith('#/watch/' + v.id) && pageWatch(v.id, listId), 4000);
}

function setupPlayer(v, nav) {
  const el = $('#v'), key = 'ft-pos-' + v.id;
  el.addEventListener('loadedmetadata', () => {
    const p = Number(lsGet(key)); if (p > 5 && p < el.duration - 5) el.currentTime = p;
  });
  let last = 0;
  el.addEventListener('timeupdate', () => { if (Date.now() - last > 3000) { last = Date.now(); lsSet(key, el.currentTime); } });
  el.addEventListener('ended', () => { lsSet(key, 0); if (nav.next) location.hash = nav.next; });
  let counted = false;
  el.addEventListener('playing', () => { if (counted) return; counted = true; setTimeout(() => api(`/api/videos/${v.id}/view`, { method: 'POST' }).catch(() => {}), 3000); });
}

async function loadComments(v) {
  const list = await api(`/api/videos/${v.id}/comments`);
  $('#cc').textContent = list.length;
  $('#cl').innerHTML = list.length ? list.map((c) => `<div class="cm">${avatar(c.user, 'sm')}<div><small><b>${esc(c.user.name)}</b> · ${ago(c.created)}</small><p>${esc(c.text)}</p>${c.mine || me.admin ? `<button data-c="${c.id}">Delete</button>` : ''}</div></div>`).join('')
    : '<div class="empty" style="padding:16px">Be the first to comment.</div>';
  $('#cl').querySelectorAll('button[data-c]').forEach((b) => (b.onclick = async () => { await api('/api/comments/' + b.dataset.c, { method: 'DELETE' }); loadComments(v); }));
}

// ---------- router ----------
async function route() {
  if (!me) return;
  clearTimeout(pollTimer);
  const h = location.hash.replace(/^#/, '') || '/';
  const [, a, b, c] = h.split('/');
  document.body.className = a === 'watch' ? 'watching' : '';
  document.title = 'Famtube';
  document.querySelectorAll('#tabs a').forEach((t) => t.classList.toggle('on', t.dataset.t === ({ '': 'home', search: 'search', upload: 'upload', library: 'library', u: 'library', pl: 'library' }[a] ?? 'home')));
  const reset = () => { if (a !== 'watch') window.scrollTo(0, 0); };
  try {
    if (a === 'watch') await pageWatch(b, c);
    else if (a === 'pl') await pagePlaylist(b);
    else if (a === 'u') await pageChannel(b);
    else if (a === 'search') await pageSearch();
    else if (a === 'upload') pageUpload();
    else if (a === 'library') await pageLibrary();
    else await pageHome();
    reset();
  } catch (e) { if (e.message !== 'login') view.innerHTML = `<div class="empty"><b>Oops</b>${esc(e.message)}</div>`; }
}

async function boot() {
  if (!me) { try { me = (await api('/api/me')).user; } catch { return; } }
  $('#me').innerHTML = avatar(me);
  route(); syncPush();
}
addEventListener('hashchange', route);
if ('serviceWorker' in navigator) navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.go) location.href = e.data.go; });
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
boot();
