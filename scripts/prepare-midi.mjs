#!/usr/bin/env node
// Prepares a MIDI dumped from a GBA game with Sappy for the expansion's
// mid2agb, which builds it into a song (sound/songs/midi/, see midi.cfg).
//
//   node scripts/prepare-midi.mjs music/vs-red.mid expansion/sound/songs/midi/mus_dailyred_vs_red.mid
//
// What changes:
// - Sappy writes each track's pitch bend range (the song's BENDR) as RPN 0:
//   CC 101 = 0, CC 100 = 0, then CC 6 = semitones. mid2agb only reads the
//   bend range from CC 20, so the RPN becomes a CC 20 at the same time. Without
//   it every bend would use the default range of 2 semitones.
// - Expression (CC 11), which mid2agb ignores, is folded into volume (CC 7):
//   the track gets volume x expression / 127 whenever either changes.
// - The remaining RPN messages (CC 6, 38, 100, 101) are dropped. RPN 1 and 2
//   (fine and coarse tuning) must be centered; anything else is an error.
// - The loop markers ("[" and "]" text/marker events) move to the first track:
//   mid2agb only reads them from there, and Sappy writes them into the first
//   instrument track. Without them the song plays once and stops.
// Everything else is kept as it is: notes, programs, volume, pan, modulation,
// pitch bends and tempo.
import { readFileSync, writeFileSync } from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('Usage: node scripts/prepare-midi.mjs <in.mid> <out.mid>');
  process.exit(1);
}

// --- Reading ------------------------------------------------------------------------

function readMidi(buf) {
  let pos = 0;
  const u32 = () => { const v = buf.readUInt32BE(pos); pos += 4; return v; };
  const u16 = () => { const v = buf.readUInt16BE(pos); pos += 2; return v; };
  const tag = () => { const s = buf.toString('latin1', pos, pos + 4); pos += 4; return s; };
  if (tag() !== 'MThd') throw new Error('not a MIDI file');
  const headerLength = u32();
  const format = u16(), trackCount = u16(), division = u16();
  pos = 8 + headerLength;

  const tracks = [];
  while (tracks.length < trackCount) {
    const id = tag(), length = u32(), end = pos + length;
    if (id !== 'MTrk') { pos = end; continue; }
    const events = [];
    let time = 0, running = 0;
    const vlq = () => { let v = 0, b; do { b = buf[pos++]; v = (v << 7) | (b & 0x7F); } while (b & 0x80); return v; };
    while (pos < end) {
      time += vlq();
      let status = running; // running status: the last channel message's
      if (buf[pos] & 0x80) status = buf[pos++];
      if (status === 0xFF) {
        const type = buf[pos++], len = vlq();
        events.push({ time, bytes: Buffer.concat([Buffer.from([0xFF, type]), vlqBytes(len), buf.subarray(pos, pos + len)]) });
        pos += len;
      } else if (status === 0xF0 || status === 0xF7) {
        const len = vlq();
        events.push({ time, bytes: Buffer.concat([Buffer.from([status]), vlqBytes(len), buf.subarray(pos, pos + len)]) });
        pos += len;
      } else {
        if (!(status & 0x80)) throw new Error('data byte without a status');
        running = status;
        const kind = status & 0xF0;
        const size = kind === 0xC0 || kind === 0xD0 ? 1 : 2;
        events.push({ time, bytes: Buffer.from([status, ...buf.subarray(pos, pos + size)]) });
        pos += size;
      }
    }
    tracks.push(events);
    pos = end;
  }
  return { format, division, tracks };
}

function vlqBytes(n) {
  const out = [n & 0x7F];
  while ((n >>= 7)) out.unshift((n & 0x7F) | 0x80);
  return Buffer.from(out);
}

// --- Converting -----------------------------------------------------------------------

const cc = (channel, controller, value) => Buffer.from([0xB0 | channel, controller, value]);

function convertTrack(events, trackIndex) {
  const out = [];
  const state = new Map(); // channel -> { rpnMsb, rpnLsb, volume, expression }
  const channelState = (ch) => {
    if (!state.has(ch)) state.set(ch, { rpnMsb: 127, rpnLsb: 127, volume: 100, expression: 127 });
    return state.get(ch);
  };
  for (const ev of events) {
    const [status, controller, value] = ev.bytes;
    if ((status & 0xF0) !== 0xB0) { out.push(ev); continue; }
    const ch = status & 0x0F, s = channelState(ch);
    switch (controller) {
      case 101: s.rpnMsb = value; break;
      case 100: s.rpnLsb = value; break;
      case 38: break; // data entry LSB (cents): mid2agb has no use for it
      case 6:
        if (s.rpnMsb === 0 && s.rpnLsb === 0) {
          out.push({ time: ev.time, bytes: cc(ch, 20, value) }); // BENDR
        } else if (s.rpnMsb === 0 && (s.rpnLsb === 1 || s.rpnLsb === 2)) {
          if (value !== 64) throw new Error(`track ${trackIndex}: RPN ${s.rpnLsb} (tuning) = ${value} isn't supported`);
        } else if (!(s.rpnMsb === 127 && s.rpnLsb === 127)) {
          throw new Error(`track ${trackIndex}: unsupported RPN ${s.rpnMsb}/${s.rpnLsb}`);
        }
        break;
      case 7:
        s.volume = value;
        out.push({ time: ev.time, bytes: cc(ch, 7, Math.round((s.volume * s.expression) / 127)) });
        break;
      case 11:
        s.expression = value;
        out.push({ time: ev.time, bytes: cc(ch, 7, Math.round((s.volume * s.expression) / 127)) });
        break;
      default:
        out.push(ev);
    }
  }
  return out;
}

// --- Writing ----------------------------------------------------------------------------

function writeMidi({ format, division, tracks }) {
  const chunks = [];
  const header = Buffer.alloc(14);
  header.write('MThd', 0, 'latin1');
  header.writeUInt32BE(6, 4);
  header.writeUInt16BE(format, 8);
  header.writeUInt16BE(tracks.length, 10);
  header.writeUInt16BE(division, 12);
  chunks.push(header);
  for (const events of tracks) {
    const parts = [];
    let last = 0;
    for (const ev of events) {
      parts.push(vlqBytes(ev.time - last), ev.bytes); // explicit status bytes, no running status
      last = ev.time;
    }
    const data = Buffer.concat(parts);
    const head = Buffer.alloc(8);
    head.write('MTrk', 0, 'latin1');
    head.writeUInt32BE(data.length, 4);
    chunks.push(head, data);
  }
  return Buffer.concat(chunks);
}

// Text-type meta events (0x01-0x07) whose text is one of mid2agb's markers.
const MARKERS = new Set(['[', ']', '][', ':']);
function markerText(ev) {
  const [status, type] = ev.bytes;
  if (status !== 0xFF || type < 0x01 || type > 0x07) return null;
  let pos = 2, len = 0, b;
  do { b = ev.bytes[pos++]; len = (len << 7) | (b & 0x7F); } while (b & 0x80);
  const text = ev.bytes.toString('latin1', pos, pos + len).replace(/\0+$/, '');
  return MARKERS.has(text) ? text : null;
}

function moveMarkersToFirstTrack(tracks) {
  const markers = [];
  for (let i = 1; i < tracks.length; i++) {
    markers.push(...tracks[i].filter((ev) => markerText(ev) !== null));
    tracks[i] = tracks[i].filter((ev) => markerText(ev) === null);
  }
  if (!markers.length) return 0;
  const isEnd = (ev) => ev.bytes[0] === 0xFF && ev.bytes[1] === 0x2F;
  const first = tracks[0].filter((ev) => !isEnd(ev));
  const end = Math.max(...tracks.map((t) => (t.length ? t[t.length - 1].time : 0)));
  tracks[0] = [...first, ...markers].sort((x, y) => x.time - y.time); // stable: tempo before markers at the same time
  tracks[0].push({ time: end, bytes: Buffer.from([0xFF, 0x2F, 0x00]) });
  return markers.length;
}

const midi = readMidi(readFileSync(input));
midi.tracks = midi.tracks.map(convertTrack);
const moved = moveMarkersToFirstTrack(midi.tracks);
writeFileSync(output, writeMidi(midi));
const bends = midi.tracks.filter((t) => t.some((e) => (e.bytes[0] & 0xF0) === 0xB0 && e.bytes[1] === 20)).length;
console.log(`Wrote ${output}: ${midi.tracks.length} tracks, ${midi.division} ticks per beat, bend range set on ${bends} tracks, ${moved} loop marker(s) in the first track.`);
