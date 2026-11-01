// Follows RED's battle by reading the game's RAM straight out of the emulator.
//
// The game keeps a status block in RAM (sStatus in pokefirered/src/dailyred.c):
// the magic "DAILYRED-STATUS1", the seed it was booted with, a phase byte and a
// result byte. We search the emulator's WebAssembly memory for the magic
// followed by our seed (the ROM's own copy of the magic isn't followed by it),
// remember where it is, and read the two bytes on each call.
//
// The emulator's memory is hundreds of megabytes, and scanning it in one go
// blocks the page for 50 ms on a laptop and 250 ms or more on a phone, which
// freezes the picture and breaks up the sound. So the search runs in the
// background in small time slices, yielding between them so the emulator keeps
// its frames.

const MAGIC = new Uint32Array(new TextEncoder().encode('DAILYRED-STATUS1').buffer);
const SLICE_MS = 3;        // longest a search slice may run
const RETRY_MS = 500;      // wait before searching again when a pass finds nothing
const CHECK_EVERY = 65536; // words between clock checks

export const PHASE = { EXPLORING: 0, BATTLE: 1, RESULT: 2, FINISHED: 3 };
export const RESULT = { NONE: 0, WON: 1, LOST: 2 };

// Returns read(): { phase, result }, or null until the status block has been
// found (just after boot). read.stop() ends a search still running.
export function createGameLink(emulator, seed) {
  let offset = -1;
  let stopped = false;
  const heapOf = () => emulator.getEmscriptenModule().HEAPU8; // replaced if memory grows

  (async () => {
    while (!stopped && offset < 0) {
      offset = await search(heapOf, seed >>> 0, () => stopped);
      if (offset < 0 && !stopped) await sleep(RETRY_MS);
    }
  })().catch(() => {});

  function read() {
    if (offset < 0) return null;
    const heap = heapOf();
    return { phase: heap[offset + 20], result: heap[offset + 21] };
  }
  read.stop = () => { stopped = true; };
  return read;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One pass over the memory, a few milliseconds at a time.
async function search(heapOf, seed, isStopped) {
  let i = 0;
  for (;;) {
    const heap = heapOf();
    const words = new Uint32Array(heap.buffer, heap.byteOffset, heap.byteLength >>> 2);
    const end = words.length - 5;
    const until = performance.now() + SLICE_MS;
    while (i < end) {
      const stop = Math.min(end, i + CHECK_EVERY);
      for (; i < stop; i++) {
        if (words[i] === MAGIC[0] && words[i + 1] === MAGIC[1] && words[i + 2] === MAGIC[2]
         && words[i + 3] === MAGIC[3] && words[i + 4] === seed) {
          return i * 4;
        }
      }
      if (performance.now() >= until) break;
    }
    if (i >= end) return -1;
    await sleep(0);
    if (isStopped()) return -1;
  }
}
