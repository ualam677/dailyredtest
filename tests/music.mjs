// Records what RED's battle sounds like in the game: boots the ROM, starts
// RED's battle and captures the emulator's audio output (the same audio the
// website plays) to tests/output/vs-red.wav, then checks it: the music plays
// the whole time (no silent stretches), doesn't clip, and is still going after
// the song's loop point.
//
//   node music.mjs [seconds]     # default 75: the first play-through plus the loop
//
// The emulator runs in real time, so this takes about as long as it records.
import { mkdirSync, writeFileSync } from 'node:fs';
import { startServer, launchBrowser, bootGame, waitFor, startRedBattle, getStatus, sleep, symbol, memField } from './lib.mjs';

const OUT = new URL('./output/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const seconds = Number(process.argv[2] || 75);

let failures = 0;
function check(ok, message) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
  if (!ok) failures++;
}

// RetroArch's web audio driver plays each chunk of emulator audio through an
// AudioBufferSourceNode; keep a copy of every buffer it starts.
function captureAudio() {
  window.__audio = { chunks: [], sampleRate: 0, recording: false };
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...args) {
    if (window.__audio.recording && this.buffer) {
      window.__audio.sampleRate = this.buffer.sampleRate;
      window.__audio.chunks.push([new Float32Array(this.buffer.getChannelData(0)), new Float32Array(this.buffer.getChannelData(1))]);
    }
    return start.apply(this, args);
  };
}

function wav(samples, sampleRate) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(v, i * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const server = await startServer();
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  await page.addInitScript(captureAudio);
  await bootGame(page, server.url, { seed: 2024 });
  await waitFor(page, (s) => s.inOverworld, { what: 'overworld' });
  await startRedBattle(page);
  const { mem } = await getStatus(page);
  check(memField(mem, symbol('gMPlayInfo_BGM'), 'MusicPlayerInfo', 'songHeader') === symbol('mus_dailyred_vs_red'), 'the vs Red theme is playing');

  await page.evaluate(() => { window.__audio.recording = true; });
  console.log(`Recording ${seconds} s...`);
  await sleep(seconds * 1000);
  const { sampleRate, b64 } = await page.evaluate(() => {
    const a = window.__audio;
    a.recording = false;
    const frames = a.chunks.reduce((n, [l]) => n + l.length, 0);
    const pcm = new Int16Array(frames * 2);
    let i = 0;
    for (const [l, r] of a.chunks) {
      for (let j = 0; j < l.length; j++) {
        pcm[i++] = Math.max(-32768, Math.min(32767, Math.round(l[j] * 32767)));
        pcm[i++] = Math.max(-32768, Math.min(32767, Math.round(r[j] * 32767)));
      }
    }
    const bytes = new Uint8Array(pcm.buffer);
    let s = '';
    for (let k = 0; k < bytes.length; k += 0x8000) s += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
    return { sampleRate: a.sampleRate, b64: btoa(s) };
  });
  const buf = Buffer.from(b64, 'base64');
  const samples = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
  writeFileSync(`${OUT}/vs-red.wav`, wav(samples, sampleRate));
  const recorded = samples.length / 2 / sampleRate;
  console.log(`Wrote tests/output/vs-red.wav (${recorded.toFixed(1)} s at ${sampleRate} Hz)`);

  // Loudness per second (RMS around the second's mean, so a DC offset can't
  // pass for sound, in dBFS) and peaks.
  const perSecond = [];
  let peak = 0, clipped = 0;
  for (let s = 0; s + sampleRate <= samples.length / 2; s += sampleRate) {
    let sum = 0, sumSq = 0;
    for (let k = s * 2; k < (s + sampleRate) * 2; k++) {
      const v = samples[k];
      sum += v;
      sumSq += v * v;
      peak = Math.max(peak, Math.abs(v));
      if (Math.abs(v) >= 32767) clipped++;
    }
    const n = sampleRate * 2, mean = sum / n;
    perSecond.push(20 * Math.log10(Math.sqrt(Math.max(0, sumSq / n - mean * mean)) / 32768 + 1e-9));
  }
  console.log('Loudness per second (dBFS):', perSecond.map((d) => d.toFixed(0)).join(' '));
  check(recorded >= seconds * 0.9, `recorded ${recorded.toFixed(1)} s of audio`);
  check(perSecond.every((d) => d > -45), `music the whole time: quietest second ${Math.min(...perSecond).toFixed(1)} dBFS`);
  check(clipped < samples.length * 1e-4, `no clipping (${clipped} clipped samples, peak ${(20 * Math.log10(peak / 32768)).toFixed(1)} dBFS)`);
  const after = await getStatus(page);
  check(after.inBattle && memField(after.mem, symbol('gMPlayInfo_BGM'), 'MusicPlayerInfo', 'songHeader') === symbol('mus_dailyred_vs_red'), `still the vs Red theme after ${seconds} s (past the loop point at 67 s)`);
} catch (err) {
  failures++;
  console.log('FAIL ', err.message);
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
