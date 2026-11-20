/* Review Desk renderer */
const $ = (id) => document.getElementById(id);
/* global api: exposed by preload as window.api */
const video = $('video'), overlay = $('overlay'), ctx = overlay.getContext('2d');
const COLORS = ['#ff4d4d', '#ffd23f', '#3ecf8e', '#3fc8ff', '#ffffff', '#c06bff'];

const S = {
  root: '', projects: [], recents: [], expanded: new Set(),
  cur: null,          // { project, projectPath, version: {name, file, path, ...} }
  info: null,         // ffprobe result
  doc: null, changed: false, paths: null,
  fps: 30, frames: 0, frame: 0,
  tool: 'none', color: COLORS[0], width: 5,
  draft: { shapes: [], frame: null, frameEnd: null },
  sel: null, filter: 'open', usingProxy: false, loop: false,
  drawing: null,
};

// ---------- helpers ----------
const pad = (n, w = 2) => String(n).padStart(w, '0');
function tc(frame) {
  const f = Math.round(S.fps) || 30, total = Math.floor(frame / f);
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}:${pad(frame % f)}`;
}
function toast(t) { const el = $('toast'); el.textContent = t; el.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 1700); }
function fmtDate(ms) { const d = new Date(ms); return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const typing = () => { const a = document.activeElement; return a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type !== 'range')); };

// ---------- library ----------
async function refresh() {
  const r = await api.scan();
  S.root = r.root; S.projects = r.projects;
  $('libPath').textContent = S.root;
  renderSide();
  if (S.cur) {
    const p = S.projects.find(p => p.path === S.cur.projectPath);
    if (p) { S.cur.versions = p.versions; renderChips(); }
  }
}
function renderSide() {
  const q = $('projFilter').value.trim().toLowerCase();
  const pl = $('projectList'); pl.innerHTML = '';
  if (!S.projects.length) pl.innerHTML = '<div class="noproj" style="padding-left:7px">No projects yet. Create one, or make a folder inside the library.</div>';
  for (const p of S.projects) {
    if (q && !p.name.toLowerCase().includes(q)) continue;
    const open = p.versions.reduce((a, v) => a + v.open, 0);
    const isOpen = S.expanded.has(p.path) || (S.cur && S.cur.projectPath === p.path);
    const box = document.createElement('div'); box.className = 'proj'; box.dataset.path = p.path; box.dataset.name = p.name;
    box.innerHTML = `<div class="proj-head"><span class="caret">${isOpen ? '▾' : '▸'}</span><span class="pname" title="${esc(p.path)}">${esc(p.name)}</span>
      ${open ? `<span class="badge open" title="Open remarks">${open}</span>` : ''}<span class="badge" title="Versions">${p.versions.length}</span>
      <button class="btn sm ghost padd" title="Add versions to this project">+</button></div>`;
    box.querySelector('.proj-head').onclick = (e) => {
      if (e.target.classList.contains('padd')) return;
      if (S.expanded.has(p.path)) S.expanded.delete(p.path); else S.expanded.add(p.path);
      renderSide();
    };
    box.querySelector('.padd').onclick = () => addVersions(p.path);
    if (isOpen) {
      if (!p.versions.length) box.insertAdjacentHTML('beforeend', '<div class="noproj">No videos yet. Drop files here or press +.</div>');
      for (const v of p.versions) {
        const row = document.createElement('div');
        row.className = 'ver' + (S.cur && S.cur.version.path === v.path ? ' cur' : '');
        row.title = v.path;
        row.innerHTML = `<span class="vname">${esc(v.name)}</span>${v.writing ? '<span class="badge writing">writing…</span>' : ''}${v.latest ? '<span class="badge latest">LATEST</span>' : ''}${v.open ? `<span class="badge open">${v.open}</span>` : ''}<span class="vdate">${fmtDate(v.mtime)}</span>`;
        row.onclick = () => openVersion(p, v);
        box.appendChild(row);
      }
    }
    pl.appendChild(box);
  }
  const rl = $('recentList'); rl.innerHTML = '';
  const rec = (S.recents || []).slice(0, 6);
  if (!rec.length) rl.innerHTML = '<div class="empty-r">Nothing opened yet</div>';
  for (const r of rec) {
    const el = document.createElement('div'); el.className = 'ritem'; el.title = r.path;
    el.innerHTML = `<span>${esc(r.version)}</span><span class="rp">${esc(r.project)} · ${fmtDate(r.at)}</span>`;
    el.onclick = () => openByPath(r.path);
    rl.appendChild(el);
  }
}
function renderChips() {
  const c = $('versionChips'); c.innerHTML = '';
  if (!S.cur) return;
  for (const v of S.cur.versions || []) {
    const el = document.createElement('span');
    el.className = 'chip' + (v.path === S.cur.version.path ? ' cur' : '');
    el.innerHTML = `${esc(v.name)}${v.latest ? '<span class="l">LATEST</span>' : ''}`;
    el.title = `${v.file}\n${fmtDate(v.mtime)}${v.open ? `\n${v.open} open remarks` : ''}`;
    el.onclick = () => openVersion(S.projects.find(p => p.path === S.cur.projectPath), v);
    c.appendChild(el);
  }
}
async function openByPath(p) {
  await refresh();
  for (const pr of S.projects) { const v = pr.versions.find(v => v.path.toLowerCase() === p.toLowerCase()); if (v) return openVersion(pr, v); }
  toast('That file is no longer in the library');
}

// ---------- open a version ----------
async function openVersion(project, v, opts = {}) {
  // an unsaved remark stays stored for its own version (see saveDraftLocal), so nothing to confirm
  S.keepDraft = true; clearDraft(); S.keepDraft = false;
  video.pause();
  S.cur = { project: project.name, projectPath: project.path, version: v, versions: project.versions };
  S.expanded.add(project.path);
  $('empty').classList.add('hidden'); hideMsg();
  $('crumbProject').textContent = project.name; $('crumbVersion').textContent = v.name;
  renderSide(); renderChips();
  const info = await api.probe(v.path);
  S.info = info.ok ? info : { fps: 30, frames: 0, width: 1920, height: 1080 };
  S.fps = S.info.fps || 30; S.frames = S.info.frames || 0;
  $('meta').textContent = info.ok ? `${info.width}×${info.height} · ${+S.fps.toFixed(3)} fps · ${info.codec}` : 'ffprobe failed';
  $('frameTotal').textContent = `/ ${Math.max(0, S.frames - 1)}`;
  // notes
  const n = await api.notesLoad(v.path);
  S.paths = n.paths; S.changed = n.changed;
  S.doc = n.doc || { video: v.path, project: project.name, version: v.name, notes: [] };
  Object.assign(S.doc, { video: v.path, project: project.name, version: v.name, fps: S.fps, fpsText: S.info.fpsText, width: S.info.width, height: S.info.height, frames: S.frames, duration: S.info.duration });
  if (S.changed) S.doc.videoChanged = true;
  $('changedWarn').classList.toggle('hidden', !S.changed);
  $('notesPathText').textContent = S.paths.md;
  S.sel = null; S.frame = 0;
  renderNotes();
  // source: proxy if one exists or the codec won't play in Chromium
  const proxy = await api.proxyExists(v.path);
  const unplayable = ['prores', 'dnxhd', 'cfhd', 'rawvideo', 'mjpeg', 'dvvideo'].includes(info.codec) || /444|422|10le|12le/.test(info.pixFmt || '');
  if (proxy) await setSource(proxy, true);
  else if (unplayable) { video.removeAttribute('src'); video.load(); offerProxy(`This file is ${info.codec} (${info.pixFmt}), which the player can't decode.`); }
  else await setSource(v.path, false);
  restoreDraft();
  const rec = await api.recentAdd({ path: v.path, project: project.name, version: v.name, at: Date.now() });
  S.recents = rec; renderSide();
}
async function setSource(p, isProxy) {
  S.usingProxy = isProxy;
  $('proxyState').textContent = isProxy ? 'Playing a preview copy (same frames as the original)' : '';
  video.src = await api.mediaUrl(p, Date.now());
  video.load();
  armFrameCallback();
  await new Promise((res) => { video.onloadedmetadata = res; video.onerror = res; setTimeout(res, 8000); });
  if (!isProxy && (video.error || !video.videoWidth)) {
    offerProxy(video.error ? 'The player could not decode this file.' : `The player loaded this file but shows no picture (${S.info?.codec || 'codec'} isn't supported here).`);
    return;
  }
  layout();
  if (!S.frames && video.duration) { S.frames = Math.round(video.duration * S.fps); S.doc.frames = S.frames; $('frameTotal').textContent = `/ ${S.frames - 1}`; }
  seekFrame(0);
  renderMarkers();
}
function offerProxy(reason) {
  showMsg(`<div>${esc(reason)}</div><div class="muted small" style="margin-top:6px">Make a preview copy with ffmpeg. It keeps every frame and the frame rate, so frame numbers match the original file.</div><button class="btn primary" id="btnMkProxy">Make preview copy</button>`);
  $('btnMkProxy').onclick = makeProxyNow;
}
async function makeProxyNow() {
  const v = S.cur.version;
  showMsg(`<div>Making preview copy…</div><div class="muted small" id="pxProg">starting</div>`);
  const r = await api.proxyMake(v.path, { frames: S.frames });
  if (!r.ok) return showMsg(`<div>ffmpeg failed</div><pre class="small muted" style="white-space:pre-wrap;text-align:left">${esc(r.error)}</pre>`);
  hideMsg();
  if (S.cur && S.cur.version.path === v.path) await setSource(r.proxy, true);
}
api.on('proxy-progress', (d) => { const el = $('pxProg'); if (el && d.frames) el.textContent = `${Math.min(100, Math.round(d.frame / d.frames * 100))}%  (frame ${d.frame} of ${d.frames})`; });
video.addEventListener('error', () => { if (S.cur && !S.usingProxy && video.getAttribute('src')) offerProxy('The player could not decode this file (codec not supported).'); });
function showMsg(html) { const m = $('msg'); m.innerHTML = html; m.classList.remove('hidden'); }
function hideMsg() { $('msg').classList.add('hidden'); }

// ---------- layout: fit the frame box to the video's aspect ----------
function layout() {
  const st = $('stage').getBoundingClientRect();
  const vw = video.videoWidth || S.info?.width || 16, vh = video.videoHeight || S.info?.height || 9;
  const pad = 16, W = st.width - pad * 2, H = st.height - pad * 2;
  const s = Math.min(W / vw, H / vh);
  const w = Math.max(1, Math.floor(vw * s)), h = Math.max(1, Math.floor(vh * s));
  const fb = $('frameBox');
  Object.assign(fb.style, { width: w + 'px', height: h + 'px', left: Math.floor((st.width - w) / 2) + 'px', top: Math.floor((st.height - h) / 2) + 'px' });
  const dpr = window.devicePixelRatio || 1;
  overlay.width = Math.round(w * dpr); overlay.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redraw();
}
new ResizeObserver(layout).observe($('stage'));

// ---------- frame-accurate transport ----------
function clampF(f) { return Math.max(0, Math.min(Math.max(0, S.frames - 1), Math.round(f))); }
function seekFrame(f) {
  if (!S.cur) return;
  if (!video.paused) video.pause();
  S.frame = clampF(f);
  video.currentTime = (S.frame + 0.5) / S.fps;
  updateReadout(); redraw();
}
function step(n) { seekFrame(S.frame + n); }
function togglePlay() {
  if (!S.cur || !video.getAttribute('src')) return;
  if (video.paused) { if (S.frame >= S.frames - 1) seekFrame(0); video.play(); } else video.pause();
}
function frameFromTime(t) { return clampF(Math.floor(t * S.fps + 1e-4)); }
function onFrame(_now, meta, myToken) {
  if (myToken !== rvfcToken) return;
  if (!video.paused) { S.frame = frameFromTime(meta.mediaTime + 0.5 / S.fps); updateReadout(); redraw(); }
  S.shown = Math.round(meta.mediaTime * S.fps); // frame actually on screen (for self-test)
  if (rvfcToken === myToken) video.requestVideoFrameCallback((n, m) => onFrame(n, m, myToken));
}
let rvfcToken = 0;
function armFrameCallback() { const t = ++rvfcToken; video.requestVideoFrameCallback((n, m) => onFrame(n, m, t)); }
armFrameCallback();
video.addEventListener('play', () => { $('btnPlay').textContent = '❚❚'; S.sel = null; renderNotes(); });
video.addEventListener('pause', () => { $('btnPlay').textContent = '▶'; seekFrame(frameFromTime(video.currentTime)); });
video.addEventListener('ended', () => { if (S.loop) { seekFrame(0); video.play(); } });
video.addEventListener('progress', updateBuffered);
function updateReadout() {
  $('frameInput').value = S.frame; $('tc').textContent = tc(S.frame); $('secs').textContent = (S.frame / S.fps).toFixed(3);
  const pct = S.frames > 1 ? S.frame / (S.frames - 1) * 100 : 0;
  $('played').style.width = pct + '%'; $('head').style.left = pct + '%';
  if (S.draft.frame == null) $('compFrame').textContent = `Remark at frame ${S.frame} · ${tc(S.frame)}`;
}
function updateBuffered() { try { const b = video.buffered; if (b.length && video.duration) $('buffered').style.width = (b.end(b.length - 1) / video.duration * 100) + '%'; } catch {} }
// scrubbing
(() => {
  const tr = $('track'); let down = false;
  const at = (e) => { const r = tr.getBoundingClientRect(); return clampF((e.clientX - r.left) / r.width * (S.frames - 1)); };
  tr.addEventListener('pointerdown', (e) => { if (e.target.classList.contains('mk')) return; down = true; tr.setPointerCapture(e.pointerId); seekFrame(at(e)); });
  tr.addEventListener('pointermove', (e) => { if (down) seekFrame(at(e)); });
  tr.addEventListener('pointerup', () => { down = false; });
})();
function renderMarkers() {
  const m = $('markers'); m.innerHTML = '';
  if (!S.doc || S.frames < 2) return;
  for (const n of S.doc.notes) {
    const el = document.createElement('div');
    const left = n.frame / (S.frames - 1) * 100;
    el.className = 'mk' + (n.status === 'done' ? ' done' : '');
    el.style.left = left + '%';
    el.title = `Frame ${n.frame}: ${n.text || '(drawing)'}`;
    el.onclick = () => selectNote(n.id);
    m.appendChild(el);
    if (n.frameEnd != null && n.frameEnd > n.frame) {
      const r = document.createElement('div'); r.className = 'mk range' + (n.status === 'done' ? ' done' : '');
      r.style.left = left + '%'; r.style.width = ((n.frameEnd - n.frame) / (S.frames - 1) * 100) + '%';
      r.style.top = '15px'; m.appendChild(r);
    }
  }
}

// ---------- drawing ----------
function norm(e) { const r = overlay.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))]; }
overlay.addEventListener('pointerdown', (e) => {
  if (S.tool === 'none' || !S.cur) return;
  if (!video.paused) video.pause();
  overlay.setPointerCapture(e.pointerId);
  if (S.draft.frame == null) startDraft();
  const [x, y] = norm(e);
  const base = { color: S.color, width: S.width };
  if (S.tool === 'pen') S.drawing = { type: 'pen', ...base, points: [[x, y]] };
  if (S.tool === 'rect') S.drawing = { type: 'rect', ...base, x, y, w: 0, h: 0, _x0: x, _y0: y };
  if (S.tool === 'arrow') S.drawing = { type: 'arrow', ...base, x1: x, y1: y, x2: x, y2: y };
  redraw();
});
overlay.addEventListener('pointermove', (e) => {
  const d = S.drawing; if (!d) return;
  const [x, y] = norm(e);
  if (d.type === 'pen') d.points.push([x, y]);
  if (d.type === 'rect') { d.x = Math.min(d._x0, x); d.y = Math.min(d._y0, y); d.w = Math.abs(x - d._x0); d.h = Math.abs(y - d._y0); }
  if (d.type === 'arrow') { d.x2 = x; d.y2 = y; }
  redraw();
});
overlay.addEventListener('pointerup', () => {
  const d = S.drawing; if (!d) return; S.drawing = null;
  delete d._x0; delete d._y0;
  const tiny = (d.type === 'rect' && d.w < 0.004 && d.h < 0.004) || (d.type === 'arrow' && Math.hypot(d.x2 - d.x1, d.y2 - d.y1) < 0.01);
  if (!tiny) { if (d.type === 'pen') d.points = d.points.map(p => [+p[0].toFixed(4), +p[1].toFixed(4)]); S.draft.shapes.push(d); }
  updateComposer(); redraw();
});
function drawShape(c, s, W, H, scale = 1) {
  c.save(); c.strokeStyle = s.color; c.fillStyle = s.color; c.lineWidth = s.width * scale; c.lineCap = 'round'; c.lineJoin = 'round';
  c.shadowColor = 'rgba(0,0,0,.55)'; c.shadowBlur = 3 * scale;
  if (s.type === 'pen') { c.beginPath(); s.points.forEach((p, i) => i ? c.lineTo(p[0] * W, p[1] * H) : c.moveTo(p[0] * W, p[1] * H)); if (s.points.length === 1) c.lineTo(s.points[0][0] * W + .1, s.points[0][1] * H); c.stroke(); }
  if (s.type === 'rect') c.strokeRect(s.x * W, s.y * H, s.w * W, s.h * H);
  if (s.type === 'arrow') {
    const x1 = s.x1 * W, y1 = s.y1 * H, x2 = s.x2 * W, y2 = s.y2 * H, a = Math.atan2(y2 - y1, x2 - x1), hl = Math.max(12, s.width * 3.2) * scale;
    c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2 - Math.cos(a) * hl * .6, y2 - Math.sin(a) * hl * .6); c.stroke();
    c.beginPath(); c.moveTo(x2, y2); c.lineTo(x2 - hl * Math.cos(a - .45), y2 - hl * Math.sin(a - .45)); c.lineTo(x2 - hl * Math.cos(a + .45), y2 - hl * Math.sin(a + .45)); c.closePath(); c.fill();
  }
  c.restore();
}
function visibleNotes() {
  if (!S.doc || !video.paused) return [];
  return S.doc.notes.filter(n => (n.shapes || []).length && n.frame === S.frame);
}
function redraw() {
  const r = overlay.getBoundingClientRect(), W = r.width, H = r.height;
  ctx.clearRect(0, 0, W, H);
  for (const n of visibleNotes()) for (const s of n.shapes) drawShape(ctx, s, W, H);
  if (S.draft.frame == null || S.draft.frame === S.frame) {
    for (const s of S.draft.shapes) drawShape(ctx, s, W, H);
    if (S.drawing) drawShape(ctx, S.drawing, W, H);
  }
}
function setTool(t) {
  S.tool = t;
  document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  overlay.classList.toggle('draw', t !== 'none');
  overlay.style.pointerEvents = t === 'none' ? 'none' : 'auto';
}

// ---------- composer ----------
function startDraft() { S.draft.frame = S.frame; updateComposer(); }
function clearDraft() { S.draft = { shapes: [], frame: null, frameEnd: null }; $('noteText').value = ''; updateComposer(); redraw(); }
function confirmDiscard() { return window.confirm('Discard the unsaved remark?'); }
// the remark being written is kept per version in the app's storage until it is saved or cancelled
const draftKey = () => S.cur && 'draft:' + S.cur.version.path.toLowerCase();
function saveDraftLocal() {
  if (S.keepDraft || !S.cur) return;
  try {
    const text = $('noteText').value;
    if (!text.trim() && !S.draft.shapes.length) localStorage.removeItem(draftKey());
    else localStorage.setItem(draftKey(), JSON.stringify({ ...S.draft, frame: S.draft.frame ?? S.frame, text, saved: Date.now() }));
  } catch {}
}
function restoreDraft() {
  let d = null; try { d = JSON.parse(localStorage.getItem(draftKey()) || 'null'); } catch {}
  if (!d || (!String(d.text || '').trim() && !(d.shapes || []).length)) return;
  S.draft = { shapes: d.shapes || [], frame: d.frame ?? 0, frameEnd: d.frameEnd ?? null };
  $('noteText').value = d.text || '';
  updateComposer(); seekFrame(S.draft.frame);
  toast('Restored your unsaved remark');
}
function updateComposer() {
  saveDraftLocal();
  const f = S.draft.frame ?? S.frame;
  $('compFrame').textContent = `Remark at frame ${f} · ${tc(f)}`;
  const n = S.draft.shapes.length;
  $('compShapes').textContent = n ? `${n} drawing${n > 1 ? 's' : ''}` : '';
  $('rangeTxt').textContent = S.draft.frameEnd != null ? `to frame ${S.draft.frameEnd}` : '';
}
$('noteText').addEventListener('input', saveDraftLocal);
$('noteText').addEventListener('focus', () => { if (!video.paused) video.pause(); if (S.draft.frame == null) startDraft(); });
$('noteText').addEventListener('blur', () => { if (!$('noteText').value.trim() && !S.draft.shapes.length && S.draft.frame != null) { S.draft.frame = null; S.draft.frameEnd = null; updateComposer(); } });
$('btnSetEnd').onclick = () => {
  if (S.draft.frame == null) startDraft();
  if (S.frame > S.draft.frame) { S.draft.frameEnd = S.frame; updateComposer(); } else toast('Move the playhead past the start frame first');
};
$('btnCancelDraft').onclick = () => { const f = S.draft.frame; clearDraft(); if (f != null) seekFrame(f); };
$('btnSave').onclick = saveRemark;

async function snapshotFor(frame, shapes) {
  // seek to the frame, wait for it to be presented, then composite frame + drawings at video resolution
  if (S.frame !== frame || video.seeking) { seekFrame(frame); }
  await waitPresented();
  const W = video.videoWidth, H = video.videoHeight;
  S.doc.snapW = W; S.doc.snapH = H;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'); g.drawImage(video, 0, 0, W, H);
  const scale = Math.max(1, W / overlay.getBoundingClientRect().width);
  for (const s of shapes) drawShape(g, s, W, H, scale);
  return c.toDataURL('image/png');
}
function waitPresented() {
  return new Promise((res) => {
    let done = false; const fin = () => { if (!done) { done = true; res(); } };
    if (!video.seeking && video.readyState >= 2) { setTimeout(fin, 60); return; }
    video.addEventListener('seeked', () => setTimeout(fin, 60), { once: true });
    setTimeout(fin, 2500);
  });
}
async function saveRemark(quick = false) {
  if (!S.cur) return;
  const text = $('noteText').value.trim();
  if (!text && !S.draft.shapes.length) { toast('Write a remark or draw something first'); return; }
  const frame = S.draft.frame ?? S.frame;
  const note = { id: uid(), frame, frameEnd: S.draft.frameEnd, t: +(frame / S.fps).toFixed(4), tc: tc(frame), text, status: 'open', created: Date.now(), shapes: S.draft.shapes };
  try {
    const png = await snapshotFor(frame, note.shapes);
    note.snapshot = await api.snapshotSave(S.cur.version.path, `f${pad(frame, 6)}_${note.id}.png`, png);
  } catch (e) { console.error(e); }
  S.doc.notes.push(note);
  S.history = [note, ...S.history.filter(h => h.id !== note.id)].slice(0, 10);
  clearDraft();
  await persist();
  S.sel = note.id; renderNotes();
  if (quick) savedFeedback(note); else toast('Remark saved');
  return note;
}
async function persist() {
  await api.notesSave(S.doc);
  renderMarkers();
  const v = S.cur.versions.find(v => v.path === S.cur.version.path);
  if (v) { v.total = S.doc.notes.length; v.open = S.doc.notes.filter(n => n.status !== 'done').length; }
  const p = S.projects.find(p => p.path === S.cur.projectPath);
  if (p) { const pv = p.versions.find(x => x.path === S.cur.version.path); if (pv) { pv.total = v?.total; pv.open = v?.open; } }
  renderSide();
}

// ---------- notes list ----------
function renderNotes() {
  const list = $('noteList'); list.innerHTML = '';
  const all = S.doc ? [...S.doc.notes].sort((a, b) => a.frame - b.frame || a.created - b.created) : [];
  const open = all.filter(n => n.status !== 'done').length;
  $('noteCount').textContent = open ? `${open} open` : all.length;
  const sorters = { asc: (a, b) => a.frame - b.frame || a.created - b.created, desc: (a, b) => b.frame - a.frame || b.created - a.created, new: (a, b) => b.created - a.created };
  const shown = all.filter(n => S.filter === 'all' || (S.filter === 'open' ? n.status !== 'done' : n.status === 'done')).sort(sorters[S.sort]);
  if (!S.cur) { list.innerHTML = '<div class="nonotes">Open a version to see its remarks.</div>'; return; }
  if (!shown.length) list.innerHTML = `<div class="nonotes">${all.length ? 'Nothing in this filter.' : 'No remarks yet. Pause on a frame, draw or type, and save.'}</div>`;
  shown.forEach((n) => {
    const idx = all.indexOf(n) + 1;
    const el = document.createElement('div');
    el.className = 'note' + (n.id === S.sel ? ' sel' : '') + (n.status === 'done' ? ' done' : '');
    el.dataset.id = n.id;
    const range = n.frameEnd != null && n.frameEnd > n.frame ? `–${n.frameEnd}` : '';
    const shp = (n.shapes || []).length ? `<div class="shp">${n.shapes.map(s => ({ pen: 'brush', rect: 'box', arrow: 'arrow' }[s.type])).join(', ')}</div>` : '';
    el.innerHTML = `<div class="nhead"><span class="chk ${n.status === 'done' ? 'on' : ''}" title="${n.status === 'done' ? 'Resolved: click to reopen' : 'Click to resolve'}">${n.status === 'done' ? '✓' : ''}</span><span class="num">#${idx}</span><span class="fr">F ${n.frame}${range} · ${tc(n.frame)}</span></div>
      <div class="txt">${n.text ? esc(n.text) : '<span class="muted">(drawing only)</span>'}</div>${shp}
      <div class="nact"><button data-a="resolve">${n.status === 'done' ? '↺ Reopen' : '✓ Resolve'}</button><button data-a="edit">✎ Edit</button><button data-a="copy">⧉ Copy</button><button data-a="del" class="del">🗑 Delete</button></div>`;
    el.onclick = (e) => {
      const a = e.target.dataset.a;
      if (e.target.classList.contains('chk') || a === 'resolve') { n.status = n.status === 'done' ? 'open' : 'done'; n.resolved = n.status === 'done' ? Date.now() : undefined; persist(); renderNotes(); e.stopPropagation(); return; }
      if (a === 'copy') { api.copy(noteText(n, idx)); toast('Remark copied'); return; }
      if (a === 'del') { if (confirm('Delete this remark?')) { S.doc.notes = S.doc.notes.filter(x => x.id !== n.id); api.snapshotDelete(n.snapshot); persist(); renderNotes(); redraw(); } return; }
      if (a === 'edit') { editNote(el, n); return; }
      if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'BUTTON') return;
      selectNote(n.id);
    };
    list.appendChild(el);
  });
}
function editNote(el, n) {
  const t = el.querySelector('.txt');
  el.querySelector('.nact').classList.add('hidden');
  t.innerHTML = `<textarea>${esc(n.text || '')}</textarea><div class="comp-actions"><span class="grow"></span><button class="btn sm ghost" data-x="c">Cancel</button><button class="btn sm primary" data-x="s">Save</button></div>`;
  const ta = t.querySelector('textarea'); ta.focus();
  const save = () => { n.text = ta.value.trim(); n.edited = Date.now(); persist(); renderNotes(); };
  t.querySelector('[data-x=s]').onclick = (e) => { e.stopPropagation(); save(); };
  t.querySelector('[data-x=c]').onclick = (e) => { e.stopPropagation(); renderNotes(); };
  ta.onkeydown = (e) => { if (e.key === 'Enter' && e.ctrlKey) save(); if (e.key === 'Escape') renderNotes(); e.stopPropagation(); };
}
function noteText(n, idx) {
  const range = n.frameEnd != null && n.frameEnd > n.frame ? ` to ${n.frameEnd}` : '';
  return `${S.cur.project} / ${S.cur.version.name} - remark #${idx}\nVideo: ${S.cur.version.path}\nFrame ${n.frame}${range} (${tc(n.frame)}, ${(n.frame / S.fps).toFixed(3)} s)\n${n.text || '(drawing only)'}${n.snapshot ? `\nSnapshot: ${n.snapshot}` : ''}`;
}
function selectNote(id) {
  const n = S.doc.notes.find(x => x.id === id); if (!n) return;
  S.sel = id; seekFrame(n.frame); renderNotes();
  const el = document.querySelector('.note.sel'); if (el) el.scrollIntoView({ block: 'nearest' });
}
function jumpNote(dir) {
  if (!S.doc || !S.doc.notes.length) return;
  const sorted = [...S.doc.notes].sort((a, b) => a.frame - b.frame);
  const n = dir > 0 ? sorted.find(x => x.frame > S.frame) : [...sorted].reverse().find(x => x.frame < S.frame);
  if (n) selectNote(n.id);
}
// sort toggle: TC ascending -> TC descending -> newest first
const SORTS = { asc: 'TC ↑', desc: 'TC ↓', new: 'Newest' };
try { S.sort = localStorage.getItem('sort') || 'asc'; } catch { S.sort = 'asc'; }
if (!SORTS[S.sort]) S.sort = 'asc';
$('btnSort').textContent = SORTS[S.sort];
$('btnSort').onclick = () => {
  const keys = Object.keys(SORTS); S.sort = keys[(keys.indexOf(S.sort) + 1) % keys.length];
  $('btnSort').textContent = SORTS[S.sort]; try { localStorage.setItem('sort', S.sort); } catch {}
  renderNotes();
};
// Ctrl+Q / W / E: put your last / 2nd-last / 3rd-last remark back in the box at the current frame (editable)
S.history = [];
function recallRemark(k) {
  if (!S.cur) return;
  const pool = new Map();
  for (const n of [...S.history, ...(S.doc ? S.doc.notes : [])]) pool.set(n.id, n);
  const list = [...pool.values()].sort((a, b) => b.created - a.created);
  const n = list[k];
  if (!n) return toast(k ? `There is no remark #${k + 1} back yet` : 'No remarks to bring back yet');
  if (!video.paused) video.pause();
  S.draft = { frame: S.frame, frameEnd: null, shapes: JSON.parse(JSON.stringify(n.shapes || [])) };
  $('noteText').value = n.text || '';
  updateComposer(); redraw();
  const ta = $('noteText'); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  toast(`${['Last', '2nd-last', '3rd-last'][k]} remark placed at frame ${S.frame}. Edit it, then Ctrl+Enter.`);
}
document.querySelectorAll('#filterSeg button').forEach(b => b.onclick = () => {
  S.filter = b.dataset.f; document.querySelectorAll('#filterSeg button').forEach(x => x.classList.toggle('on', x === b)); renderNotes();
});

// ---------- agent actions ----------
$('btnCopyPath').onclick = async () => {
  if (!S.cur) return toast('Open a version first');
  await api.notesSave(S.doc); // make sure the file exists and is current
  api.copy(S.paths.md); toast('Notes file path copied');
};
$('btnCopyOpen').onclick = async () => {
  if (!S.cur) return toast('Open a version first');
  api.copy(await api.notesMarkdown(S.doc, true)); toast('Open remarks copied as Markdown');
};
$('btnOpenNotes').onclick = async () => { if (!S.cur) return; await api.notesSave(S.doc); api.openPath(S.paths.md); };
$('btnReveal').onclick = () => S.cur && api.reveal(S.cur.version.path);

// ---------- library actions ----------
$('btnOpenLib').onclick = () => api.openPath(S.root);
$('btnCopyLib').onclick = () => { api.copy(S.root + '\\_review-index.md'); toast('Library index path copied'); };
$('btnChangeLib').onclick = async () => { const r = await api.chooseRoot(); if (r) { resetView(); await refresh(); toast('Library changed'); } };
function resetView() {
  video.pause(); video.removeAttribute('src'); video.load();
  S.keepDraft = true; clearDraft(); S.keepDraft = false;
  S.cur = null; S.doc = null; S.sel = null; S.frame = 0; S.frames = 0; clearDraft(); hideMsg();
  $('empty').classList.remove('hidden'); $('crumbProject').textContent = 'No video open'; $('crumbVersion').textContent = '';
  $('notesPathText').textContent = ''; $('meta').textContent = ''; $('proxyState').textContent = '';
  renderChips(); renderNotes(); renderMarkers(); updateReadout();
}
$('btnClearRecent').onclick = async () => { S.recents = await api.recentClear(); renderSide(); };
$('projFilter').oninput = renderSide;
$('btnNewProject').onclick = () => askName('New project', 'Create', async (name) => {
  const d = await api.projectCreate(name); if (!d) return;
  S.expanded.add(d); await refresh(); toast(`Project “${name}” created`);
});
$('btnImport').onclick = () => { if (!S.cur) return toast('Open or create a project first'); addVersions(S.cur.projectPath); };
async function addVersions(projectDir, files) {
  files = files || await api.pickVideos();
  if (!files.length) return;
  toast(`Adding ${files.length} file${files.length > 1 ? 's' : ''}…`);
  const added = await api.importVideos(projectDir, files);
  S.expanded.add(projectDir);
  await refresh();
  const p = S.projects.find(p => p.path === projectDir);
  const v = p && p.versions.find(v => v.path === added[added.length - 1]);
  if (v) openVersion(p, v);
}
function askName(title, ok, cb, value = '') {
  $('modalTitle').textContent = title; $('modalOk').textContent = ok; $('modalInput').value = value;
  $('modal').classList.remove('hidden'); $('modalInput').focus();
  const close = () => $('modal').classList.add('hidden');
  $('modalOk').onclick = () => { const v = $('modalInput').value.trim(); close(); if (v) cb(v); };
  $('modalCancel').onclick = close;
  $('modalInput').onkeydown = (e) => { if (e.key === 'Enter') $('modalOk').click(); if (e.key === 'Escape') close(); e.stopPropagation(); };
}
// drag and drop videos (or folders of videos) onto the window
//   onto a project in the sidebar -> added to that project
//   onto empty sidebar space      -> a new project
//   onto the player               -> the open project (or a new one if nothing is open)
//   a dropped folder              -> a project named after the folder (unless dropped onto a project)
let dragDepth = 0;
function dropTarget(e) {
  const box = e.target.closest && e.target.closest('.proj');
  if (box && box.dataset.path) return { dir: box.dataset.path, name: box.dataset.name, box };
  if (e.target.closest && e.target.closest('#side')) return { newProject: true };
  if (S.cur) return { dir: S.cur.projectPath, name: S.cur.project };
  return { newProject: true };
}
function clearDropMarks() { document.querySelectorAll('.proj.droptarget').forEach(b => b.classList.remove('droptarget')); }
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropHint').classList.add('hidden'); clearDropMarks(); } });
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  const t = dropTarget(e);
  clearDropMarks(); if (t.box) t.box.classList.add('droptarget');
  $('dropHint').textContent = t.newProject ? 'Drop to make a new project (a folder becomes a project named after it)' : `Drop to add as versions of "${t.name}"`;
  $('dropHint').classList.remove('hidden');
});
window.addEventListener('drop', async (e) => {
  e.preventDefault(); dragDepth = 0; $('dropHint').classList.add('hidden'); clearDropMarks();
  const t = dropTarget(e);
  const items = await api.expandDrop([...e.dataTransfer.files].map(f => api.filePath(f)).filter(Boolean));
  const loose = items.filter(i => !i.isDir).map(i => i.path);
  const folders = items.filter(i => i.isDir && i.videos.length);
  if (!loose.length && !folders.length) return toast('No video files in that drop');
  if (!t.newProject) return addVersions(t.dir, [...loose, ...folders.flatMap(f => f.videos)]);
  for (const f of folders) { const d = await api.projectCreate(f.name); if (d) await addVersions(d, f.videos); }
  if (loose.length) {
    const guess = loose[0].split(/[\\/]/).pop().replace(/\.[^.]+$/, '').replace(/[ _-]*v?\d+$/i, '').trim();
    askName('New project for these videos', 'Create & add', async (name) => { const d = await api.projectCreate(name); if (d) addVersions(d, loose); }, guess);
  }
});
api.on('library-changed', () => refresh());

// ---------- transport wiring ----------
$('btnPlay').onclick = togglePlay;
$('btnBack').onclick = () => step(-1); $('btnFwd').onclick = () => step(1);
$('btnBack10').onclick = () => step(-10); $('btnFwd10').onclick = () => step(10);
$('btnStart').onclick = () => seekFrame(0); $('btnEnd').onclick = () => seekFrame(S.frames - 1);
// mouse wheel over the video or timeline: down = forward, up = back, Shift = 10 frames
try { S.wheel = localStorage.getItem('wheel') !== 'off'; } catch { S.wheel = true; }
$('btnWheel').classList.toggle('on', S.wheel);
$('btnWheel').onclick = () => { S.wheel = !S.wheel; $('btnWheel').classList.toggle('on', S.wheel); try { localStorage.setItem('wheel', S.wheel ? 'on' : 'off'); } catch {} toast(S.wheel ? 'Wheel steps frames' : 'Wheel scrubbing off'); };
let wheelAcc = 0;
function onWheel(e) {
  if (!S.wheel || !S.cur || e.ctrlKey) return;
  e.preventDefault();
  // Shift turns a vertical wheel into deltaX on Windows, so read whichever axis moved
  let d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  if (e.deltaMode === 1) d *= 40; else if (e.deltaMode === 2) d *= 400;
  // one mouse-wheel click = exactly one step; small trackpad deltas add up to one
  if (Math.abs(d) >= 50) wheelAcc = 0; else { wheelAcc += d; if (Math.abs(wheelAcc) < 50) return; d = wheelAcc; wheelAcc = 0; }
  step(Math.sign(d) * (e.shiftKey ? 10 : 1));
}
$('stage').addEventListener('wheel', onWheel, { passive: false });
$('timeline').addEventListener('wheel', onWheel, { passive: false });
$('btnLoop').onclick = () => { S.loop = !S.loop; $('btnLoop').classList.toggle('on', S.loop); };
$('btnMute').onclick = () => { video.muted = !video.muted; $('btnMute').textContent = video.muted ? '🔇' : '🔊'; };
$('vol').oninput = (e) => { video.volume = +e.target.value; };
const SPEEDS = [1, 1.5, 2, 2.5, 3, 0.5];
function setSpeed(r) {
  r = Math.round(Math.min(3, Math.max(0.25, r)) * 100) / 100;
  video.playbackRate = r; video.defaultPlaybackRate = r;
  $('btnSpeed').textContent = r + 'x'; $('speedRange').value = r;
}
$('btnSpeed').onclick = () => { const i = SPEEDS.indexOf(video.playbackRate); setSpeed(SPEEDS[(i + 1) % SPEEDS.length]); };
$('speedRange').oninput = (e) => setSpeed(+e.target.value);
video.addEventListener('loadedmetadata', () => { video.playbackRate = +$('speedRange').value; });
$('frameInput').onkeydown = (e) => { if (e.key === 'Enter') { seekFrame(parseInt(e.target.value, 10) || 0); e.target.blur(); } e.stopPropagation(); };
document.querySelectorAll('.tool').forEach(b => b.onclick = () => setTool(b.dataset.tool));
COLORS.forEach((c, i) => { const s = document.createElement('span'); s.className = 'sw' + (i ? '' : ' on'); s.style.background = c; s.onclick = () => { S.color = c; document.querySelectorAll('.sw').forEach(x => x.classList.toggle('on', x === s)); }; $('colors').appendChild(s); });
$('strokeW').onchange = (e) => { S.width = +e.target.value; };
$('btnUndo').onclick = () => { S.draft.shapes.pop(); updateComposer(); redraw(); };
$('btnClearDraw').onclick = () => { S.draft.shapes = []; updateComposer(); redraw(); };
setTool('none');

document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && ['q', 'w', 'e'].includes(e.key.toLowerCase()) && $('modal').classList.contains('hidden')) {
    e.preventDefault(); recallRemark('qwe'.indexOf(e.key.toLowerCase())); return;
  }
  if (e.key === 'Enter' && e.ctrlKey && document.activeElement === $('noteText')) { e.preventDefault(); saveRemark(); return; }
  if (e.key === 'Escape' && document.activeElement === $('noteText')) { $('noteText').blur(); return; }
  if (typing() || !$('modal').classList.contains('hidden')) return;
  const k = e.key;
  if ((e.ctrlKey || e.metaKey || e.altKey) && k.length === 1) { if ((k === 'z' || k === 'Z') && e.ctrlKey) $('btnUndo').click(); return; }
  if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 'ArrowRight') { e.preventDefault(); step(e.shiftKey ? 10 : 1); }
  else if (k === 'ArrowLeft') { e.preventDefault(); step(e.shiftKey ? -10 : -1); }
  else if (k === 'Home') seekFrame(0);
  else if (k === 'End') seekFrame(S.frames - 1);
  else if (k === 'k' || k === 'K') video.pause();
  else if (k === 'l' || k === 'L') { if (video.paused) video.play(); else setSpeed(video.playbackRate * 2); }
  else if (k === 's' || k === 'S') $('btnSpeed').click();
  else if (k === 'j' || k === 'J') step(-Math.round(S.fps)); // HTML video can't play backwards; jump back 1 s
  else if (k === '[') jumpNote(-1);
  else if (k === ']') jumpNote(1);
  else if (k === 'b' || k === 'B') setTool('pen');
  else if (k === 'r' || k === 'R') setTool('rect');
  else if (k === 'a' || k === 'A') setTool('arrow');
  else if (k === 'v' || k === 'V' || k === 'Escape') setTool('none');
  else if (k === 'c' || k === 'C') { e.preventDefault(); $('noteText').focus(); }
  else if (k === 'm' || k === 'M') $('btnMute').click();
  else if ((k === 'z' || k === 'Z') && e.ctrlKey) $('btnUndo').click();
});

// ---------- paste = instant remark (for dictation apps like Wispr Flow) ----------
// Text pasted while no text box has focus is saved straight away as a remark at the current frame,
// together with anything already drawn or typed in the composer.
try { S.quickPaste = localStorage.getItem('quickPaste') !== 'off'; } catch { S.quickPaste = true; }
function syncQuickPaste() { $('btnQuickPaste').classList.toggle('on', S.quickPaste); }
syncQuickPaste();
$('btnQuickPaste').onclick = () => {
  S.quickPaste = !S.quickPaste; syncQuickPaste();
  try { localStorage.setItem('quickPaste', S.quickPaste ? 'on' : 'off'); } catch {}
  toast(S.quickPaste ? 'Paste anywhere saves a remark' : 'Paste-to-save off');
};
document.addEventListener('paste', (e) => {
  if (!S.quickPaste || typing() || !$('modal').classList.contains('hidden')) return;
  const t = ((e.clipboardData && e.clipboardData.getData('text/plain')) || '').trim();
  if (!t) return;
  e.preventDefault();
  if (!S.cur) return toast('Open a video first, then paste or dictate a remark');
  quickRemark(t);
});
let quickBusy = Promise.resolve();
function quickRemark(t) {
  // queue them so two quick dictations can't collide
  quickBusy = quickBusy.then(async () => {
    if (!video.paused) { video.pause(); seekFrame(frameFromTime(video.currentTime)); }
    const before = $('noteText').value.trim();
    $('noteText').value = before ? before + ' ' + t : t;
    if (S.draft.frame == null) S.draft.frame = S.frame;
    await saveRemark(true);
  }).catch(e => { console.error(e); toast('Could not save that remark'); });
  return quickBusy;
}
let audioCtx = null;
function chime() {
  try {
    audioCtx = audioCtx || new AudioContext();
    const t0 = audioCtx.currentTime;
    [880, 1320].forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + i * 0.09);
      g.gain.exponentialRampToValueAtTime(0.12, t0 + i * 0.09 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.09 + 0.22);
      o.connect(g).connect(audioCtx.destination); o.start(t0 + i * 0.09); o.stop(t0 + i * 0.09 + 0.25);
    });
  } catch {}
}
function savedFeedback(note) {
  const words = note.text.length > 46 ? note.text.slice(0, 44) + '…' : note.text;
  toast(`✓ Saved at frame ${note.frame} · ${note.tc} — "${words}"`);
  const fb = $('frameBox'); fb.classList.remove('savedflash'); void fb.offsetWidth; fb.classList.add('savedflash');
  chime();
  const el = document.querySelector(`.note[data-id="${note.id}"]`);
  if (el) { el.scrollIntoView({ block: 'nearest' }); el.classList.add('justsaved'); setTimeout(() => el.classList.remove('justsaved'), 1600); }
}

// ---------- boot ----------
(async () => {
  const init = await api.init();
  S.recents = init.settings.recents || [];
  await refresh();
  if (init.selftest) return selftest(init.selftest);
  if (init.settings.lastOpened) await openByPath(init.settings.lastOpened).catch(() => {});
  if (init.libtest) libtest(init.libtest, init.settings);
})();

// ---------- self-test: proves the frame readout matches the frame on screen ----------
async function selftest(videoPath) {
  ['play', 'pause', 'seeked', 'loadedmetadata', 'loadeddata', 'error', 'emptied', 'waiting', 'stalled'].forEach(ev => video.addEventListener(ev, () => console.log(`ev ${ev} t=${video.currentTime.toFixed(3)} paused=${video.paused} rs=${video.readyState} frame=${S.frame} src=${(video.currentSrc || '').slice(-30)}`)));
  const out = videoPath.replace(/[^\\]+$/, '') + 'selftest\\';
  const result = { readouts: [], captures: [] };
  const pseudo = { name: '_selftest', path: videoPath.replace(/\\[^\\]+$/, ''), versions: [] };
  const v = { name: 'selftest', file: videoPath.split('\\').pop(), path: videoPath };
  pseudo.versions = [v];
  await openVersion(pseudo, v, { force: true });
  const settle0 = () => new Promise(r => setTimeout(r, 900));
  if (!video.getAttribute('src')) {
    await settle0(); result.captures.push(await api.capture(`${out}prores_offer.png`));
    const r0 = await api.proxyMake(videoPath, { frames: S.frames });
    result.proxy = r0; await setSource(r0.proxy, true);
    for (const f of [0, 37, 150, S.frames - 1]) { seekFrame(f); await waitPresented(); await settle0(); result.captures.push(await api.capture(`${out}prores_proxy_f${f}.png`)); result.readouts.push({ tag: 'prores-proxy', target: f, readout: S.frame, presented: S.shown }); }
    return api.selftestDone(result);
  }
  const settle = () => new Promise(r => setTimeout(r, 700));
  const run = async (tag) => {
    for (const f of [0, 1, 37, 150, S.frames - 1]) {
      seekFrame(f); await waitPresented(); await settle();
      const file = await api.capture(`${out}${tag}_f${f}.png`);
      result.readouts.push({ tag, target: f, readout: S.frame, presented: S.shown });
      result.captures.push(file);
    }
  };
  await run('direct');
  // play for a moment and pause, check the readout snaps to a real frame
  video.play(); await new Promise(r => setTimeout(r, 1300)); video.pause(); await waitPresented(); await settle();
  result.captures.push(await api.capture(`${out}direct_afterplay.png`));
  result.readouts.push({ tag: 'afterplay', readout: S.frame, presented: S.shown });
  // a remark with a box, an arrow and a brush stroke
  seekFrame(37); await waitPresented();
  S.draft = { frame: 37, frameEnd: null, shapes: [
    { type: 'rect', color: '#ff4d4d', width: 5, x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
    { type: 'arrow', color: '#3fc8ff', width: 5, x1: 0.1, y1: 0.9, x2: 0.3, y2: 0.6 },
    { type: 'pen', color: '#ffd23f', width: 5, points: [[0.8, 0.2], [0.85, 0.25], [0.9, 0.2]] }] };
  $('noteText').value = 'Self-test remark: the number in the box should read 37.';
  await saveRemark();
  // recall the last remark at another frame (Ctrl+Q), save it, then show all, newest first
  seekFrame(150); await waitPresented();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', ctrlKey: true, bubbles: true }));
  $('noteText').value += ' (recalled at 150)';
  await saveRemark();
  document.querySelector('#filterSeg button[data-f=all]').click();
  S.sort = 'asc'; $('btnSort').click(); // -> desc
  S.doc.notes[0].status = 'done'; await persist(); renderNotes();
  await settle();
  result.captures.push(await api.capture(`${out}notes_panel.png`));
  result.recallOk = S.doc.notes.length === 2 && S.doc.notes[1].frame === 150 && S.doc.notes[1].shapes.length === 3;
  // an unsaved remark survives re-opening the version (same storage survives an app restart)
  seekFrame(77); await settle(); $('noteText').focus(); $('noteText').value = 'unsaved draft'; $('noteText').dispatchEvent(new Event('input')); $('noteText').blur();
  await openVersion(pseudo, v, { force: true }); await settle();
  result.draft = { text: $('noteText').value, frame: S.draft.frame, playhead: S.frame };
  result.draftOk = result.draft.text === 'unsaved draft' && S.draft.frame === 77 && S.frame === 77;
  $('btnCancelDraft').click(); await settle();
  result.draftClearedOk = !$('noteText').value && !localStorage.getItem(draftKey());
  const ex = await api.expandDrop([videoPath.replace(/[\\/][^\\/]+$/, ''), videoPath, videoPath + '.nope']);
  result.expandDrop = ex.map(i => ({ isDir: i.isDir, name: i.name, n: i.videos && i.videos.length }));
  // real Ctrl+V with no text box focused saves a remark at the current frame
  seekFrame(120); setTool('rect'); await settle(); document.activeElement && document.activeElement.blur();
  await api.copy('dictated remark from wispr');
  const before = S.doc.notes.length;
  await api.test('input', [{ type: 'keyDown', keyCode: 'V', modifiers: ['control'] }, { type: 'keyUp', keyCode: 'V', modifiers: ['control'], wait: 1500 }]);
  await quickBusy;
  const pn = S.doc.notes[S.doc.notes.length - 1];
  result.paste = { added: S.doc.notes.length - before, frame: pn && pn.frame, text: pn && pn.text, tool: S.tool, composer: $('noteText').value };
  result.pasteOk = result.paste.added === 1 && pn.frame === 120 && pn.text === 'dictated remark from wispr' && !$('noteText').value && S.tool === 'rect';
  // real mouse-wheel input over the video: 3 clicks down = +3, 1 click up = -1, Shift+down = +10
  seekFrame(50); await settle();
  const sr = $('stage').getBoundingClientRect(), wx = Math.round(sr.left + sr.width / 2), wy = Math.round(sr.top + sr.height / 2);
  const wh = (dy, mods = []) => ({ type: 'mouseWheel', x: wx, y: wy, deltaX: 0, deltaY: dy, modifiers: mods, wait: 120 });
  await api.test('input', [{ type: 'mouseMove', x: wx, y: wy }, wh(-100), wh(-100), wh(-100)]);
  const w1 = S.frame;
  await api.test('input', [wh(100)]);
  const w2 = S.frame;
  await api.test('input', [wh(-100, ['shift'])]);
  result.wheel = { after3down: w1, after1up: w2, afterShiftDown: S.frame };
  result.wheelOk = (w1 === 53 && w2 === 52 && S.frame === 62) || (w1 === 47 && w2 === 48 && S.frame === 38);
  // proxy path
  const r = await api.proxyMake(videoPath, { frames: S.frames });
  result.proxy = r;
  if (r.ok) { await setSource(r.proxy, true); await run('proxy'); }
  result.notesMd = S.paths.md; result.fps = S.fps; result.frames = S.frames;
  await api.selftestDone(result);
}


// ---------- library test: real folders, real mouse + keyboard input ----------
async function libtest(phase, settings) {
  const R = { phase }; const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const src = settings.libraryRoot.replace(/\\[^\\]+$/, '') + '\\lib_src\\';
  try {
    if (phase === '2') { R.reopened = S.cur ? S.cur.version.path : null; return api.test('done', R); }
    const dir = await api.projectCreate('Alpha');
    R.imported = await api.importVideos(dir, [src + 'v1_old.mp4', src + 'v2_new.mp4']);
    await refresh();
    let p = S.projects.find(x => x.name === 'Alpha');
    R.afterImport = p.versions.map(v => ({ name: v.name, latest: !!v.latest, mtime: new Date(v.mtime).toISOString() }));
    // a render dropped into the folder from outside
    const v3 = dir + '\\v3_dropped.mp4';
    await api.test('copy', src + 'v2_new.mp4', v3); await api.test('touch', { path: v3, ms: Date.now() });
    const t0 = Date.now(); let seen = false;
    while (Date.now() - t0 < 12000) { await wait(500); p = S.projects.find(x => x.name === 'Alpha'); if (p && p.versions.some(v => v.file === 'v3_dropped.mp4' && !v.writing)) { seen = true; break; } }
    R.watcherSaw = seen; R.watcherMs = Date.now() - t0;
    R.afterDrop = p.versions.map(v => ({ name: v.name, latest: !!v.latest }));
    // open v2, draw a box with the real mouse
    await openVersion(p, p.versions.find(v => v.name === 'v2_new'), { force: true });
    seekFrame(40); await waitPresented(); await wait(400);
    setTool('rect');
    const r = overlay.getBoundingClientRect();
    const pt = (fx, fy) => ({ x: Math.round(r.left + r.width * fx), y: Math.round(r.top + r.height * fy) });
    const a = pt(0.25, 0.25), b = pt(0.75, 0.75), m = pt(0.5, 0.5);
    await api.test('input', [
      { type: 'mouseMove', ...a }, { type: 'mouseDown', ...a, button: 'left', clickCount: 1 },
      { type: 'mouseMove', ...m, button: 'left' }, { type: 'mouseMove', ...b, button: 'left' },
      { type: 'mouseUp', ...b, button: 'left', clickCount: 1, wait: 200 }]);
    R.rect = S.draft.shapes[0] || null;
    // type a remark with real keys and save with Ctrl+Enter
    setTool('none'); $('noteText').focus();
    await api.test('input', [...'fix logo'].map(ch => ({ type: 'char', keyCode: ch })));
    await api.test('input', [{ type: 'keyDown', keyCode: 'Return', modifiers: ['control'] }, { type: 'keyUp', keyCode: 'Return', modifiers: ['control'], wait: 1500 }]);
    R.notesAfterSave = S.doc.notes.map(n => ({ frame: n.frame, text: n.text, shapes: n.shapes.length }));
    // second remark at 60 via Ctrl+Q, then Ctrl+W at 100 must bring back the 2nd-last (the first one)
    $('noteText').blur(); seekFrame(60); await waitPresented();
    await api.test('input', [{ type: 'keyDown', keyCode: 'Q', modifiers: ['control'] }, { type: 'keyUp', keyCode: 'Q', modifiers: ['control'], wait: 200 }]);
    await api.test('input', [...' again'].map(ch => ({ type: 'char', keyCode: ch })));
    await api.test('input', [{ type: 'keyDown', keyCode: 'Return', modifiers: ['control'] }, { type: 'keyUp', keyCode: 'Return', modifiers: ['control'], wait: 1500 }]);
    $('noteText').blur(); seekFrame(100); await waitPresented();
    await api.test('input', [{ type: 'keyDown', keyCode: 'W', modifiers: ['control'] }, { type: 'keyUp', keyCode: 'W', modifiers: ['control'], wait: 400 }]);
    R.ctrlW = { composer: $('noteText').value, draftFrame: S.draft.frame, shapes: S.draft.shapes.length, windowAlive: true };
    R.notes = S.doc.notes.map(n => ({ frame: n.frame, text: n.text }));
    R.notesMd = S.paths.md;
    R.expectReopen = S.cur.version.path;
    await api.capture(settings.libraryRoot + '\\..\\libtest.png');
  } catch (e) { R.error = String(e && e.stack || e); }
  api.test('done', R);
}
