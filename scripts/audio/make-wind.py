#!/usr/bin/env python3
"""Turns music/mt-silver-wind.ogg (Mt. Silver's summit wind from HGSS, a
loop) into Daily Red's summit "music" (MUS_DAILYRED_MT_SILVER_WIND):

    python3 scripts/audio/make-wind.py      (needs ffmpeg)

- expansion/sound/direct_sound_samples/dailyred_mt_silver_wind.wav: the
  recording at the GBA's mixing rate (13379 Hz), mono, with a 'smpl' chunk
  that loops the whole sample (wav2agb turns it into the .bin the game plays).
  The last LOOP_FADE samples are crossfaded into the start so the loop point
  doesn't click, and it's made GAIN times louder with soft clipping (tanh):
  a single GBA channel plays it, much quieter than a whole song, and HGSS's
  wind is up front.
- expansion/sound/songs/midi/mus_dailyred_mt_silver_wind.mid: one track that
  holds a single note (C3, the sample's own pitch) forever: the note starts
  before the song's loop and the loop only waits, so the sample just keeps
  looping. mid2agb turns it into the song (see midi.cfg).
The output is deterministic; run it again after replacing the recording.
"""
import math
import os
import struct
import subprocess

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..'))
SOURCE = os.path.join(ROOT, 'music', 'mt-silver-wind.ogg')
SAMPLE = os.path.join(ROOT, 'expansion', 'sound', 'direct_sound_samples', 'dailyred_mt_silver_wind.wav')
SONG = os.path.join(ROOT, 'expansion', 'sound', 'songs', 'midi', 'mus_dailyred_mt_silver_wind.mid')

RATE = 13379      # FireRed's sound mixing rate
LOOP_FADE = 600   # samples (45 ms)
UNITY_NOTE = 60   # C3 in the song plays the sample at RATE
GAIN = 2.5        # about +8 dB before soft clipping


def decode():
    raw = subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', SOURCE,
                          '-ac', '1', '-ar', str(RATE), '-f', 's16le', '-'],
                         check=True, stdout=subprocess.PIPE).stdout
    return list(struct.unpack('<%dh' % (len(raw) // 2), raw))


def crossfade_loop(samples):
    """Fades the tail into the head and drops the tail: the loop then jumps
    from the sample before the tail to a head that starts as the tail did."""
    head, tail = samples[:LOOP_FADE], samples[-LOOP_FADE:]
    for i in range(LOOP_FADE):
        t = i / LOOP_FADE
        head[i] = int(round(head[i] * t + tail[i] * (1 - t)))
    return head + samples[LOOP_FADE:-LOOP_FADE]


def louder(samples):
    return [int(round(32767 * math.tanh(GAIN * s / 32767))) for s in samples]


def write_wav(samples):
    data = struct.pack('<%dh' % len(samples), *samples)
    fmt = struct.pack('<HHIIHH', 1, 1, RATE, RATE * 2, 2, 16)
    smpl = struct.pack('<9I', 0, 0, 1000000000 // RATE, UNITY_NOTE, 0, 0, 0, 1, 0)
    smpl += struct.pack('<6I', 0, 0, 0, len(samples) - 1, 0, 0)  # loop the whole sample
    chunks = b'fmt ' + struct.pack('<I', len(fmt)) + fmt
    chunks += b'smpl' + struct.pack('<I', len(smpl)) + smpl
    chunks += b'data' + struct.pack('<I', len(data)) + data
    with open(SAMPLE, 'wb') as f:
        f.write(b'RIFF' + struct.pack('<I', 4 + len(chunks)) + b'WAVE' + chunks)


def vlq(v):
    out = [v & 0x7F]
    v >>= 7
    while v:
        out.insert(0, (v & 0x7F) | 0x80)
        v >>= 7
    return bytes(out)


def write_song():
    # 24 ticks per beat: the note at 0, the loop from beat 1 to bar 5.
    events = [
        (0, b'\xff\x51\x03' + (500000).to_bytes(3, 'big')),  # 120 bpm
        (0, b'\xc0\x00'),                                      # voice 0: the wind
        (0, b'\xb0\x07\x7f'),                                  # full volume (midi.cfg's -V scales it)
        (0, bytes([0x90, UNITY_NOTE, 0x7F])),                  # note on, held for good
        (24, b'\xff\x06\x01['),                                # loop start
        (24 + 384, b'\xff\x06\x01]'),                          # loop end
        (24 + 384 + 24, bytes([0x80, UNITY_NOTE, 0])),         # never reached
        (24 + 384 + 24, b'\xff\x2f\x00'),
    ]
    track, now = b'', 0
    for time, event in events:
        track += vlq(time - now) + event
        now = time
    with open(SONG, 'wb') as f:
        f.write(b'MThd' + struct.pack('>IHHH', 6, 0, 1, 24) + b'MTrk' + struct.pack('>I', len(track)) + track)


if __name__ == '__main__':
    samples = louder(crossfade_loop(decode()))
    write_wav(samples)
    write_song()
    print('wind: %d samples (%.2f s at %d Hz) -> %s, %s' % (len(samples), len(samples) / RATE, RATE,
          os.path.relpath(SAMPLE, ROOT), os.path.relpath(SONG, ROOT)))
