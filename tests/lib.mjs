// Shared helpers for the headless browser tests: a static server, Chrome via
// playwright-core, booting the real ROM through the same emulator the website
// uses, pressing buttons, and reading game RAM out of a save state. Struct
// layouts and constants come from the build (game.mjs).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, symbol, symbolsNamed, layout, value, field, id } from './game.mjs';
import { partyAddress } from './party.mjs';

export { ROOT, GAME_DIR, symbol, value, layout } from './game.mjs';

const CHROME_PATHS = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

export function findChrome() {
  const path = CHROME_PATHS.find((p) => existsSync(p));
  if (!path) throw new Error('Google Chrome not found. Set CHROME_PATH to a Chrome/Chromium binary.');
  return path;
}

// Serves web/ on a free port; the server is killed when this process exits.
export async function startServer() {
  const server = spawn(process.execPath, [join(ROOT, 'scripts/serve.mjs'), '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  process.on('exit', () => server.kill());
  const url = await new Promise((ok, fail) => {
    server.stdout.once('data', (line) => ok(String(line).match(/http:\/\/\S+/)[0]));
    server.once('exit', (code) => fail(new Error(`server exited with ${code}`)));
  });
  return { url, close: () => server.kill() };
}

export async function launchBrowser() {
  return chromium.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
}

// Boots the ROM in a bare page (no website UI) with an optional seed. By
// default the game deals a new team after each battle; daily: true plays the
// website's daily game instead (one battle, starting from wins / battles).
// The emulator instance is exposed as window.emu.
export async function bootGame(page, baseUrl, { seed, daily = false, wins = 0, battles = 0 } = {}) {
  await page.goto(`${baseUrl}/__test__`);
  await page.setContent('<canvas id="screen" width="480" height="320" style="display:block"></canvas>');
  await page.evaluate(async ({ seed, daily, wins, battles }) => {
    const { Nostalgist } = await import('/vendor/nostalgist.js');
    const { injectConfig } = await import('/rom-config.js');
    const { loadGameFiles } = await import('/game-files.js');
    const files = await loadGameFiles();
    const rom = seed ? injectConfig(files.rom, { seed, daily, wins, battles }) : files.rom;
    window.emu = await Nostalgist.launch({
      core: 'mgba',
      element: document.getElementById('screen'),
      rom: { fileName: 'dailyred.gba', fileContent: new Blob([rom]) },
      resolveCoreJs: () => files.coreJs,
      resolveCoreWasm: () => files.coreWasm,
      retroarchConfig: { savestate_file_compression: false, savestate_thumbnail_enable: false },
    });
  }, { seed, daily, wins, battles });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Presses a GBA button: a, b, start, select, up, down, left, right, l, r.
export async function press(page, button, holdMs = 120) {
  await page.evaluate(({ button, holdMs }) => window.emu.press(button, 1, holdMs), { button, holdMs });
  await sleep(80);
}

export async function pressMany(page, buttons, gapMs = 250) {
  for (const b of buttons) {
    await press(page, b);
    await sleep(gapMs);
  }
}

export async function screenshot(page, path) {
  // Nostalgist renames the canvas to #canvas (Emscripten's convention).
  await page.locator('canvas').first().screenshot({ path });
}

// --- Game RAM via save states -------------------------------------------------
// mGBA's save state (GBASerializedState) stores IWRAM at 0x19000 and EWRAM at
// 0x21000; see mgba/include/mgba/internal/gba/serialize.h.
const STATE_IWRAM = 0x19000;
const STATE_EWRAM = 0x21000;

export async function readMemory(page) {
  const b64 = await page.evaluate(async () => {
    const { state } = await window.emu.saveState();
    const buf = new Uint8Array(await state.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  });
  let state = Buffer.from(b64, 'base64');
  // RetroArch wraps the core's state in a "RASTATE" container of chunks
  // ("MEM " + u32 size + data, ...). Unwrap the MEM chunk if present.
  if (state.subarray(0, 7).toString('latin1') === 'RASTATE') {
    let pos = 8;
    while (pos + 8 <= state.length) {
      const id = state.subarray(pos, pos + 4).toString('latin1');
      const size = state.readUInt32LE(pos + 4);
      if (id === 'MEM ') { state = state.subarray(pos + 8, pos + 8 + size); break; }
      pos += 8 + size + ((8 - (size % 8)) % 8);
    }
  }
  if ((state.readUInt32LE(0) & 0xFFFF0000) !== 0x01000000) {
    throw new Error('Unexpected save state format (compressed?)');
  }
  return {
    read(addr, len) {
      if (addr >= 0x02000000 && addr < 0x02040000) return state.subarray(STATE_EWRAM + addr - 0x02000000, STATE_EWRAM + addr - 0x02000000 + len);
      if (addr >= 0x03000000 && addr < 0x03008000) return state.subarray(STATE_IWRAM + addr - 0x03000000, STATE_IWRAM + addr - 0x03000000 + len);
      throw new Error(`address ${addr.toString(16)} is not in RAM`);
    },
  };
}

// A struct member read from RAM: memField(mem, addr, 'BattlePokemon', 'hp').
export function memField(mem, addr, struct, name) {
  return field(mem.read(addr, layout(struct).size), 0, struct, name);
}

// --- Game status ----------------------------------------------------------------

// The player's object event, and RED's (by local id).
function objectEventAddress(index) {
  return symbol('gObjectEvents') + index * layout('ObjectEvent').size;
}

export function objectCoords(mem, index) {
  const at = objectEventAddress(index) + layout('ObjectEvent').currentCoords.off;
  const coords = mem.read(at, 4);
  return { x: coords.readInt16LE(0) - value('MAP_OFFSET'), y: coords.readInt16LE(2) - value('MAP_OFFSET') };
}

// Direction an overworld object with the given local id faces (-1 if absent).
export function objectFacing(mem, localId) {
  for (let i = 0; i < value('OBJECT_EVENTS_COUNT'); i++) {
    const addr = objectEventAddress(i);
    if (memField(mem, addr, 'ObjectEvent', 'active') && memField(mem, addr, 'ObjectEvent', 'localId') === localId) {
      return memField(mem, addr, 'ObjectEvent', 'facingDirection');
    }
  }
  return -1;
}

// What the game is doing right now, read from RAM.
export async function getStatus(page) {
  const mem = await readMemory(page);
  const callback2 = memField(mem, symbol('gMain'), 'Main', 'callback2') & ~1; // strip the Thumb bit
  const objectEventId = memField(mem, symbol('gPlayerAvatar'), 'PlayerAvatar', 'objectEventId');
  return {
    mem,
    inBattle: callback2 === symbol('BattleMainCB2'),
    inOverworld: callback2 === symbol('CB2_Overworld'),
    ...objectCoords(mem, objectEventId),
  };
}

export async function waitFor(page, predicate, { timeoutMs = 20000, intervalMs = 500, what = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const status = await getStatus(page);
    if (predicate(status)) return status;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// Walks the player through a list of [x, y] waypoints (straight lines only),
// checking the real position after every step.
export async function walkTo(page, waypoints) {
  for (const [tx, ty] of waypoints) {
    for (let tries = 0; tries < 40; tries++) {
      const { x, y } = await getStatus(page);
      if (x === tx && y === ty) break;
      const dir = tx > x ? 'right' : tx < x ? 'left' : ty > y ? 'down' : 'up';
      await page.evaluate((d) => window.emu.pressDown(d), dir);
      await sleep(200);
      await page.evaluate((d) => window.emu.pressUp(d), dir);
      await sleep(250);
      if (tries === 39) throw new Error(`could not reach ${tx},${ty} (stuck at ${x},${y})`);
    }
  }
}

// Turns to face a direction without moving (a short tap only turns).
export async function face(page, dir) {
  await page.evaluate((d) => window.emu.press(d, 1, 40), dir);
  await sleep(300);
}

// Writes bytes into game RAM by editing a save state and loading it back.
// Used by tests to force battle outcomes quickly. writes: [{ addr, bytes }]
export async function patchMemory(page, writes) {
  await page.evaluate(async (writes) => {
    const { state } = await window.emu.saveState();
    const buf = new Uint8Array(await state.arrayBuffer());
    let mem = 0;
    if (String.fromCharCode(...buf.subarray(0, 7)) === 'RASTATE') {
      for (let pos = 8; pos + 8 <= buf.length;) {
        const id = String.fromCharCode(...buf.subarray(pos, pos + 4));
        const size = new DataView(buf.buffer).getUint32(pos + 4, true);
        if (id === 'MEM ') { mem = pos + 8; break; }
        pos += 8 + size + ((8 - (size % 8)) % 8);
      }
    }
    for (const { addr, bytes } of writes) {
      const off = addr >= 0x03000000 ? 0x19000 + addr - 0x03000000 : 0x21000 + addr - 0x02000000;
      buf.set(bytes, mem + off);
    }
    await window.emu.loadState(new Blob([buf]));
  }, writes);
  await sleep(500); // RetroArch can't save another state right after loading one
}

export const u16 = (n) => [n & 0xFF, (n >> 8) & 0xFF];
export const u32 = (n) => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];

// A write that sets one bitfield ({ bit, width } from game.mjs's layout) of
// the struct at `addr`, keeping the bits around it.
export function bitsWrite(mem, addr, { bit, width }, v) {
  const at = addr + (bit >> 3), shift = bit & 7;
  const bytes = Math.ceil((shift + width) / 8);
  let word = 0;
  for (let i = 0; i < bytes; i++) word += mem.read(at + i, 1)[0] * 2 ** (8 * i);
  const old = Math.floor(word / 2 ** shift) % 2 ** width;
  word += ((v % 2 ** width) - old) * 2 ** shift;
  return { addr: at, bytes: Array.from({ length: bytes }, (_, i) => Math.floor(word / 2 ** (8 * i)) % 256) };
}

// A snapshot of the emulator to come back to: saveSnapshot keeps the current
// state in the page, loadSnapshot restores it with some bytes changed.
export async function saveSnapshot(page) {
  await page.evaluate(async () => {
    const { state } = await window.emu.saveState();
    window.__snapshot = new Uint8Array(await state.arrayBuffer());
  });
  await sleep(300);
}

export async function loadSnapshot(page, writes = []) {
  await page.evaluate(async (writes) => {
    const buf = window.__snapshot.slice();
    let mem = 0;
    if (String.fromCharCode(...buf.subarray(0, 7)) === 'RASTATE') {
      for (let pos = 8; pos + 8 <= buf.length;) {
        const id = String.fromCharCode(...buf.subarray(pos, pos + 4));
        const size = new DataView(buf.buffer).getUint32(pos + 4, true);
        if (id === 'MEM ') { mem = pos + 8; break; }
        pos += 8 + size + ((8 - (size % 8)) % 8);
      }
    }
    for (const { addr, bytes } of writes) {
      const off = addr >= 0x03000000 ? 0x19000 + addr - 0x03000000 : 0x21000 + addr - 0x02000000;
      buf.set(bytes, mem + off);
    }
    await window.emu.loadState(new Blob([buf]));
  }, writes);
  await sleep(500);
}

// Reads a script variable (VAR_xxxx) from SaveBlock1.
export function readVar(mem, varId) {
  const saveBlock1 = mem.read(symbol('gSaveBlock1Ptr'), 4).readUInt32LE(0);
  const vars = layout('SaveBlock1').vars;
  return mem.read(saveBlock1 + vars.off + (varId - value('VARS_START')) * vars.elemSize, 2).readUInt16LE(0);
}

// --- Battle state -----------------------------------------------------------------

// gBattleMons[battler] (battler 0 = the player's, 1 = RED's).
export const battleMonAddress = (battler) => symbol('gBattleMons') + battler * layout('BattlePokemon').size;
export const battleMonField = (battler, name) => battleMonAddress(battler) + layout('BattlePokemon')[name].off;
export const readBattleMon = (mem, battler, name) => memField(mem, battleMonAddress(battler), 'BattlePokemon', name);
export const activePartySlot = (mem, battler) => mem.read(symbol('gBattlerPartyIndexes') + battler * 2, 2).readUInt16LE(0);

// Writes that make a party Pokemon fainted (HP 0), keeping the box's
// hpLost in step with it.
export function faintWrites(side, slot, mem) {
  const P = layout('Pokemon'), B = layout('BoxPokemon');
  const addr = partyAddress(side) + slot * P.size;
  const maxHp = memField(mem, addr, 'Pokemon', 'maxHP');
  const hpLostByte = addr + (B.hpLost.bit >> 3);
  const word = mem.read(hpLostByte, 2).readUInt16LE(0);
  const shift = B.hpLost.bit & 7, mask = ((1 << B.hpLost.width) - 1) << shift;
  const newWord = (word & ~mask) | ((maxHp << shift) & mask);
  return [
    { addr: addr + P.hp.off, bytes: u16(0) },
    { addr: hpLostByte, bytes: u16(newWord) },
  ];
}

// --- Forcing battle results (tests only) ------------------------------------------
// Call while the battle's turn menu is up. These edit HP in RAM so the next
// exchange ends the battle: a win (RED's active Pokemon at 1 HP and the rest of
// his team fainted, ours unkillable with a move that always does 100) or a
// loss (our active Pokemon at 1 HP and the rest of our team fainted).
export async function forceWin(page) {
  const { mem } = await getStatus(page);
  const activeSlot = activePartySlot(mem, 1); // battler 1 = RED
  await patchMemory(page, [
    ...[0, 1, 2, 3, 4, 5].filter((i) => i !== activeSlot).flatMap((i) => faintWrites('Enemy', i, mem)),
    ...unkillableWrites(),
    ...helplessWrites(1),
    { addr: battleMonField(1, 'hp'), bytes: u16(1) },
  ]);
}

// A battler that can't heal, protect itself or hold on (RED's smart AI would
// otherwise Recover or Roost out of a forced knockout every turn): Splash
// only, no item or ability, plain Normal type.
export function helplessWrites(battler) {
  const splash = id('MOVE', 'SPLASH'), normal = id('TYPE', 'NORMAL');
  return [
    { addr: battleMonField(battler, 'moves'), bytes: [0, 1, 2, 3].flatMap(() => u16(splash)) },
    { addr: battleMonField(battler, 'pp'), bytes: [20, 20, 20, 20] },
    { addr: battleMonField(battler, 'item'), bytes: u16(0) },
    { addr: battleMonField(battler, 'ability'), bytes: u16(0) },
    { addr: battleMonField(battler, 'types'), bytes: [normal, normal] },
  ];
}

export async function forceLoss(page) {
  const { mem } = await getStatus(page);
  const activeSlot = activePartySlot(mem, 0); // battler 0 = us
  await patchMemory(page, [
    ...[0, 1, 2, 3, 4, 5].filter((i) => i !== activeSlot).flatMap((i) => faintWrites('Player', i, mem)),
    { addr: battleMonField(0, 'hp'), bytes: u16(1) },
  ]);
}

// Our active Pokemon: 999 HP and Seismic Toss (always 100 damage at level 100)
// in its first slot, with PP.
export function unkillableWrites() {
  const seismicToss = id('MOVE', 'SEISMIC_TOSS');
  return [
    { addr: battleMonField(0, 'hp'), bytes: u16(999) },
    { addr: battleMonField(0, 'maxHP'), bytes: u16(999) },
    { addr: battleMonField(0, 'moves'), bytes: u16(seismicToss) },
    { addr: battleMonField(0, 'pp'), bytes: [20] },
  ];
}

// From the start tile: climb to RED, talk, and wait for the battle's turn menu.
export async function startRedBattle(page) {
  await walkTo(page, [[9, 7]]); // the top of the stairs, below RED
  await face(page, 'up');
  await press(page, 'a');
  for (let i = 0; i < 20 && !(await getStatus(page)).inBattle; i++) {
    await sleep(500);
    await press(page, 'a');
  }
  if (!(await getStatus(page)).inBattle) throw new Error('battle did not start');
  await waitForActionMenu(page);
}

// What the player's side of the battle is waiting for, from the battle
// controller function battler 0 is running: 'action' (the "What will X do?"
// menu), 'move' (the move list) or 'busy' (anything else: intro, messages,
// the turn playing out).
export function battleInput(mem) {
  const fn = mem.read(symbol('gBattlerControllerFuncs'), 4).readUInt32LE(0) & ~1;
  if (symbolsNamed('HandleInputChooseAction').includes(fn)) return 'action';
  if (fn === symbol('HandleInputChooseMove')) return 'move';
  return 'busy';
}

// Presses A through the battle intro (or anything else) until the turn menu
// is up, backing out of the move list if a press opened it.
export async function waitForActionMenu(page, timeoutMs = 40000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const state = battleInput((await getStatus(page)).mem);
    if (state === 'action') { await sleep(300); return; }
    await press(page, state === 'move' ? 'b' : 'a');
    await sleep(600);
  }
  throw new Error('the battle turn menu did not come up');
}

// The gimmicks a battler has used this battle (gBattleStruct->gimmick.activated).
export function gimmicksUsed(mem, battler) {
  const battleStruct = mem.read(symbol('gBattleStruct'), 4).readUInt32LE(0);
  const f = layout('BattleStruct').gimmick_activated;
  const row = mem.read(battleStruct + f.off + battler * f.elemSize, f.elemSize);
  return Object.fromEntries(['MEGA', 'Z_MOVE', 'DYNAMAX', 'TERA'].map((g) => [g, row[value(`GIMMICK_${g}`)] === 1]));
}

// The game's status block for the website (sStatus in src/dailyred.c), found
// in EWRAM by its magic bytes: { phase, result }.
export function readGameStatus(mem) {
  const ewram = mem.read(0x02000000, 0x40000);
  const at = ewram.indexOf('DAILYRED-STATUS1', 0, 'latin1');
  return at < 0 ? null : { phase: ewram[at + 20], result: ewram[at + 21] };
}
