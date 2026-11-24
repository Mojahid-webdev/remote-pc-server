'use strict';
/* Minimal Microsoft Edge (Azure) Neural TTS client over WebSocket — no API key.
 * Returns an MP3 Buffer for the given text + voice. Implements the Sec-MS-GEC token. */
const crypto = require('crypto');
const WebSocket = require('ws');

const TRUSTED_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WIN_EP = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=' + TRUSTED_TOKEN;

// Sec-MS-GEC: SHA-256 (uppercase hex) of "<ticks>TRUSTED_TOKEN", ticks = Windows file-time
// rounded down to the nearest 5 minutes (300s), in 100-ns units since 1601-01-01.
function gecToken() {
  let ticks = Math.floor(Date.now() / 1000) + 11644473600; // unix->1601 epoch seconds
  ticks -= ticks % 300;
  ticks *= 1e7;
  return crypto.createHash('sha256').update(ticks + TRUSTED_TOKEN, 'ascii').digest('hex').toUpperCase();
}

function connId() { return crypto.randomUUID().replace(/-/g, ''); }

function ssml(text, voice, rate, pitch) {
  const esc = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lang = (voice.match(/^[a-z]{2}-[A-Z]{2}/) || ['bn-BD'])[0];
  return `<speak version='1.0' xml:lang='${lang}'><voice name='${voice}'>` +
    `<prosody pitch='${pitch}' rate='${rate}' volume='+0%'>${esc}</prosody></voice></speak>`;
}

function synthesize(text, { voice = 'bn-BD-PradeepNeural', rate = '+0%', pitch = '+0%', timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = WIN_EP + '&Sec-MS-GEC=' + gecToken() + '&Sec-MS-GEC-Version=1-130.0.2849.68&ConnectionId=' + connId();
    const ws = new WebSocket(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        Pragma: 'no-cache', 'Cache-Control': 'no-cache',
      },
    });
    const chunks = [];
    let done = false;
    const fail = (e) => { if (!done) { done = true; try { ws.close(); } catch {} reject(e); } };
    const timer = setTimeout(() => fail(new Error('tts timeout')), timeout);

    ws.on('open', () => {
      const ts = new Date().toString();
      ws.send(`X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
        JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: false }, outputFormat: 'audio-24khz-48kbitrate-mono-mp3' } } } }));
      ws.send(`X-RequestId:${connId()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}\r\nPath:ssml\r\n\r\n` + ssml(text, voice, rate, pitch));
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // binary frame: 2-byte big-endian header length, then header, then audio
        const hlen = data.readUInt16BE(0);
        const header = data.slice(2, 2 + hlen).toString('utf8');
        if (header.includes('Path:audio')) chunks.push(data.slice(2 + hlen));
      } else {
        const s = data.toString();
        if (s.includes('Path:turn.end')) { done = true; clearTimeout(timer); try { ws.close(); } catch {} resolve(Buffer.concat(chunks)); }
      }
    });
    ws.on('error', (e) => { clearTimeout(timer); fail(e); });
    ws.on('close', () => { clearTimeout(timer); if (!done) fail(new Error('tts closed early')); });
  });
}
module.exports = { synthesize };
