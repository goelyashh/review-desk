// Review Desk: main process.
// Library layout: <root>/<Project>/<video files = versions>
// Review data:    <root>/<Project>/_review/<video file name>/notes.json | notes.md | frames/*.png | proxy.mp4
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const { spawn, execFile } = require('child_process');

// Keep app data on F: (C: is small).
// Fixed folder shared by the dev run and the packaged exe (repackaging must not wipe settings).
const argVal = (k) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const LIBTEST = argVal('libtest');
const DATA_DIR = argVal('data') || (fs.existsSync('F:\\') ? 'F:\\Tools\\review-desk\\userdata' : path.join(require('os').homedir(), 'AppData', 'Roaming', 'Review Desk'));
app.setPath('userData', DATA_DIR);
app.setPath('sessionData', path.join(DATA_DIR, 'session'));

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.mxf']);
const REVIEW_DIR = '_review';
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const DEFAULT_ROOT = 'F:\\Editing\\Review Library';

let win = null;
let settings = { libraryRoot: DEFAULT_ROOT, recents: [], lastOpened: null };
let server = null;
let serverPort = 0;
const extraAllowed = new Set();
const args = process.argv.slice(1);
const SELFTEST = args.includes('--selftest');

// ---------- settings ----------
function loadSettings() {
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; } catch {}
  if (argVal('root')) settings.libraryRoot = argVal('root');
  fs.mkdirSync(settings.libraryRoot, { recursive: true });
}
function saveSettings() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeAtomic(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// ---------- local media server (Range + CORS, so seeking works and canvas stays untainted) ----------
const MIME = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.png': 'image/png', '.jpg': 'image/jpeg' };
function isAllowed(p) {
  const abs = path.resolve(p).toLowerCase();
  const root = path.resolve(settings.libraryRoot).toLowerCase() + path.sep;
  return abs.startsWith(root) || [...extraAllowed].some(d => abs.startsWith(d + path.sep));
}
function startServer() {
  return new Promise((resolve) => {
    server = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Range');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      try {
        const u = new URL(req.url, 'http://127.0.0.1');
        const p = u.searchParams.get('p');
        if (u.pathname !== '/f' || !p || !isAllowed(p)) { res.writeHead(403); return res.end(); }
        const st = await fsp.stat(p);
        const type = MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
        const range = req.headers.range;
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', type);
        res.setHeader('Cache-Control', 'no-store');
        if (range) {
          const m = /bytes=(\d*)-(\d*)/.exec(range);
          let start = m && m[1] ? parseInt(m[1], 10) : 0;
          let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
          if (m && !m[1] && m[2]) { start = st.size - parseInt(m[2], 10); end = st.size - 1; }
          if (start >= st.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
          end = Math.min(end, st.size - 1);
          res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
          if (req.method === 'HEAD') return res.end();
          fs.createReadStream(p, { start, end }).on('error', () => res.destroy()).pipe(res);
        } else {
          res.writeHead(200, { 'Content-Length': st.size });
          if (req.method === 'HEAD') return res.end();
          fs.createReadStream(p).on('error', () => res.destroy()).pipe(res);
        }
      } catch (e) { res.writeHead(404); res.end(); }
    });
    server.listen(0, '127.0.0.1', () => { serverPort = server.address().port; resolve(); });
  });
}
const mediaUrl = (p, bust) => `http://127.0.0.1:${serverPort}/f?p=${encodeURIComponent(p)}${bust ? '&v=' + bust : ''}`;

// ---------- paths ----------
function reviewDirFor(videoPath) {
  return path.join(path.dirname(videoPath), REVIEW_DIR, path.basename(videoPath));
}
function notesPaths(videoPath) {
  const d = reviewDirFor(videoPath);
  return { dir: d, json: path.join(d, 'notes.json'), md: path.join(d, 'notes.md'), frames: path.join(d, 'frames'), proxy: path.join(d, 'proxy.mp4') };
}

// ---------- library scan ----------
async function readNotesSummary(videoPath) {
  try {
    const j = JSON.parse(await fsp.readFile(notesPaths(videoPath).json, 'utf8'));
    const notes = j.notes || [];
    return { total: notes.length, open: notes.filter(n => n.status !== 'done').length };
  } catch { return { total: 0, open: 0 }; }
}
async function scanLibrary() {
  const root = settings.libraryRoot;
  await fsp.mkdir(root, { recursive: true });
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const projects = [];
  const now = Date.now();
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue;
    const pdir = path.join(root, e.name);
    let files = [];
    try { files = await fsp.readdir(pdir, { withFileTypes: true }); } catch { continue; }
    const versions = [];
    for (const f of files) {
      if (!f.isFile() || !VIDEO_EXT.has(path.extname(f.name).toLowerCase())) continue;
      const vp = path.join(pdir, f.name);
      let st; try { st = await fsp.stat(vp); } catch { continue; }
      const summary = await readNotesSummary(vp);
      versions.push({
        name: path.parse(f.name).name, file: f.name, path: vp,
        mtime: st.mtimeMs, size: st.size,
        writing: now - st.mtimeMs < 4000, // a render still being written
        notesPath: notesPaths(vp).md, ...summary,
      });
    }
    versions.sort((a, b) => b.mtime - a.mtime);
    if (versions.length) versions[0].latest = true;
    let pst; try { pst = await fsp.stat(pdir); } catch {}
    projects.push({ name: e.name, path: pdir, versions, mtime: versions[0] ? versions[0].mtime : (pst ? pst.mtimeMs : 0) });
  }
  projects.sort((a, b) => b.mtime - a.mtime);
  writeIndex(projects);
  return { root, projects };
}
function writeIndex(projects) {
  const lines = ['# Review Library index', '', `Library: \`${settings.libraryRoot}\``, `Updated: ${new Date().toLocaleString()}`, '',
    'Each project is a folder; each video file in it is a version (newest by date modified = latest).',
    'Notes for a version live in `<project>/_review/<video file>/notes.md`.', ''];
  for (const p of projects) {
    lines.push(`## ${p.name}`, '');
    for (const v of p.versions) {
      lines.push(`- ${v.latest ? '**LATEST** ' : ''}${v.file} - ${new Date(v.mtime).toLocaleString()} - open notes: ${v.open}/${v.total}${v.total ? ` - notes: \`${v.notesPath}\`` : ''}`);
    }
    if (!p.versions.length) lines.push('- (no videos yet)');
    lines.push('');
  }
  try { writeAtomic(path.join(settings.libraryRoot, '_review-index.md'), lines.join('\r\n')); } catch {}
}

// ---------- watcher ----------
let watcher = null, watchTimer = null, watchTimer2 = null;
function startWatcher() {
  if (watcher) { try { watcher.close(); } catch {} }
  try {
    watcher = fs.watch(settings.libraryRoot, { recursive: true }, (ev, name) => {
      if (!name) return;
      const n = String(name);
      const segs = n.split(/[\\/]/);
      if (segs.includes(REVIEW_DIR) || n.endsWith('_review-index.md') || n.includes('.tmp-')) return;
      clearTimeout(watchTimer); clearTimeout(watchTimer2);
      watchTimer = setTimeout(() => win && win.webContents.send('library-changed'), 1200);
      watchTimer2 = setTimeout(() => win && win.webContents.send('library-changed'), 5500); // after a render settles
    });
  } catch {}
}

// ---------- ffprobe ----------
function probe(videoPath) {
  return new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=codec_name,width,height,r_frame_rate,avg_frame_rate,nb_frames,duration,pix_fmt:format=duration',
      '-of', 'json', videoPath], { windowsHide: true }, (err, out) => {
      if (err) return resolve({ ok: false, error: String(err.message || err) });
      try {
        const j = JSON.parse(out);
        const s = (j.streams || [])[0] || {};
        const rate = (r) => { if (!r) return 0; const [a, b] = r.split('/').map(Number); return b ? a / b : a; };
        const fps = rate(s.r_frame_rate) || rate(s.avg_frame_rate) || 30;
        const duration = parseFloat(s.duration || (j.format || {}).duration || 0);
        const frames = parseInt(s.nb_frames, 10) || Math.round(duration * fps);
        resolve({ ok: true, codec: s.codec_name, width: s.width, height: s.height, fps, fpsText: s.r_frame_rate, duration, frames, pixFmt: s.pix_fmt });
      } catch (e) { resolve({ ok: false, error: String(e) }); }
    });
  });
}

// ---------- notes ----------
function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function tcOf(frame, fps) {
  const f = Math.round(fps) || 30;
  const total = Math.floor(frame / f), ff = frame % f;
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}:${pad(ff)}`;
}
const COLOR_NAMES = { '#ff4d4d': 'red', '#ffd23f': 'yellow', '#3ecf8e': 'green', '#3fc8ff': 'cyan', '#ffffff': 'white', '#c06bff': 'purple' };
function shapeLines(shape0, W, H) {
  const shape = { ...shape0, color: COLOR_NAMES[String(shape0.color).toLowerCase()] || shape0.color };
  const px = (v, s) => Math.round(v * s);
  if (shape.type === 'rect') return `Box (${shape.color}): x=${px(shape.x, W)}, y=${px(shape.y, H)}, w=${px(shape.w, W)}, h=${px(shape.h, H)} px`;
  if (shape.type === 'arrow') return `Arrow (${shape.color}): from (${px(shape.x1, W)}, ${px(shape.y1, H)}) to (${px(shape.x2, W)}, ${px(shape.y2, H)}) px - points at (${px(shape.x2, W)}, ${px(shape.y2, H)})`;
  if (shape.type === 'pen') {
    const xs = shape.points.map(p => p[0]), ys = shape.points.map(p => p[1]);
    const x0 = Math.min(...xs), y0 = Math.min(...ys), x1 = Math.max(...xs), y1 = Math.max(...ys);
    return `Brush stroke (${shape.color}): covers x=${px(x0, W)}..${px(x1, W)}, y=${px(y0, H)}..${px(y1, H)} px`;
  }
  return '';
}
function buildMarkdown(doc, onlyOpen) {
  const W = doc.width || 1920, H = doc.height || 1080;
  const notes = [...(doc.notes || [])].sort((a, b) => a.frame - b.frame).filter(n => !onlyOpen || n.status !== 'done');
  const open = (doc.notes || []).filter(n => n.status !== 'done').length;
  const L = [];
  L.push(`# Review notes: ${doc.project} / ${doc.version}`, '');
  L.push(`- Video: \`${doc.video}\``);
  L.push(`- Notes file: \`${notesPaths(doc.video).md}\``);
  L.push(`- ${W}x${H}, ${Number(doc.fps).toFixed(3).replace(/\.?0+$/, '')} fps (${doc.fpsText || ''}), ${doc.frames} frames, ${Number(doc.duration || 0).toFixed(2)} s`);
  L.push(`- Frames are 0-based (frame 0 = first frame). Timecode is HH:MM:SS:FF. Coordinates are source-video pixels from the top-left.`);
  L.push(`- Each remark has a snapshot PNG of that exact frame with the drawing on it${doc.snapW && doc.snapW !== W ? ` (snapshots are ${doc.snapW}x${doc.snapH}, a preview-size copy; coordinates stay in source pixels)` : ''}.`);
  L.push(`- Open: ${open}, done: ${(doc.notes || []).length - open}. Updated ${new Date(doc.updated || Date.now()).toLocaleString()}.`);
  if (doc.videoChanged) L.push(`- WARNING: the video file changed after some notes were written; frames may have shifted.`);
  L.push('');
  if (!notes.length) L.push(onlyOpen ? '_No open remarks._' : '_No remarks yet._');
  notes.forEach((n, i) => {
    const end = n.frameEnd != null && n.frameEnd > n.frame ? ` to ${n.frameEnd} (${tcOf(n.frameEnd, doc.fps)})` : '';
    L.push(`## ${i + 1}. Frame ${n.frame}${end} - ${tcOf(n.frame, doc.fps)} - ${(n.frame / doc.fps).toFixed(3)} s - ${n.status === 'done' ? 'DONE' : 'OPEN'}`, '');
    L.push((n.text || '').trim() || '_(drawing only)_', '');
    for (const s of n.shapes || []) L.push(`- ${shapeLines(s, W, H)}`);
    if (n.snapshot) L.push(`- Snapshot: \`${n.snapshot}\``);
    L.push('');
  });
  return L.join('\r\n');
}
async function loadNotes(videoPath) {
  const np = notesPaths(videoPath);
  let doc = null;
  try { doc = JSON.parse(await fsp.readFile(np.json, 'utf8')); } catch {}
  const st = await fsp.stat(videoPath).catch(() => null);
  const changed = !!(doc && st && doc.videoSize && (doc.videoSize !== st.size || Math.abs(doc.videoMtime - st.mtimeMs) > 2000));
  return { doc, changed, paths: np };
}
async function saveNotes(doc) {
  const np = notesPaths(doc.video);
  const st = await fsp.stat(doc.video).catch(() => null);
  if (st && !doc.videoChanged) { doc.videoSize = st.size; doc.videoMtime = st.mtimeMs; }
  doc.updated = Date.now();
  await fsp.mkdir(np.dir, { recursive: true });
  writeAtomic(np.json, JSON.stringify(doc, null, 2));
  writeAtomic(np.md, buildMarkdown(doc, false));
  scanLibrary().catch(() => {}); // keeps _review-index.md open counts current
  return { ok: true, paths: np };
}

// ---------- proxy ----------
const proxyJobs = new Map();
function makeProxy(videoPath, info) {
  const np = notesPaths(videoPath);
  fs.mkdirSync(np.dir, { recursive: true });
  const tmp = np.proxy.replace(/\.mp4$/, '.part.mp4');
  const fa = ['-y', '-v', 'error', '-progress', 'pipe:1', '-i', videoPath,
    '-map', '0:v:0', '-map', '0:a:0?', '-fps_mode', 'passthrough',
    '-vf', "scale='if(gt(ih,1080),-2,iw)':'if(gt(ih,1080),1080,ih)',format=yuv420p",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-g', '12',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', tmp];
  return new Promise((resolve) => {
    const p = spawn('ffmpeg', fa, { windowsHide: true });
    proxyJobs.set(videoPath, p);
    let err = '';
    p.stdout.on('data', (d) => {
      const m = /frame=(\d+)/.exec(String(d));
      if (m && win) win.webContents.send('proxy-progress', { video: videoPath, frame: +m[1], frames: info.frames });
    });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      proxyJobs.delete(videoPath);
      if (code === 0) {
        try { fs.renameSync(tmp, np.proxy); const st = fs.statSync(videoPath); writeAtomic(np.proxy + '.json', JSON.stringify({ size: st.size, mtime: st.mtimeMs })); }
        catch (e) { return resolve({ ok: false, error: String(e) }); }
        resolve({ ok: true, proxy: np.proxy });
      }
      else { try { fs.unlinkSync(tmp); } catch {} resolve({ ok: false, error: err.slice(-800) || 'ffmpeg failed' }); }
    });
  });
}

// ---------- import ----------
async function importInto(projectDir, files) {
  const out = [];
  for (const src of files) {
    const dest0 = path.join(projectDir, path.basename(src));
    if (path.resolve(src).toLowerCase() === path.resolve(dest0).toLowerCase()) { out.push(dest0); continue; }
    let dest = dest0, i = 2;
    while (fs.existsSync(dest)) { const pp = path.parse(dest0); dest = path.join(pp.dir, `${pp.name} (${i++})${pp.ext}`); }
    // a real copy (a hard link would change when the source is re-rendered); keep the source's date modified
    await fsp.copyFile(src, dest);
    try { const st = await fsp.stat(src); await fsp.utimes(dest, st.atime, st.mtime); } catch {}
    out.push(dest);
  }
  return out;
}

function addRecent(item) {
  settings.recents = [item, ...settings.recents.filter(r => r.path.toLowerCase() !== item.path.toLowerCase())].slice(0, 15);
  settings.lastOpened = item.path;
  saveSettings();
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('init', async () => ({ settings, port: serverPort, libtest: LIBTEST, selftest: SELFTEST ? (args[args.indexOf('--selftest') + 1] || null) : null }));
  ipcMain.handle('scan', () => scanLibrary());
  ipcMain.handle('media-url', (_e, p, bust) => mediaUrl(p, bust));
  ipcMain.handle('probe', (_e, p) => probe(p));
  ipcMain.handle('notes-load', (_e, p) => loadNotes(p));
  ipcMain.handle('notes-save', (_e, doc) => saveNotes(doc));
  ipcMain.handle('notes-markdown', (_e, doc, onlyOpen) => buildMarkdown(doc, onlyOpen));
  ipcMain.handle('snapshot-save', async (_e, videoPath, name, dataUrl) => {
    const np = notesPaths(videoPath);
    await fsp.mkdir(np.frames, { recursive: true });
    const file = path.join(np.frames, name);
    await fsp.writeFile(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
    return file;
  });
  ipcMain.handle('snapshot-delete', async (_e, file) => {
    if (file && isAllowed(file) && file.includes(REVIEW_DIR)) { try { await fsp.unlink(file); } catch {} }
  });
  ipcMain.handle('proxy-exists', (_e, p) => {
    const px = notesPaths(p).proxy;
    try {
      const m = JSON.parse(fs.readFileSync(px + '.json', 'utf8')), st = fs.statSync(p);
      if (fs.existsSync(px) && m.size === st.size && Math.abs(m.mtime - st.mtimeMs) < 2000) return px;
    } catch {}
    return null; // missing, or made from an older render of this file
  });
  ipcMain.handle('proxy-make', (_e, p, info) => makeProxy(p, info));
  ipcMain.handle('copy', (_e, text) => { clipboard.writeText(text); return true; });
  ipcMain.handle('reveal', (_e, p) => { shell.showItemInFolder(p); });
  ipcMain.handle('open-path', (_e, p) => shell.openPath(p));
  ipcMain.handle('recent-add', (_e, item) => { addRecent(item); return settings.recents; });
  ipcMain.handle('recent-clear', () => { settings.recents = []; saveSettings(); return []; });
  ipcMain.handle('choose-root', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Choose review library folder', defaultPath: settings.libraryRoot, properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    settings.libraryRoot = r.filePaths[0]; saveSettings(); startWatcher();
    return settings.libraryRoot;
  });
  ipcMain.handle('project-create', async (_e, name) => {
    const clean = String(name || '').replace(/[<>:"/\\|?*]+/g, '-').trim();
    if (!clean) return null;
    const d = path.join(settings.libraryRoot, clean);
    await fsp.mkdir(d, { recursive: true });
    return d;
  });
  ipcMain.handle('pick-videos', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Add video versions', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Video', extensions: [...VIDEO_EXT].map(e => e.slice(1)) }] });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('import', (_e, projectDir, files) => importInto(projectDir, files));
  ipcMain.handle('capture', async (_e, file) => {
    const img = await win.webContents.capturePage();
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, img.toPNG());
    return file;
  });
  ipcMain.handle('test', async (_e, op, a, b) => {
    if (!LIBTEST && !SELFTEST) return null;
    if (op === 'copy') { await fsp.copyFile(a, b); return true; }
    if (op === 'touch') { const t = new Date(a.ms); await fsp.utimes(a.path, t, t); return true; }
    if (op === 'input') { for (const ev of a) { win.webContents.sendInputEvent(ev); await new Promise(r => setTimeout(r, ev.wait || 30)); } return true; }
    if (op === 'stat') { const st = await fsp.stat(a); return { size: st.size, mtime: st.mtimeMs }; }
    if (op === 'done') { fs.writeFileSync(path.join(DATA_DIR, `libtest-${LIBTEST}.json`), JSON.stringify(a, null, 2)); setTimeout(() => app.quit(), 300); return true; }
    return null;
  });
  ipcMain.handle('selftest-done', (_e, result) => {
    try { fs.writeFileSync(path.join(path.dirname(args[args.indexOf('--selftest') + 1]), 'selftest-result.json'), JSON.stringify(result, null, 2)); } catch {}
    setTimeout(() => app.quit(), 300);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 960, minWidth: 1100, minHeight: 680,
    backgroundColor: '#111214', title: 'Review Desk', autoHideMenuBar: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  const logFile = path.join(DATA_DIR, 'app.log');
  const log = (s) => { try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${s}\n`); } catch {} };
  win.webContents.on('console-message', (_e, level, message, line, src) => { if (level >= 1 || SELFTEST) log(`renderer: ${message} (${path.basename(src || '')}:${line})`); });
  win.webContents.on('render-process-gone', (_e, d) => log('render-process-gone ' + JSON.stringify(d)));
  win.webContents.on('preload-error', (_e, p, err) => log('preload-error ' + err));
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

const gotLock = SELFTEST || LIBTEST || app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    loadSettings();
    if (SELFTEST) { const t = args[args.indexOf('--selftest') + 1]; if (t) extraAllowed.add(path.dirname(path.resolve(t)).toLowerCase()); }
    await startServer();
    registerIpc();
    startWatcher();
    // no default menu: frees Ctrl+W / Ctrl+Q for "recall remark"; keep reload + devtools on F5 / F12
    Menu.setApplicationMenu(null);
    createWindow();
    win.webContents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      if (input.key === 'F5') { win.webContents.reloadIgnoringCache(); e.preventDefault(); }
      if (input.key === 'F12') { win.webContents.toggleDevTools(); e.preventDefault(); }
    });
  });
  app.on('window-all-closed', () => app.quit());
}
