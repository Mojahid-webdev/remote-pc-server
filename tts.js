'use strict';
/* Server-side TTS for JC. Providers, in order of preference:
 *   1. Google Cloud TTS  (male Bengali: bn-IN-Chirp3-HD-Enceladus / bn-IN-Wavenet-B) — needs GOOGLE_TTS_KEY
 *   2. Microsoft Edge Neural (bn-BD-PradeepNeural, male) — no key
 *   3. Google Translate TTS (bn, fallback) — no key, female
 * Key is read from env (GOOGLE_TTS_KEY) or tts_key.txt next to this file. Never sent to the phone.
 * In-memory LRU cache so repeated lines don't re-synthesize. */
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let edge = null;
try { edge = require('./edge-tts'); } catch {}

function googleKey() {
  let k = (process.env.GOOGLE_TTS_KEY || '').trim();
  if (!k) { try { k = fs.readFileSync(path.join(__dirname, 'tts_key.txt'), 'utf8').trim(); } catch {} }
  return k;
}

const cache = new Map();
const MAX = 300;
function cacheGet(k) { const v = cache.get(k); if (v) { cache.delete(k); cache.set(k, v); } return v; }
function cacheSet(k, v) { cache.set(k, v); if (cache.size > MAX) cache.delete(cache.keys().next().value); }

function postJSON(url, body, headers) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const u = new URL(url);
    const req = https.request({ method: 'POST', hostname: u.hostname, path: u.pathname + u.search,
      headers: { 'content-type': 'application/json', 'content-length': data.length, ...(headers || {}) } }, (r) => {
      const ch = []; r.on('data', (d) => ch.push(d));
      r.on('end', () => { const s = Buffer.concat(ch).toString('utf8');
        if (r.statusCode !== 200) return reject(new Error('http ' + r.statusCode + ' ' + s.slice(0, 120)));
        resolve(s); });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

// Google Cloud Text-to-Speech (REST, API key). voice e.g. bn-IN-Chirp3-HD-Enceladus (male)
async function googleTTS(text, voice) {
  const key = googleKey();
  if (!key) throw new Error('no google key');
  const name = voice && /^bn-IN/.test(voice) ? voice : 'bn-IN-Chirp3-HD-Enceladus';
  const body = {
    input: { text },
    voice: { languageCode: 'bn-IN', name },
    audioConfig: { audioEncoding: 'MP3', speakingRate: 1.0, pitch: 0.0 },
  };
  const out = await postJSON('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + encodeURIComponent(key), body);
  const j = JSON.parse(out);
  if (!j.audioContent) throw new Error('no audio');
  return Buffer.from(j.audioContent, 'base64');
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

const DEFAULT_VOICE = 'bn-IN-Chirp3-HD-Enceladus'; // male Bengali (India)

async function getAudio(text, voice) {
  text = String(text || '').trim().slice(0, 500);
  if (!text) throw new Error('empty');
  const key = crypto.createHash('sha1').update((voice || '') + '|' + text).digest('hex');
  const hit = cacheGet(key);
  if (hit) return hit;
  let buf = null, errs = [];
  // 1) Google Cloud (male, best) if key present
  try { buf = await googleTTS(text, voice); } catch (e) { errs.push('g:' + e.message); buf = null; }
  // 2) Edge neural male (no key)
  if ((!buf || !buf.length) && edge) {
    try { buf = await edge.synthesize(text, { voice: 'bn-BD-PradeepNeural' }); } catch (e) { errs.push('e:' + e.message); buf = null; }
  }
  // 3) Google Translate (female, always works)
  if (!buf || !buf.length) {
    try { buf = await gtransTTS(text); } catch (e) { errs.push('t:' + e.message); }
  }
  if (!buf || !buf.length) throw new Error('all tts failed: ' + errs.join('; '));
  cacheSet(key, buf);
  return buf;
}

module.exports = { getAudio, DEFAULT_VOICE, hasGoogleKey: () => !!googleKey() };
