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
    <p style="margin:0;color:var(--mute)">Videos just for our family. Type the family code and your name.</p>
    <input type="password" name="pin" placeholder="Family code" autocomplete="current-password" required>
    <input type="text" name="name" placeholder="Your name" value="${esc(lsGet('ft-name') || '')}" autocomplete="given-name" autocapitalize="words" maxlength="30" required>
    <div class="err" id="err">${esc(msg)}</div>
    <button class="btn">Come on in</button></form>`;
  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target, btn = $('button', f); btn.disabled = true;
    try {
      const r = await api('/api/login', { json: { pin: f.pin.value, name: f.name.value } });
      lsSet('ft-name', r.user.name); me = r.user; boot();
    } catch (er) { $('#err').textContent = er.message; btn.disabled = false; }
  };
}

// ---------- cards ----------
function card(v) {
  const ready = v.status === 'ready';
  const badge = v.status === 'processing' ? '<span class="badge">Getting ready…</span>' : v.status === 'failed' ? '<span class="badge bad">Could not convert</span>' : '';
  return `<a class="card" href="#/watch/${v.id}">
    <div class="thumb">${ready ? `<img loading="lazy" src="/media/${v.id}/thumb" alt="" onerror="this.remove()">` : ''}${badge}${ready && v.duration ? `<span class="dur">${dur(v.duration)}</span>` : ''}</div>
    <div class="meta">${avatar(v.owner)}<div><h3>${esc(v.title)}</h3><p>${esc(v.owner.name)} · ${views(v.views)} · ${ago(v.created)}</p></div></div></a>`;
}
function listHtml(list, empty) {
  if (!list.length) return `<div class="empty"><b>${esc(empty[0])}</b>${esc(empty[1] || '')}</div>`;
  return `<div class="grid">${list.map(card).join('')}</div>`;
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
    <p style="color:var(--mute);font-size:13px;margin:0">Keep this screen open until it finishes. Long videos take a minute to get ready afterwards.</p></form>`;
  const file = $('#file'), go = $('#go');
  file.onchange = () => {
    const f = file.files[0]; if (!f) return;
    $('#pn').textContent = f.name; $('#ps').textContent = (f.size / 1048576).toFixed(0) + ' MB';
    if (!$('#title').value) $('#title').value = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 120);
    go.disabled = false;
  };
  $('#uf').onsubmit = (e) => {
    e.preventDefault();
    const f = file.files[0]; if (!f) return;
    go.disabled = true; go.textContent = 'Uploading…';
    const bar = $('.bar'); bar.hidden = false;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload?title=' + encodeURIComponent($('#title').value.trim() || 'Untitled') + '&desc=' + encodeURIComponent($('#desc').value));
    xhr.setRequestHeader('Content-Type', f.type || 'video/mp4');
    xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) { const p = ev.loaded / ev.total * 100; $('div', bar).style.width = p + '%'; go.textContent = `Uploading… ${Math.round(p)}%`; } };
    xhr.onload = () => {
      let d = {}; try { d = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status === 201) { toast('Uploaded! Getting it ready…'); location.hash = '#/'; }
      else { $('#err').textContent = d.error || 'Upload failed.'; go.disabled = false; go.textContent = 'Try again'; }
    };
    xhr.onerror = () => { $('#err').textContent = 'Connection lost. Try again.'; go.disabled = false; go.textContent = 'Try again'; };
    xhr.send(f);
  };
}

async function pageLibrary() {
  const [mine, liked] = await Promise.all([api('/api/videos?user=' + me.id), api('/api/videos?liked=1')]);
  view.innerHTML = `<div class="profile">${avatar(me, 'lg')}<h1>${esc(me.name)}</h1></div>
    <h2>Your videos</h2>${listHtml(mine, ['Nothing yet', 'Videos you add will show up here.'])}
    <h2>Videos you liked</h2>${listHtml(liked, ['No likes yet', 'Tap the heart on a video.'])}
    <div class="tip" id="tip"></div>
    <div class="pad"><button class="btn ghost" id="out">Switch person / log out</button></div>`;
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  $('#tip').innerHTML = standalone ? 'Famtube is installed on your Home Screen. 🎉'
    : 'Tip: tap the <b>Share</b> button in Safari, then <b>Add to Home Screen</b> to use Famtube like a real app.';
  $('#out').onclick = async () => { await api('/api/logout', { method: 'POST' }); me = null; showLogin(); };
  pollIfProcessing(mine, () => location.hash === '#/library' && pageLibrary().catch(() => {}));
}

async function pageChannel(id) {
  const [users, list] = await Promise.all([api('/api/users'), api('/api/videos?user=' + id)]);
  const u = users.find((x) => x.id === id);
  if (!u) return (view.innerHTML = '<div class="empty"><b>Not found</b></div>');
  view.innerHTML = `<div class="profile">${avatar(u, 'lg')}<h1>${esc(u.name)}</h1></div>${listHtml(list, ['No videos yet'])}`;
}

async function pageWatch(id) {
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
      <button class="pill" id="share">Share</button></div>
    ${v.desc ? `<div class="desc">${esc(v.desc)}</div>` : ''}
    ${v.canManage ? `<div class="row"><button class="pill" id="edit">Edit</button><button class="pill" id="del" style="color:var(--accent)">Delete</button></div>` : ''}
    <h2>Comments <span id="cc" style="color:var(--mute);font-weight:400">${v.comments}</span></h2>
    <form class="cform" id="cf"><input type="text" id="ct" placeholder="Add a comment…" maxlength="1000" autocomplete="off"><button class="btn sm">Post</button></form>
    <div id="cl"></div>
    <h2>Up next</h2><div id="up"></div>`;

  $('#bk').onclick = () => (history.length > 1 ? history.back() : (location.hash = '#/'));
  if (ready) setupPlayer(v);
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
  api('/api/videos').then((all) => { const o = all.filter((x) => x.id !== v.id && x.status === 'ready'); $('#up').innerHTML = o.length ? `<div class="grid">${o.map(card).join('')}</div>` : '<div class="empty">That is everything for now.</div>'; }).catch(() => {});
  if (v.status === 'processing') pollTimer = setTimeout(() => location.hash === '#/watch/' + v.id && pageWatch(v.id), 4000);
}

function setupPlayer(v) {
  const el = $('#v'), key = 'ft-pos-' + v.id;
  el.addEventListener('loadedmetadata', () => {
    const p = Number(lsGet(key)); if (p > 5 && p < el.duration - 5) el.currentTime = p;
  });
  let last = 0;
  el.addEventListener('timeupdate', () => { if (Date.now() - last > 3000) { last = Date.now(); lsSet(key, el.currentTime); } });
  el.addEventListener('ended', () => lsSet(key, 0));
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
  const [, a, b] = h.split('/');
  document.body.className = a === 'watch' ? 'watching' : '';
  document.title = 'Famtube';
  document.querySelectorAll('#tabs a').forEach((t) => t.classList.toggle('on', t.dataset.t === ({ '': 'home', search: 'search', upload: 'upload', library: 'library', u: 'library' }[a] ?? 'home')));
  const reset = () => { if (a !== 'watch') window.scrollTo(0, 0); };
  try {
    if (a === 'watch') await pageWatch(b);
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
  route();
}
addEventListener('hashchange', route);
if ('serviceWorker' in navigator) addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
boot();
