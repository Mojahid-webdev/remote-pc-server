(() => {
'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ================= storage / settings ================= */
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const cfg = Object.assign(
  { sens: 1.4, scroll: 1.0, natural: true, tap: true, mode: 'rel', mac: '', loupe: true, lz: 3, lr: 68, live: true, qual: 1, theme: 'dark', accent: '#c8ff3e' },
  LS.get('cfg', {})
);
const saveCfg = () => LS.set('cfg', cfg);
let token = LS.get('token', '');

const ZL = [1, 1.5, 2, 3, 4, 6];
const QUAL = [{ w: 800, q: 52, fps: 12 }, { w: 1280, q: 70, fps: 16 }, { w: 1600, q: 80, fps: 18 }];

function applyTheme() {
  const r = document.documentElement, a = /^#[0-9a-f]{6}$/i.test(cfg.accent) ? cfg.accent : '#c8ff3e';
  r.dataset.theme = cfg.theme === 'light' ? 'light' : 'dark';
  const n = parseInt(a.slice(1), 16), R = n >> 16, G = (n >> 8) & 255, B = n & 255;
  const lum = (0.299 * R + 0.587 * G + 0.114 * B) / 255;
  r.style.setProperty('--accent', a);
  r.style.setProperty('--accent-dim', `color-mix(in srgb, ${a} 55%, ${cfg.theme === 'light' ? '#fff' : '#000'})`);
  r.style.setProperty('--on', lum > 0.55 ? '#0a0c0b' : '#ffffff');
  const m = document.querySelector('meta[name=theme-color]');
  if (m) m.content = cfg.theme === 'light' ? '#f1f3ef' : '#0a0c0b';
  dirty = true;
}
const buzz = (ms) => { try { navigator.vibrate && navigator.vibrate(ms); } catch {} };
let toastTimer = 0;
function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/* ================= connection ================= */
let ws = null, authed = false, retry = 1000, pingTimer = 0, wakePending = 0, sid = '';
const state = { agent: false, agentName: '', helpers: [], info: null };

function showLogin(msg) {
  $('#app').hidden = true;
  $('#login').hidden = false;
  if (msg) $('#loginMsg').textContent = msg;
}
function showApp() { $('#login').hidden = true; $('#app').hidden = false; }

function connect() {
  if (!token) return showLogin();
  showApp();
  clearTimeout(connect.t);
  try { ws && ws.close(); } catch {}
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  sid = Math.random().toString(36).slice(2, 10);
  wasViewing = false;
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  const mine = ws;
  ws.onopen = () => mine.send(JSON.stringify({ t: 'auth', token, role: 'phone', name: 'phone' }));
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return onFrame(e.data);
    let m; try { m = JSON.parse(e.data); } catch { return; }
    onMsg(m);
  };
  ws.onclose = (ev) => {
    if (mine !== ws) return;
    authed = false;
    clearInterval(pingTimer);
    clearScreen();
    renderStatus();
    if (ev.code === 4003) { token = ''; LS.set('token', ''); return showLogin('Wrong token. Try again.'); }
    if (ev.code === 4029) toast('Too many wrong tries. Wait 15 min.', 4000);
    connect.t = setTimeout(connect, retry);
    retry = Math.min(retry * 1.7, 10000);
  };
  ws.onerror = () => {};
}
function tx(o) { if (ws && ws.readyState === 1 && authed) ws.send(JSON.stringify(o)); }

let lat = null;
function onMsg(m) {
  switch (m.t) {
    case 'auth':
      if (m.ok) {
        authed = true; retry = 1000;
        clearInterval(pingTimer);
        pingTimer = setInterval(() => tx({ t: 'ping', ts: performance.now() }), 3000);
        tx({ t: 'ping', ts: performance.now() });
        renderStatus(); sendView();
      }
      break;
    case 'pong': lat = Math.round(performance.now() - m.ts); renderStatus(); break;
    case 'presence': {
      const was = state.agent;
      state.agent = m.agent; state.agentName = m.agentName || '';
      state.helpers = m.helpers || []; state.info = m.info;
      if (!state.agent) clearScreen();
      autoMac(); renderStatus(); renderAdapters(); sendView();
      if (!was && state.agent && wakePending) { wakePending = 0; toast('PC is online ✓', 3500); buzz([30, 40, 30]); if (typeof jcAdd === 'function') jcAdd('jc', 'PC chalu hoyeche.'); }
      break;
    }
    case 'cur': cur = { x: m.x, y: m.y }; break;
    case 'toast': toast(m.text); break;
    case 'jcr': jcReply(m); break;
    case 'clip': onClip(m.text); break;
    case 'wake_sent':
      toast(m.helpers ? `Wake sent via ${m.helpers} helper${m.helpers > 1 ? 's' : ''}…` : 'No helper online. Open Termux on the helper phone.', 3500);
      if (!m.helpers && typeof jcAdd === 'function') jcAdd('jc', 'Helper phone online nei, tai PC chalu korte parlam na. Helper phone (Termux) lagbe.');
      break;
    case 'wake_ack':
      if (!m.ok) toast(`${m.name}: ${m.error || 'wake failed'}`, 3500);
      break;
  }
}
function autoMac() {
  const list = (state.info && state.info.adapters) || [];
  if (!list.length) return;
  const best = list.find((a) => /ethernet|lan/i.test(a.name) && normMac(a.mac)) || list.find((a) => normMac(a.mac));
  if (best && normMac(best.mac) !== normMac(cfg.mac) && !cfg.macManual) {
    cfg.mac = normMac(best.mac); saveCfg();
  }
}
function renderStatus() {
  $('#pcDot').classList.toggle('on', state.agent);
  $('#pcLabel').textContent = state.agent ? ('PC ' + (state.agentName || 'ONLINE')).toUpperCase().slice(0, 14) : 'PC OFF';
  $('#pcLabel').parentElement.classList.toggle('ok', state.agent);
  const h = state.helpers.length;
  $('#hlpLabel').textContent = `${h} HLP`;
  $('#hlpLabel').classList.toggle('ok', h > 0);
  $('#lat').textContent = authed ? `${lat == null ? '--' : lat + 'ms'}` : 'OFF';
  $('#lat').classList.toggle('ok', authed);
  updateEmpty();
}

/* ================= live PC screen ================= */
const cv = $('#scr');
const cx2 = cv.getContext ? cv.getContext('2d') : null;
let frame = null, reg = null, cur = null, disp = null, dirty = true;
let decoding = false, latest = null, fpsCount = 0, wasViewing = false;

function viewWanted() {
  return cfg.live && authed && state.agent && document.visibilityState === 'visible';
}
function loupeCrop() {
  if (!cfg.loupe) return 0;
  const r = cv.getBoundingClientRect();
  const sw = (reg && reg.sw) || 1920, sh = (reg && reg.sh) || 1080;
  const sc = Math.min(r.width / sw, r.height / sh) || 0.2;   // css px per screen px in the fixed picture
  return Math.max(80, Math.min(600, Math.round((2 * cfg.lr) / (sc * cfg.lz))));
}
function sendView() {
  const want = viewWanted();
  if (want) {
    const q = QUAL[cfg.qual] || QUAL[1];
    tx({ t: 'view', on: true, z: 1, auto: false, w: q.w, q: q.q, fps: q.fps, lc: loupeCrop(), sid });
  } else if (wasViewing) {
    tx({ t: 'view', on: false });
  }
  wasViewing = want;
}
setInterval(sendView, 2000);

function clearScreen() {
  try { frame && frame.close && frame.close(); } catch {}
  frame = null; reg = null; cur = null; disp = null; latest = null; loupeImg = null; dirty = true;
  updateEmpty();
}
function updateEmpty() {
  const el = $('#scrEmpty');
  let txt = '';
  if (!authed) txt = 'CONNECTING…';
  else if (!state.agent) txt = 'PC OFFLINE';
  else if (!cfg.live) txt = 'SCREEN OFF';
  else if (!frame) txt = 'WAITING FOR PC SCREEN…';
  el.textContent = txt;
  el.classList.toggle('off', !txt);
}

function onFrame(buf) {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < 24) return;
  const dv = new DataView(buf);
  if (dv.getUint8(0) === 0x4c) return onLoupe(buf); // 'L' = zoom-circle crop
  if (dv.getUint8(0) !== 0x46) return; // 'F'
  const ver = dv.getUint8(1); // '1' = 18-byte header, '2' = 22-byte header with cursor at capture time
  if (ver !== 0x31 && ver !== 0x32) return;
  const seq = dv.getUint32(2, true);
  tx({ t: 'fack', s: seq }); // ack at once: the agent may send the next frame while we decode
  fpsCount++;
  const hl = ver === 0x32 ? 22 : 18;
  latest = {
    reg: { rx: dv.getUint16(6, true), ry: dv.getUint16(8, true), rw: dv.getUint16(10, true) || 1, rh: dv.getUint16(12, true) || 1,
           sw: dv.getUint16(14, true) || 1, sh: dv.getUint16(16, true) || 1 },
    fcur: ver === 0x32 ? { x: dv.getUint16(18, true), y: dv.getUint16(20, true) } : null,
    jpg: buf.slice(hl),
  };
  decode();
}
let loupeImg = null, loupeBusy = false, loupeLatest = null;
function onLoupe(buf) {
  const dv = new DataView(buf);
  loupeLatest = { rx: dv.getUint16(6, true), ry: dv.getUint16(8, true), rw: dv.getUint16(10, true) || 1, rh: dv.getUint16(12, true) || 1, jpg: buf.slice(18) };
  if (loupeBusy) return;
  loupeBusy = true;
  (async () => {
    while (loupeLatest) {
      const f = loupeLatest; loupeLatest = null;
      try {
        const bmp = await createImageBitmap(new Blob([f.jpg], { type: 'image/jpeg' }));
        try { loupeImg && loupeImg.bmp.close && loupeImg.bmp.close(); } catch {}
        loupeImg = { bmp, rx: f.rx, ry: f.ry, rw: f.rw, rh: f.rh }; dirty = true;
      } catch {}
    }
    loupeBusy = false;
  })();
}
async function decode() {
  if (decoding) return;
  decoding = true;
  while (latest) {
    const f = latest; latest = null;
    try {
      const bmp = await createImageBitmap(new Blob([f.jpg], { type: 'image/jpeg' }));
      try { frame && frame.close && frame.close(); } catch {}
      frame = bmp; reg = f.reg; dirty = true;
      if (f.fcur && reg.sw / reg.rw > 1.05) { cur = f.fcur; disp = { x: f.fcur.x, y: f.fcur.y }; } // zoomed: cursor locked to the picture
      updateEmpty();
    } catch {}
  }
  decoding = false;
}

function sizeCanvas() {
  const r = cv.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  cv.width = Math.max(2, Math.round(r.width * dpr));
  cv.height = Math.max(2, Math.round(r.height * dpr));
  dirty = true;
}
function drawCursor(c, px, py, u) {
  const s = 1.35 * u;
  c.save();
  c.translate(px, py);
  c.beginPath();
  c.arc(0, 0, 11 * u, 0, 6.2832);
  c.strokeStyle = cfg.accent; c.lineWidth = 1.5 * u; c.stroke();
  c.beginPath();
  [[0, 0], [0, 17], [4.5, 13], [8, 21], [11, 19.5], [7.5, 12], [13, 12]].forEach(([x, y], i) => (i ? c.lineTo(x * s, y * s) : c.moveTo(x * s, y * s)));
  c.closePath();
  c.fillStyle = '#fff'; c.fill();
  c.lineWidth = 1.8 * u; c.strokeStyle = '#000'; c.lineJoin = 'round'; c.stroke();
  c.restore();
}
function render() {
  if (!cx2) return;
  const W = cv.width, H = cv.height, u = W / Math.max(1, cv.getBoundingClientRect().width || W);
  cx2.fillStyle = '#000'; cx2.fillRect(0, 0, W, H);
  if (!frame || !reg) return;
  const s = Math.min(W / frame.width, H / frame.height);
  const dw = frame.width * s, dh = frame.height * s, ox = (W - dw) / 2, oy = (H - dh) / 2;
  cx2.imageSmoothingQuality = 'high';
  cx2.drawImage(frame, ox, oy, dw, dh);
  if (disp) {
    const px = ox + ((disp.x - reg.rx) / reg.rw) * dw, py = oy + ((disp.y - reg.ry) / reg.rh) * dh;
    const qx = Math.min(Math.max(px, ox + 2), ox + dw - 2), qy = Math.min(Math.max(py, oy + 2), oy + dh - 2);
    if (cfg.loupe && loupeImg) {
      const R = cfg.lr * u, k = (dw / reg.sw) * cfg.lz;       // device px per screen px inside the circle
      cx2.save();
      cx2.beginPath(); cx2.arc(qx, qy, R, 0, 6.2832); cx2.clip();
      cx2.fillStyle = '#000'; cx2.fill();
      cx2.imageSmoothingQuality = 'high';
      cx2.drawImage(loupeImg.bmp, qx + (loupeImg.rx - disp.x) * k, qy + (loupeImg.ry - disp.y) * k, loupeImg.rw * k, loupeImg.rh * k);
      cx2.restore();
      cx2.beginPath(); cx2.arc(qx, qy, R, 0, 6.2832);
      cx2.strokeStyle = cfg.accent; cx2.lineWidth = 1 * u; cx2.stroke();
    }
    drawCursor(cx2, qx, qy, u);
  }
}
function loop() {
  requestAnimationFrame(loop);
  if (cur) {
    if (!disp) { disp = { x: cur.x, y: cur.y }; dirty = true; }
    const dx = cur.x - disp.x, dy = cur.y - disp.y;
    if (Math.abs(dx) > 0.25 || Math.abs(dy) > 0.25) { disp.x += dx * 0.65; disp.y += dy * 0.65; dirty = true; }
  }
  if (!dirty) return;
  dirty = false;
  render();
}
setInterval(() => { $('#hFps').textContent = fpsCount + ' FPS'; fpsCount = 0; }, 1000);
if (window.ResizeObserver) new ResizeObserver(sizeCanvas).observe($('#scrBox'));
window.addEventListener('resize', sizeCanvas);

/* zoom circle (the screen itself stays fixed) */
function renderView() {
  const h = $('#hZoom');
  h.textContent = cfg.loupe ? 'ZOOM CIRCLE ' + cfg.lz + '×' : 'ZOOM CIRCLE OFF';
  h.classList.toggle('on', cfg.loupe);
}
function setLoupe(on) {
  cfg.loupe = on; saveCfg(); if (!on) loupeImg = null; dirty = true; renderView(); sendView();
  const c = $('#cLoupe'); if (c) c.checked = on;
}
$('#hZoom').addEventListener('click', () => setLoupe(!cfg.loupe));

/* ================= trackpad ================= */
const pad = $('#pad');
const ptrs = new Map();
let g = null;
let selMode = false;
let accX = 0, accY = 0, scX = 0, scY = 0, raf = 0;

function flush() {
  raf = 0;
  const x = Math.trunc(accX), y = Math.trunc(accY);
  if (x || y) { tx({ t: 'm', x, y }); accX -= x; accY -= y; }
  const sx = Math.trunc(scX), sy = Math.trunc(scY);
  if (sx || sy) { tx({ t: 'sc', x: sx, y: sy }); scX -= sx; scY -= sy; }
}
const schedule = () => { if (!raf) raf = requestAnimationFrame(flush); };
pad.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.mode-chip')) return;
  e.preventDefault();
  try { pad.setPointerCapture(e.pointerId); } catch {}
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
  if (ptrs.size === 1) {
    g = { t0: performance.now(), moved: false, max: 1, drag: false, lp: 0 };
    if (selMode) { g.drag = true; tx({ t: 'md', b: 'l' }); pad.classList.add('drag'); }
    else g.lp = setTimeout(() => {
      if (g && !g.moved && ptrs.size === 1) {
        g.drag = true; tx({ t: 'md', b: 'l' }); buzz(20); pad.classList.add('drag');
      }
    }, 380);
  } else if (g) {
    g.max = Math.max(g.max, ptrs.size);
    clearTimeout(g.lp);
    if (g.drag) { g.drag = false; tx({ t: 'mu', b: 'l' }); pad.classList.remove('drag'); }
  }
  pad.classList.add('touch');
});

pad.addEventListener('pointermove', (e) => {
  const p = ptrs.get(e.pointerId);
  if (!p || !g) return;
  e.preventDefault();
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (!g.moved && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 8) { g.moved = true; clearTimeout(g.lp); }
  if (ptrs.size === 1 && g.max === 1) {
    {
      const sp = Math.hypot(dx, dy);
      const gain = cfg.sens * Math.min(1 + sp * 0.09, 3.4);
      accX += dx * gain; accY += dy * gain; schedule();
    }
  } else if (ptrs.size >= 2) {
    const k = (cfg.natural ? -1 : 1) * 3.6 * cfg.scroll / ptrs.size;
    scX += dx * k; scY += dy * k; schedule();
  }
});

function endPtr(e) {
  const p = ptrs.get(e.pointerId);
  if (!p) return;
  ptrs.delete(e.pointerId);
  try { pad.releasePointerCapture(e.pointerId); } catch {}
  if (!g || ptrs.size) return;
  clearTimeout(g.lp);
  const dt = performance.now() - g.t0;
  if (g.drag) { tx({ t: 'mu', b: 'l' }); pad.classList.remove('drag'); }
  else if (cfg.tap && !g.moved && dt < 280 && e.type === 'pointerup') {
    if (g.max === 1) { tx({ t: 'c', b: 'l', n: 1 }); buzz(6); }
    else if (g.max === 2) { tx({ t: 'c', b: 'r', n: 1 }); buzz(10); }
    else { tx({ t: 'c', b: 'm', n: 1 }); buzz(10); }
  }
  g = null;
  pad.classList.remove('touch');
}
pad.addEventListener('pointerup', endPtr);
pad.addEventListener('pointercancel', endPtr);
pad.addEventListener('lostpointercapture', endPtr);

/* ================= quick actions ================= */
function holdBtn(el, b) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch {}
    el.classList.add('on'); tx({ t: 'md', b }); buzz(8);
  });
  const up = () => { if (el.classList.contains('on')) { el.classList.remove('on'); tx({ t: 'mu', b }); } };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}
holdBtn($('#bL'), 'l');
holdBtn($('#bR'), 'r');

function tap(el, fn) {
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); buzz(8); fn(); });
}
tap($('#bCopy'), () => tx({ t: 'copy' }));
tap($('#bPaste'), () => tx({ t: 'paste' }));
tap($('#bAll'), () => tx({ t: 'k', k: 'a', mods: ['ctrl'] }));
tap($('#bSel'), () => {
  selMode = !selMode; $('#bSel').classList.toggle('on', selMode);
  toast(selMode ? 'SELECT ON: drag on trackpad to select text' : 'SELECT OFF', 1200);
});
tap($('#bPrt'), () => tx({ t: 'k', k: 'printscreen', mods: [] }));

async function onClip(text) {
  if (!text) return toast('Copied on PC (clipboard empty or not text)');
  try { await navigator.clipboard.writeText(text); toast('Copied to phone: ' + text.replace(/\s+/g, ' ').slice(0, 40)); }
  catch { toast('Copied on PC (phone clipboard blocked)'); }
}
function setKb(show) {
  $('main').classList.toggle('nokb', !show);
  $('#kbShow').hidden = show;
}
$('#bKbToggle').addEventListener('click', () => setKb(false));
$('#kbShow').addEventListener('click', () => setKb(true));

/* ================= virtual keyboard ================= */
const kb = $('#kb');
const mods = { ctrl: false, alt: false, win: false, shift: false };
let caps = false, lastShift = 0, layer = 'abc';
const chars = (s) => s.split('');
const BOTTOM = ['ctrl', 'alt', 'win', 'space', 'enter'];
const LAYERS = {
  abc: [
    chars("`-=[];',./"),
    chars('qwertyuiop'),
    ['gap', ...chars('asdfghjkl'), 'gap'],
    ['shift', ...chars('zxcvbnm'), 'bksp'],
    BOTTOM,
  ],
  num: [
    chars('1234567890'),
    chars('-/:;()$&@"'),
    chars(".,?!'[]{}\\|"),
    chars('<>^%*+=_~#'),
    BOTTOM,
  ],
  sp: [
    ['esc', 'tab', 'caps', 'del', 'ins', 'home', 'end', 'pgup'],
    ['pgdn', 'left', 'up', 'down', 'right', 'vold', 'volu', 'mute'],
    Array.from({ length: 12 }, (_, i) => 'f' + (i + 1)),
    ['alttab', 'wind', 'tmgr', 'snip', 'cut', 'undo', 'all', 'play'],
    BOTTOM,
  ],
};
const LABEL = {
  esc: 'Esc', tab: 'Tab', caps: 'Caps', del: 'Del', ins: 'Ins', home: 'Home', end: 'End', pgup: 'PgUp', pgdn: 'PgDn',
  left: '◀', up: '▲', down: '▼', right: '▶', vold: 'Vol−', volu: 'Vol+', mute: 'Mute', play: '⏯',
  alttab: 'Alt+Tab', wind: 'Win+D', tmgr: 'TaskMgr', snip: 'Snip', cut: 'Cut', undo: 'Undo', all: 'All',
  bksp: '⌫', shift: '⇧', enter: 'Enter', space: '', ctrl: 'Ctrl', alt: 'Alt', win: 'Win',
};
const MACRO = new Set(['vold', 'volu', 'mute', 'play', 'alttab', 'wind', 'tmgr', 'snip', 'cut', 'undo', 'all']);
const WIDE = { shift: 'w15', bksp: 'w15', ctrl: 'w15', alt: 'w15', win: 'w15', enter: 'w2', space: 'w4' };
const NAMED = { bksp: 'backspace', del: 'delete', ins: 'insert', caps: 'capslock', pgup: 'pageup', pgdn: 'pagedown',
  vold: 'voldown', volu: 'volup', play: 'playpause' };
const COMBO = {
  alttab: { k: 'tab', mods: ['alt'] }, wind: { k: 'd', mods: ['win'] }, tmgr: { k: 'esc', mods: ['ctrl', 'shift'] },
  snip: { k: 's', mods: ['win', 'shift'] }, cut: { k: 'x', mods: ['ctrl'] }, undo: { k: 'z', mods: ['ctrl'] }, all: { k: 'a', mods: ['ctrl'] },
};
const REPEAT = new Set(['bksp', 'left', 'right', 'up', 'down', 'del', 'space', 'pgup', 'pgdn']);
const MODKEYS = new Set(['ctrl', 'alt', 'win']);

function buildKb() {
  kb.textContent = '';
  LAYERS[layer].forEach((row) => {
    const r = document.createElement('div'); r.className = 'kr';
    row.forEach((k) => r.appendChild(mkKey(k)));
    kb.appendChild(r);
  });
  $$('.tab[data-layer]').forEach((t) => t.classList.toggle('on', t.dataset.layer === layer));
  refreshMods();
}
function mkKey(k) {
  const b = document.createElement('button');
  b.type = 'button';
  if (k === 'gap') { b.className = 'k sp'; b.tabIndex = -1; return b; }
  b.dataset.k = k;
  b.className = 'k ' + (WIDE[k] || '');
  if (k.length === 1) { b.classList.add('ch'); b.textContent = k; }
  else {
    const isF = /^f\d+$/.test(k);
    b.textContent = isF ? k.toUpperCase() : (LABEL[k] ?? k);
    b.classList.add(isF ? 'fn' : MACRO.has(k) ? 'mc' : 'ctl');
    if (MODKEYS.has(k) || k === 'shift') { b.classList.add('mod'); b.dataset.mod = k; }
  }
  let rep = 0, hold = 0;
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    b.classList.add('down'); buzz(5);
    onKey(k);
    if (REPEAT.has(k)) hold = setTimeout(() => { rep = setInterval(() => onKey(k), 55); }, 380);
  });
  const up = () => { b.classList.remove('down'); clearTimeout(hold); clearInterval(rep); };
  b.addEventListener('pointerup', up);
  b.addEventListener('pointercancel', up);
  b.addEventListener('pointerleave', up);
  return b;
}
function refreshMods() {
  $$('#kb .k[data-mod]').forEach((el) => {
    const m = el.dataset.mod;
    el.classList.toggle('on', m === 'shift' ? (mods.shift || caps) : mods[m]);
  });
  kb.classList.toggle('up', mods.shift || caps);
}
function clearSticky() {
  ['ctrl', 'alt', 'win'].forEach((x) => { mods[x] = false; });
  if (!caps) mods.shift = false;
  refreshMods();
}
function onKey(k) {
  if (k === 'shift') {
    const now = Date.now();
    if (caps) { caps = false; mods.shift = false; }
    else if (mods.shift && now - lastShift < 450) caps = true;
    else if (mods.shift) mods.shift = false;
    else mods.shift = true;
    lastShift = now;
    return refreshMods();
  }
  if (MODKEYS.has(k)) { mods[k] = !mods[k]; return refreshMods(); }
  if (COMBO[k]) { tx({ t: 'k', k: COMBO[k].k, mods: [...COMBO[k].mods] }); return clearSticky(); }

  const m = ['ctrl', 'alt', 'win'].filter((x) => mods[x]);
  const shifted = mods.shift || caps;
  if (k.length === 1) {
    if (m.length) tx({ t: 'k', k: k.toLowerCase(), mods: shifted ? [...m, 'shift'] : m });
    else tx({ t: 'txt', s: shifted ? k.toUpperCase() : k });
  } else if (k === 'space' && !m.length && !shifted) {
    tx({ t: 'txt', s: ' ' });
  } else {
    tx({ t: 'k', k: NAMED[k] || k, mods: shifted ? [...m, 'shift'] : m });
  }
  clearSticky();
}
$$('.tab[data-layer]').forEach((t) => t.addEventListener('click', () => { layer = t.dataset.layer; buildKb(); }));

/* phone's own keyboard -> typed on the PC (any language the phone keyboard supports) */
const ghost = $('#ghost');
const SENT = '⁣⁣';
let composing = false;
const resetGhost = () => { ghost.value = SENT; try { ghost.setSelectionRange(SENT.length, SENT.length); } catch {} };
function diffGhost() {
  const v = ghost.value;
  const rem = (v.match(/⁣/g) || []).length;
  const back = Math.max(0, SENT.length - rem);
  const ins = v.replace(/⁣/g, '');
  for (let i = 0; i < back; i++) tx({ t: 'k', k: 'backspace', mods: [] });
  if (ins) tx({ t: 'txt', s: ins });
  resetGhost();
}
ghost.addEventListener('compositionstart', () => { composing = true; });
ghost.addEventListener('compositionend', () => { composing = false; diffGhost(); });
ghost.addEventListener('input', () => { if (!composing) diffGhost(); });
ghost.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); tx({ t: 'k', k: 'enter', mods: [] }); }
});
$('#bNative').addEventListener('pointerdown', (e) => {
  e.preventDefault(); resetGhost(); ghost.focus();
});

/* ================= JC assistant ================= */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const jcLog = $('#jcLog'), jcIn = $('#jcIn');
function jcAdd(kind, text) {
  const d = document.createElement('div');
  d.className = 'jc-m ' + kind; d.textContent = text;
  jcLog.appendChild(d); jcLog.scrollTop = jcLog.scrollHeight;
  while (jcLog.children.length > 40) jcLog.removeChild(jcLog.firstChild);
}
function jcSend(q) {
  q = (q || '').trim().slice(0, 300);
  if (!q) return;
  jcAdd('me', q);
  if (jcIsPowerOn(q)) {
    if (state.agent) return jcAdd('jc', 'PC to ekhon-i chalu ache.');
    return jcWake();
  }
  if (!state.agent) return jcAdd('jc', 'PC offline. "pc on koro" bolo, ba Power On chapo.');
  const id = String(Date.now());
  jcMine.add(id);
  tx({ t: 'jc', q, id });
}
const jcMine = new Set();
let jcLastSpoken = '', jcSpeakEnd = 0;
const jcWords = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
/* the mic can hear the phone's own speaker: drop a transcript that is (mostly) JC's last reply */
function jcIsEcho(t) {
  if (Date.now() - jcSpeakEnd < 900) return true;
  const a = jcWords(t), b = new Set(jcWords(jcLastSpoken));
  if (!a.length || !b.size || Date.now() - jcSpeakEnd > 20000) return false;
  return a.filter((w) => b.has(w)).length / a.length >= 0.5;
}
/* "pc on koro / pc open / পিসি চালু" etc. is handled here on the phone: when the PC is off there is no agent to listen */
function jcIsPowerOn(q) {
  const t = q.toLowerCase().replace(/[!?,.;]/g, ' ');
  const pc = /(\bpc\b|computer|laptop|\u09aa\u09bf\u09b8\u09bf|\u0995\u09ae\u09cd\u09aa\u09bf\u0989\u099f\u09be\u09b0)/;
  const on = /(\bon\b|\bopen\b|khulo|kholo|\bkhol\b|chalu|chalao|start|power on|boot|wake|\u0985\u09a8|\u0993\u09aa\u09c7\u09a8|\u099a\u09be\u09b2\u09c1|\u099a\u09be\u09b2\u09be\u0993)/;
  const off = /(shutdown|shut down|off|bondho|bandho|restart|sleep|lock|close|\u09ac\u09a8\u09cd\u09a7|\u0985\u09ab)/;
  return pc.test(t) && on.test(t) && !off.test(t);
}
function jcWake() {
  if (!normMac(cfg.mac)) return jcAdd('jc', 'PC-r MAC address save nei. PC ekbar chalu kore app-e dhukle nijei save hoy.');
  tx({ t: 'wake', mac: normMac(cfg.mac), id: String(Date.now()) });
  wakePending = Date.now();
  jcAdd('jc', 'PC chalu korar signal pathalam. 1-2 minute-er moddhe on hole janabo.');
  setTimeout(() => { if (wakePending && Date.now() - wakePending > 85000) { wakePending = 0; jcAdd('jc', 'PC ekhono offline. BIOS Wake-on-LAN, LAN cable ar helper phone check koro.'); } }, 90000);
}
function jcReply(m) {
  if (m.id && !jcMine.has(m.id)) return; // another phone/tab asked: don't log or speak it here
  const say = m.say || (m.ok ? 'Hoye geche.' : 'Hoyni.');
  jcAdd('jc', say);
  const talk = !!cfg.jcTalk;
  if ((cfg.jcSpeak || talk) && 'speechSynthesis' in window) {
    try {
      speechSynthesis.cancel();
      let sp = say.includes('\n') ? say.split('\n')[0] : say;
      if (sp.length > 400) sp = sp.slice(0, 400);
      const u = new SpeechSynthesisUtterance(sp);
      const isBn = /[\u0980-\u09FF]/.test(sp);
      u.lang = isBn ? 'bn-BD' : (cfg.jcLang === 'en-US' ? 'en-US' : 'en-IN');
      const v = jcPickVoice(isBn);
      if (v) { u.voice = v; u.lang = v.lang; }
      jcLastSpoken = say;
      u.onend = () => { jcSpeakEnd = Date.now(); if (talk) jcTalkNext(); };
      u.onerror = () => { jcSpeakEnd = Date.now(); if (talk) jcTalkNext(); };
      speechSynthesis.speak(u);
      return;
    } catch {}
  }
  if (talk) jcTalkNext();
}
function jcVoices() { try { return speechSynthesis.getVoices() || []; } catch { return []; } }
function jcPickVoice(bn) {
  const all = jcVoices();
  const want = bn ? cfg.jcVoiceBn : cfg.jcVoiceEn;
  let v = all.find((x) => x.voiceURI === want);
  if (!v) v = all.find((x) => (bn ? /^bn/i : /^en/i).test(x.lang));
  return v || null;
}
function jcFillVoices() {
  const all = jcVoices();
  const fill = (sel, re, cur, key) => {
    const list = all.filter((v) => re.test(v.lang));
    sel.innerHTML = '<option value="">Auto</option>' + list.map((v) => `<option value="${v.voiceURI.replace(/"/g, '&quot;')}">${v.name} (${v.lang})</option>`).join('');
    sel.value = list.some((v) => v.voiceURI === cur) ? cur : '';
    sel.onchange = () => { cfg[key] = sel.value; saveCfg(); try { const u = new SpeechSynthesisUtterance(key === 'jcVoiceBn' ? 'আমি জেসি' : 'I am JC'); const v = jcPickVoice(key === 'jcVoiceBn'); if (v) { u.voice = v; u.lang = v.lang; } speechSynthesis.cancel(); speechSynthesis.speak(u); } catch {} };
  };
  fill($('#jcVoiceBn'), /^bn/i, cfg.jcVoiceBn, 'jcVoiceBn');
  fill($('#jcVoiceEn'), /^en/i, cfg.jcVoiceEn, 'jcVoiceEn');
}
try { speechSynthesis.addEventListener('voiceschanged', jcFillVoices); } catch {}
function jcTalkNext() {
  setTimeout(() => { if (cfg.jcTalk && !$('#sheetJC').hidden && !jcRec) $('#jcMic').click(); }, 1200);
}
function jcRenderLang() { $('#jcLang').textContent = cfg.jcLang === 'en-US' ? 'EN' : 'BN'; }
$('#btnJC').addEventListener('click', () => {
  openSheet('JC'); jcRenderLang(); jcFillVoices(); $('#jcSpeak').checked = !!cfg.jcSpeak; $('#jcTalk').checked = !!cfg.jcTalk;
  if (!jcLog.children.length) jcAdd('jc', 'Ami JC. Likho ba mic chepe bolo. "help" likhle sob command dekhabo.');
});
$('#jcForm').addEventListener('submit', (e) => { e.preventDefault(); jcSend(jcIn.value); jcIn.value = ''; });
$('#jcChips').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) jcSend(b.dataset.q); });
$('#jcLang').addEventListener('click', () => { cfg.jcLang = cfg.jcLang === 'en-US' ? 'bn-BD' : 'en-US'; saveCfg(); jcRenderLang(); });
$('#jcSpeak').addEventListener('change', (e) => { cfg.jcSpeak = e.target.checked; saveCfg(); });
$('#jcTalk').addEventListener('change', (e) => { cfg.jcTalk = e.target.checked; saveCfg(); if (cfg.jcTalk && !jcRec) $('#jcMic').click(); });
let jcRec = null;
$('#jcMic').addEventListener('click', () => {
  if (!SR) return toast('Ei browser-e voice nei. Chrome use koro.', 3000);
  if (jcRec) { try { jcRec.stop(); } catch {} return; }
  try { speechSynthesis.cancel(); } catch {}
  const r = new SR();
  r.lang = cfg.jcLang === 'en-US' ? 'en-US' : 'bn-BD';
  r.interimResults = false; r.maxAlternatives = 1;
  $('#jcMic').classList.add('on');
  r.onresult = (ev) => { const t = ev.results[0][0].transcript; if (jcIsEcho(t)) { toast('Nijer awaj dhorechhe, ignore korlam', 1800); return; } jcSend(t); };
  r.onerror = (ev) => toast('Mic: ' + (ev.error === 'not-allowed' ? 'permission dao' : ev.error), 3000);
  r.onend = () => { jcRec = null; $('#jcMic').classList.remove('on'); };
  jcRec = r;
  try { r.start(); } catch { jcRec = null; $('#jcMic').classList.remove('on'); }
});

/* ================= sheets ================= */
function openSheet(id) { $('#sheet' + id).hidden = false; }
function closeSheets() {
  if (typeof jcRec !== 'undefined' && jcRec) { try { jcRec.stop(); } catch {} }
  try { speechSynthesis.cancel(); } catch {} $$('.sheet').forEach((s) => { s.hidden = true; }); disarm(); }
$$('.sheet [data-close]').forEach((el) => el.addEventListener('click', closeSheets));
$('#btnPower').addEventListener('click', () => openSheet('Power'));
$('#btnSet').addEventListener('click', () => { loadSettingsUI(); openSheet('Set'); });

/* power */
let armed = null, armTimer = 0;
function disarm() {
  if (armed) armed.classList.remove('armed');
  armed = null; clearTimeout(armTimer);
}
$$('[data-power]').forEach((btn) => btn.addEventListener('click', () => {
  const a = btn.dataset.power;
  const dangerous = a === 'shutdown' || a === 'restart';
  if (dangerous && armed !== btn) {
    disarm(); armed = btn; btn.classList.add('armed'); buzz(15);
    toast('Tap again to confirm');
    armTimer = setTimeout(disarm, 3000);
    return;
  }
  disarm();
  tx({ t: 'power', a });
  toast({ shutdown: 'Shutting down in 5s', restart: 'Restarting in 5s', sleep: 'Sleep sent', lock: 'Locked', abort: 'Shutdown cancel sent' }[a] || 'Sent');
  closeSheets();
}));
$('[data-wake]').addEventListener('click', () => {
  if (!normMac(cfg.mac)) { closeSheets(); return toast('MAC not saved yet. Turn the PC on once; it is detected and saved automatically.', 4500); }
  tx({ t: 'wake', mac: normMac(cfg.mac), id: String(Date.now()) });
  wakePending = Date.now();
  closeSheets();
  setTimeout(() => { if (wakePending && Date.now() - wakePending > 85000) { wakePending = 0; toast('PC still offline. Check BIOS Wake-on-LAN + LAN cable.', 5000); } }, 90000);
});

/* settings */
function normMac(s) {
  const hex = String(s || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  return hex.length === 12 ? hex.match(/../g).join(':') : '';
}
function renderQual() { $$('[data-q]').forEach((b) => b.classList.toggle('on', +b.dataset.q === cfg.qual)); }
function loadSettingsUI() {
  $('#rSens').value = cfg.sens; $('#oSens').textContent = cfg.sens.toFixed(1);
  $('#rScroll').value = cfg.scroll; $('#oScroll').textContent = cfg.scroll.toFixed(1);
  $('#cNatural').checked = cfg.natural; $('#cTap').checked = cfg.tap;
  $('#cLive').checked = cfg.live; $('#cLoupe').checked = cfg.loupe; renderLoupeUI(); renderThemeUI();
  $('#macInput').value = cfg.mac; renderQual(); renderAdapters();
}
$('#rSens').addEventListener('input', (e) => { cfg.sens = +e.target.value; $('#oSens').textContent = cfg.sens.toFixed(1); saveCfg(); });
$('#rScroll').addEventListener('input', (e) => { cfg.scroll = +e.target.value; $('#oScroll').textContent = cfg.scroll.toFixed(1); saveCfg(); });
$('#cNatural').addEventListener('change', (e) => { cfg.natural = e.target.checked; saveCfg(); });
$('#cTap').addEventListener('change', (e) => { cfg.tap = e.target.checked; saveCfg(); });
function renderLoupeUI() {
  $$('[data-lz]').forEach((b) => b.classList.toggle('on', +b.dataset.lz === cfg.lz));
  $$('[data-lr]').forEach((b) => b.classList.toggle('on', +b.dataset.lr === cfg.lr));
}
function renderThemeUI() {
  $('#thDark').classList.toggle('on', cfg.theme !== 'light'); $('#thLight').classList.toggle('on', cfg.theme === 'light');
  $$('.sw').forEach((b) => b.classList.toggle('on', b.dataset.c.toLowerCase() === cfg.accent.toLowerCase()));
  $('#cCustom').value = cfg.accent;
}
$('#cLive').addEventListener('change', (e) => { cfg.live = e.target.checked; saveCfg(); if (!cfg.live) clearScreen(); sendView(); updateEmpty(); });
$('#cLoupe').addEventListener('change', (e) => setLoupe(e.target.checked));
$$('[data-lz]').forEach((b) => b.addEventListener('click', () => { cfg.lz = +b.dataset.lz; saveCfg(); renderLoupeUI(); renderView(); sendView(); dirty = true; }));
$$('[data-lr]').forEach((b) => b.addEventListener('click', () => { cfg.lr = +b.dataset.lr; saveCfg(); renderLoupeUI(); sendView(); dirty = true; }));
$('#thDark').addEventListener('click', () => { cfg.theme = 'dark'; saveCfg(); applyTheme(); renderThemeUI(); });
$('#thLight').addEventListener('click', () => { cfg.theme = 'light'; saveCfg(); applyTheme(); renderThemeUI(); });
$$('.sw').forEach((b) => b.addEventListener('click', () => { cfg.accent = b.dataset.c; saveCfg(); applyTheme(); renderThemeUI(); }));
$('#cCustom').addEventListener('input', (e) => { cfg.accent = e.target.value; saveCfg(); applyTheme(); renderThemeUI(); });
$$('[data-q]').forEach((b) => b.addEventListener('click', () => { cfg.qual = +b.dataset.q; saveCfg(); renderQual(); sendView(); }));
$('#bSave').addEventListener('click', () => {
  const raw = $('#macInput').value.trim();
  if (raw && !normMac(raw)) return toast('MAC must be 12 hex digits (AA:BB:CC:DD:EE:FF)');
  cfg.mac = normMac(raw); cfg.macManual = !!cfg.mac; saveCfg(); toast('Saved'); closeSheets();
});
$('#bSignout').addEventListener('click', () => {
  token = ''; LS.set('token', ''); try { ws.close(); } catch {} closeSheets(); showLogin('Paste your access token to pair this phone.');
});
function renderAdapters() {
  const box = $('#adapters');
  if (!box) return;
  box.textContent = '';
  const list = (state.info && state.info.adapters) || [];
  if (!list.length) {
    const d = document.createElement('div'); d.className = 'none';
    d.textContent = state.agent ? 'No network adapters reported' : 'Turn the PC on once to auto-detect its MAC';
    box.appendChild(d); return;
  }
  list.forEach((a) => {
    const b = document.createElement('button'); b.type = 'button';
    b.textContent = `${a.name || 'adapter'} · ${a.mac}`;
    if (/ethernet|lan/i.test(a.name)) b.classList.add('best');
    b.addEventListener('click', () => { $('#macInput').value = normMac(a.mac); toast('MAC filled. Tap SAVE.'); });
    box.appendChild(b);
  });
}

/* ================= login ================= */
$('#loginForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('#tokenInput').value.trim();
  if (v.length < 8) return;
  token = v; LS.set('token', token); $('#tokenInput').value = '';
  retry = 1000; connect();
});

/* ================= misc ================= */
document.addEventListener('contextmenu', (e) => e.preventDefault());
let wl = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wl) {
    wl = await navigator.wakeLock.request('screen'); wl.addEventListener('release', () => { wl = null; });
  } } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    keepAwake();
    if (token && (!ws || ws.readyState > 1)) { retry = 1000; connect(); }
  }
  sendView();
});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

applyTheme(); renderView(); buildKb(); renderStatus(); sizeCanvas(); keepAwake();
requestAnimationFrame(loop);
connect();
})();
