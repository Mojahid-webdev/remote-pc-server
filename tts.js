'use strict';
/* Server-side TTS for JC — all free, never paid.
 * Provider order (auto-shift when one runs out / fails):
 *   1. Google Cloud TTS (male bn-IN, best)  — only while this month's chars stay under a safe cap, so Google never bills
 *   2. Sarvam AI (male Bengali)              — SARVAM_KEY
 *   3. Deepgram Aura                         — DEEPGRAM_KEY
 *   4. Microsoft Edge Neural (male, no key)
 *   5. Google Translate TTS (female, no key, unlimited) — last resort so voice never stops
 * Keys come from env vars (set on Render); never sent to the phone. In-memory LRU cache. */
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let edge = null; try { edge = require('./edge-tts'); } catch {}

const env = (k) => (process.env[k] || '').trim();
function fileKey(name) { try { return fs.readFileSync(path.join(__dirname, name), 'utf8').trim(); } catch { return ''; } }
const googleKey = () => env('GOOGLE_TTS_KEY') || fileKey('tts_key.txt');
const sarvamKey = () => env('SARVAM_KEY') || fileKey('sarvam_key.txt');
const deepgramKey = () => env('DEEPGRAM_KEY') || fileKey('deepgram_key.txt');

/* ---- Google monthly character meter: keep usage safely under the 1,000,000 free Chirp3/WaveNet chars ---- */
const GOOGLE_FREE_CAP = parseInt(env('GOOGLE_TTS_CAP') || '900000', 10); // stop well before the paid tier
const METER_FILE = path.join(__dirname, 'tts_meter.json');
function loadMeter() {
  try { const m = JSON.parse(fs.readFileSync(METER_FILE, 'utf8')); if (m && m.month === curMonth()) return m; } catch {}
  return { month: curMonth(), google: 0 };
}
function saveMeter(m) { try { fs.writeFileSync(METER_FILE, JSON.stringify(m)); } catch {} }
function curMonth() { const d = new Date(); return d.getUTCFullYear() + '-' + (d.getUTCMonth() + 1); }
let meter = loadMeter();
function googleRoom(n) { if (meter.month !== curMonth()) meter = { month: curMonth(), google: 0 }; return meter.google + n <= GOOGLE_FREE_CAP; }
function googleUsed(n) { meter.google += n; saveMeter(meter); }

const cache = new Map();
const MAX = 400;
function cacheGet(k) { const v = cache.get(k); if (v) { cache.delete(k); cache.set(k, v); } return v; }
function cacheSet(k, v) { cache.set(k, v); if (cache.size > MAX) cache.delete(cache.keys().next().value); }

function post(url, body, headers) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const u = new URL(url);
    const req = https.request({ method: 'POST', hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'content-length': data.length, ...(headers || {}) } }, (r) => {
      const ch = []; r.on('data', (d) => ch.push(d));
      r.on('end', () => { const s = Buffer.concat(ch); if (r.statusCode !== 200) return reject(new Error('http ' + r.statusCode + ' ' + s.toString('utf8').slice(0, 120))); resolve(s); });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

/* ---- providers ---- */
async function googleTTS(text, voice) {
  const key = googleKey(); if (!key) throw new Error('no key');
  if (!googleRoom(text.length)) throw new Error('monthly free cap reached');
  const name = voice && /^bn-IN/.test(voice) ? voice : 'bn-IN-Chirp3-HD-Enceladus';
  const out = await post('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + encodeURIComponent(key),
    { input: { text }, voice: { languageCode: 'bn-IN', name }, audioConfig: { audioEncoding: 'MP3' } },
    { 'content-type': 'application/json' });
  const j = JSON.parse(out.toString('utf8')); if (!j.audioContent) throw new Error('no audio');
  googleUsed(text.length);
  return Buffer.from(j.audioContent, 'base64');
}
async function sarvamTTS(text) {
  const key = sarvamKey(); if (!key) throw new Error('no key');
  const out = await post('https://api.sarvam.ai/text-to-speech',
    { text, language_code: 'bn-IN', model: 'bulbul:v3', speaker: 'manan', output_audio_codec: 'mp3' },
    { 'content-type': 'application/json', 'api-subscription-key': key });
  const j = JSON.parse(out.toString('utf8')); const b64 = j.audios && j.audios[0]; if (!b64) throw new Error('no audio');
  return Buffer.from(b64, 'base64');
}
async function deepgramTTS(text) {
  const key = deepgramKey(); if (!key) throw new Error('no key');
  // Deepgram Aura is English-first; used only as a backup voice.
  return await post('https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3',
    { text }, { 'content-type': 'application/json', Authorization: 'Token ' + key });
}
function gtransTTS(text) {
  return new Promise((resolve, reject) => {
    const q = encodeURIComponent(text.slice(0, 190));
    https.get('https://translate.google.com/translate_tts?ie=UTF-8&tl=bn&client=tw-ob&q=' + q,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }, (r) => {
        if (r.statusCode !== 200) { r.resume(); return reject(new Error('gtrans ' + r.statusCode)); }
        const ch = []; r.on('data', (d) => ch.push(d)); r.on('end', () => resolve(Buffer.concat(ch)));
      }).on('error', reject);
  });
}

const DEFAULT_VOICE = 'bn-IN-Chirp3-HD-Enceladus';

async function getAudio(text, voice) {
  text = String(text || '').trim().slice(0, 500);
  if (!text) throw new Error('empty');
  const ck = crypto.createHash('sha1').update((voice || '') + '|' + text).digest('hex');
  const hit = cacheGet(ck); if (hit) return hit;
  const errs = [];
  const chain = [
    ['google', () => googleTTS(text, voice)],
    ['sarvam', () => sarvamTTS(text)],
    ['deepgram', () => deepgramTTS(text)],
    ['edge', () => edge && edge.synthesize(text, { voice: 'bn-BD-PradeepNeural' })],
    ['gtrans', () => gtransTTS(text)],
  ];
  for (const [name, fn] of chain) {
    try { const buf = await fn(); if (buf && buf.length) { cacheSet(ck, buf); return buf; } }
    catch (e) { errs.push(name + ':' + (e.message || 'err')); }
  }
  throw new Error('all tts failed: ' + errs.join('; '));
}

module.exports = {
  getAudio, DEFAULT_VOICE,
  status: () => ({ month: meter.month, googleChars: meter.google, googleCap: GOOGLE_FREE_CAP,
    keys: { google: !!googleKey(), sarvam: !!sarvamKey(), deepgram: !!deepgramKey() } }),
};
