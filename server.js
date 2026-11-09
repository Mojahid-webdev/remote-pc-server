'use strict';
/**
 * Relay server
 *  - serves the phone web app (./public)
 *  - WebSocket hub at /ws with three roles:
 *      phone  -> controller UI
 *      agent  -> Windows PC agent (executes mouse/keyboard/power)
 *      helper -> always-on Android phone(s) that send Wake-on-LAN packets
 *  - auth: shared TOKEN (env var), sent as first WS message (never in URL)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '3000', 10);
const TOKEN = process.env.TOKEN || '';
if (TOKEN.length < 16) {
  console.error('FATAL: set the TOKEN environment variable (min 16 characters).');
  process.exit(1);
}
const TOKEN_HASH = crypto.createHash('sha256').update(TOKEN).digest();

function tokenOk(t) {
  if (typeof t !== 'string' || t.length > 256) return false;
  const h = crypto.createHash('sha256').update(t).digest();
  return crypto.timingSafeEqual(h, TOKEN_HASH);
}

/* ---------- static files ---------- */
// Static files live in ./public, or (flat deploy, e.g. web-uploaded repo) right next to server.js.
const FLAT = !fs.existsSync(path.join(__dirname, 'public'));
const PUBLIC = FLAT ? __dirname : path.join(__dirname, 'public');
const SERVE_EXT = new Set(['.html', '.js', '.css', '.webmanifest', '.png', '.svg', '.ico']);
const DENY = new Set(['server.js', 'package.json', 'package-lock.json', 'render.yaml']);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; manifest-src 'self'; frame-ancestors 'none'",
};

const server = http.createServer((req, res) => {
  let p;
  try {
    p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400);
    return res.end('bad request');
  }
  if (p === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    return res.end('ok');
  }
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  const base = path.basename(file);
  if (!SERVE_EXT.has(path.extname(file)) || (FLAT && (DENY.has(base) || path.dirname(file) !== PUBLIC))) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      ...SEC_HEADERS,
    });
    res.end(data);
  });
});

/* ---------- websocket hub ---------- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024 });

const phones = new Set();
const helpers = new Set();
let agent = null;
let agentInfo = null;

// brute-force protection: 8 bad tokens / 10 min -> 15 min block per IP
const fails = new Map();
function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (xf ? String(xf).split(',')[0].trim() : req.socket.remoteAddress) || '?';
}
function isBlocked(ip) {
  const f = fails.get(ip);
  return !!f && f.until > Date.now();
}
function recordFail(ip) {
  const now = Date.now();
  const f = fails.get(ip) || { n: 0, first: now, until: 0 };
  if (now - f.first > 600000) {
    f.n = 0;
    f.first = now;
  }
  f.n++;
  if (f.n >= 8) {
    f.until = now + 900000;
    f.n = 0;
  }
  fails.set(ip, f);
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, f] of fails) if (f.until < now && now - f.first > 600000) fails.delete(ip);
}, 600000).unref();

function sendJSON(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function presence() {
  return {
    t: 'presence',
    agent: !!agent,
    agentName: agent ? agent.meta.name : null,
    info: agentInfo,
    helpers: [...helpers].map((h) => h.meta.name),
  };
}
function broadcastPresence() {
  const p = presence();
  phones.forEach((ws) => sendJSON(ws, p));
}

function register(ws) {
  const { role } = ws.meta;
  sendJSON(ws, { t: 'auth', ok: true, role });
  if (role === 'phone') {
    phones.add(ws);
    sendJSON(ws, presence());
    if (agent) sendJSON(agent, { t: 'sendinfo' });
  } else if (role === 'agent') {
    if (agent && agent !== ws) agent.close(4010, 'replaced by new agent');
    agent = ws;
    agentInfo = null;
    broadcastPresence();
  } else if (role === 'helper') {
    helpers.add(ws);
    broadcastPresence();
  }
}
function anyViewer() {
  for (const p of phones) if (p.meta && p.meta.view) return true;
  return false;
}
function relayFrame(buf) {
  for (const p of phones) {
    // backpressure: a slow phone just skips frames instead of buffering them
    if (p.meta.view && p.readyState === 1 && p.bufferedAmount < 400000) p.send(buf, { binary: true });
  }
}
function unregister(ws) {
  if (!ws.meta) return;
  phones.delete(ws);
  if (ws.meta.role === 'phone' && ws.meta.view && !anyViewer()) sendJSON(agent, { t: 'view', on: false });
  if (helpers.delete(ws)) broadcastPresence();
  if (agent === ws) {
    agent = null;
    agentInfo = null;
    broadcastPresence();
  }
}

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
function cleanInfo(m) {
  const adapters = Array.isArray(m.adapters)
    ? m.adapters
        .slice(0, 8)
        .map((a) => ({ name: str(a && a.name, 60), mac: str(a && a.mac, 24) }))
        .filter((a) => a.mac)
    : [];
  const screen =
    Array.isArray(m.screen) && m.screen.length === 2 ? m.screen.map((n) => Number(n) || 0) : null;
  return { host: str(m.host, 60), screen, adapters };
}

// message types a phone may send to the PC agent
const TO_AGENT = new Set([
  'm', 'abs', 'c', 'md', 'mu', 'sc', 'txt', 'k',
  'copy', 'paste', 'setclip', 'power', 'getinfo', 'fack',
]);

function route(ws, msg, raw) {
  const { role } = ws.meta;
  if (msg.t === 'ping') return sendJSON(ws, { t: 'pong', ts: msg.ts });

  if (role === 'phone') {
    if (msg.t === 'view') {
      ws.meta.view = !!msg.on;
      if (agent && agent.readyState === 1) {
        // another phone may still be watching: only switch the stream off when nobody is
        if (msg.on || !anyViewer()) agent.send(raw);
      }
      return;
    }
    if (TO_AGENT.has(msg.t)) {
      if (agent && agent.readyState === 1) agent.send(raw);
      else if (['power', 'copy', 'paste', 'setclip'].includes(msg.t))
        sendJSON(ws, { t: 'toast', text: 'PC offline' });
      return;
    }
    if (msg.t === 'wake') {
      const id = str(msg.id, 40) || crypto.randomBytes(4).toString('hex');
      const mac = str(msg.mac, 40);
      let n = 0;
      helpers.forEach((h) => {
        if (h.readyState === 1) {
          sendJSON(h, { t: 'wake', id, mac });
          n++;
        }
      });
      return sendJSON(ws, { t: 'wake_sent', id, helpers: n });
    }
  } else if (role === 'agent') {
    if (msg.t === 'info') {
      agentInfo = cleanInfo(msg);
      return broadcastPresence();
    }
    if (msg.t === 'clip') {
      const out = { t: 'clip', text: str(msg.text, 30000) };
      return phones.forEach((p) => sendJSON(p, out));
    }
    if (msg.t === 'cur') {
      // tiny, high-rate: forward the raw frame to viewers only
      return phones.forEach((p) => p.meta.view && p.readyState === 1 && p.send(raw));
    }
  } else if (role === 'helper') {
    if (msg.t === 'wake_ack') {
      const out = {
        t: 'wake_ack',
        id: str(msg.id, 40),
        ok: !!msg.ok,
        name: ws.meta.name,
        error: msg.error ? str(String(msg.error), 100) : undefined,
      };
      return phones.forEach((p) => sendJSON(p, out));
    }
  }
}

wss.on('connection', (ws, req) => {
  const ip = clientIp(req);
  if (isBlocked(ip)) {
    ws.close(4029, 'blocked');
    return;
  }
  ws.isAlive = true;
  ws.meta = null;
  ws.on('pong', () => (ws.isAlive = true));
  const authTimer = setTimeout(() => {
    if (!ws.meta) ws.close(4001, 'auth timeout');
  }, 5000);

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // only the authenticated agent may send binary (screen frames)
      if (ws.meta && ws.meta.role === 'agent') relayFrame(data);
      return;
    }
    // size caps: tiny before auth, 100 KB for phones/helpers, agent unrestricted (up to maxPayload)
    if (!ws.meta ? data.length > 2048 : ws.meta.role !== 'agent' && data.length > 100000) {
      if (!ws.meta) ws.close(4002, 'too big');
      return;
    }
    const raw = data.toString();
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    if (!ws.meta) {
      if (msg.t !== 'auth') return;
      if (!tokenOk(msg.token)) {
        recordFail(ip);
        sendJSON(ws, { t: 'auth', ok: false });
        ws.close(4003, 'bad token');
        return;
      }
      if (!['phone', 'agent', 'helper'].includes(msg.role)) {
        ws.close(4002, 'bad role');
        return;
      }
      clearTimeout(authTimer);
      ws.meta = { role: msg.role, name: str(msg.name, 40) || msg.role };
      register(ws);
      return;
    }
    route(ws, msg, raw);
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    unregister(ws);
  });
  ws.on('error', () => {});
});

// heartbeat: drop dead sockets, keep NAT / proxy connections alive
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {}
  });
}, 25000).unref();

server.listen(PORT, '0.0.0.0', () => console.log(`relay listening on :${PORT}`));
