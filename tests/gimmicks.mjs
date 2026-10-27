// Checks that RED really uses his gimmicks in battle: Mega Evolution, Z-Moves
// and (on original-team days) Terastallization, and never Dynamax.
//
//   cd tests && npm run gimmicks
//
// For each case it boots a seed whose RED has that gimmick (predicted with
// red.mjs), moves the Pokemon carrying it to the front of his team, and plays
// turns with our Pokemon unkillable and only using Splash, until RED has used
// the gimmick or MAX_TURNS have gone by.
import {
  startServer, launchBrowser, bootGame, sleep, press, getStatus, waitFor, patchMemory, symbol, value, layout, u16,
  startRedBattle, battleMonField, readBattleMon, battleInput, bitsWrite, gimmicksUsed,
} from './lib.mjs';
import { id, item, species, wideValue } from './game.mjs';
import { readRedParty, predictRolls } from './red.mjs';

const MAX_TURNS = 8;
const holdEffect = (it) => (it ? item(it).holdEffect : 'NONE');

// The first seed from 1 up matching a test on its predicted rolls.
function findSeed(test) {
  for (let seed = 1; seed < 5_000_000; seed++) if (test(predictRolls(seed))) return seed;
  throw new Error('no seed found');
}

const CASES = [
  {
    what: "RED's Kanto starter Mega Evolves",
    seed: findSeed((r) => !r.original && r.legendary === 'bird'),
    lead: (m) => holdEffect(m.heldItem) === 'MEGA_STONE',
    gimmick: 'MEGA',
  },
  {
    what: 'Mega Mewtwo Mega Evolves',
    seed: findSeed((r) => !r.original && r.legendary === 'megaMewtwo'),
    lead: (m) => m.species === id('SPECIES', 'MEWTWO'),
    gimmick: 'MEGA',
  },
  {
    what: 'on a Mega Mewtwo day the starter uses its Z-Move',
    seed: findSeed((r) => !r.original && r.legendary === 'megaMewtwo' && !r.cap),
    lead: (m) => holdEffect(m.heldItem) === 'Z_CRYSTAL',
    gimmick: 'Z_MOVE',
  },
  {
    what: "RED's capped Pikachu uses Catastropika (its Pikanium Z)",
    seed: findSeed((r) => !r.original && r.cap),
    lead: (m) => m.heldItem === id('ITEM', 'PIKANIUM_Z'),
    gimmick: 'Z_MOVE',
  },
  {
    // RED's Smart Tera AI only Terastallizes when its damage calculations say
    // it pays, which never happens against Splash. With the flag cleared, the
    // AI Terastallizes as soon as it can: this checks the Tera type is set up.
    what: 'on an original-team day the Tera starter Terastallizes (Smart Tera off for the test)',
    seed: findSeed((r) => r.original),
    lead: (m) => m.teraType !== value('TYPE_MYSTERY'),
    gimmick: 'TERA',
    plainTera: true,
  },
  {
    what: 'on an original-team day the Z-Crystal starter uses its Z-Move',
    seed: findSeed((r) => r.original),
    lead: (m) => holdEffect(m.heldItem) === 'Z_CRYSTAL',
    gimmick: 'Z_MOVE',
  },
];

let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!ok) failures++;
};

const server = await startServer();
const browser = await launchBrowser();
try {
  for (const c of CASES) {
    const page = await browser.newPage();
    try {
      await bootGame(page, server.url, { seed: c.seed });
      let s = await waitFor(page, (st) => st.inOverworld, { what: `overworld for seed ${c.seed}` });
      // Put the Pokemon with the gimmick first, and turn battle animations off.
      const party = readRedParty(s.mem);
      const slot = party.findIndex((m) => m && c.lead(m));
      if (slot < 0) throw new Error(`seed ${c.seed}: no Pokemon for "${c.what}"`);
      const size = layout('Pokemon').size, base = symbol('gDailyRedRedParty');
      const first = [...s.mem.read(base, size)], target = [...s.mem.read(base + slot * size, size)];
      const saveBlock2 = s.mem.read(symbol('gSaveBlock2Ptr'), 4).readUInt32LE(0);
      await patchMemory(page, [
        { addr: base, bytes: target },
        { addr: base + slot * size, bytes: first },
        bitsWrite(s.mem, saveBlock2, layout('SaveBlock2').optionsBattleSceneOff, 1),
      ]);
      await startRedBattle(page);
      const leader = species(readBattleMon((await getStatus(page)).mem, 1, 'species')).constName;
      if (c.plainTera) {
        const st = await getStatus(page);
        const ai = st.mem.read(symbol('gAiThinkingStruct'), 4).readUInt32LE(0);
        const f = layout('AiThinkingStruct').aiFlags;
        const at = ai + f.off + 1 * f.elemSize;
        const flags = st.mem.read(at, 8).readBigUInt64LE(0) & ~wideValue('AI_FLAG_SMART_TERA');
        const bytes = Buffer.alloc(8);
        bytes.writeBigUInt64LE(flags);
        await patchMemory(page, [{ addr: at, bytes: [...bytes] }]);
      }

      // Turns: ours stays at 999 HP and only knows Splash.
      const splash = id('MOVE', 'SPLASH');
      let used = null, turns = 0, everDynamaxed = false, stillIn = true;
      while (turns < MAX_TURNS && !used) {
        await patchMemory(page, [
          { addr: battleMonField(0, 'hp'), bytes: u16(999) },
          { addr: battleMonField(0, 'maxHP'), bytes: u16(999) },
          { addr: battleMonField(0, 'moves'), bytes: [0, 1, 2, 3].flatMap(() => u16(splash)) },
          { addr: battleMonField(0, 'pp'), bytes: [20, 20, 20, 20] },
        ]);
        // FIGHT, Splash, then wait for the next turn menu.
        for (let i = 0; i < 6; i++) {
          const st = await getStatus(page);
          if (!st.inBattle) { stillIn = false; break; }
          const input = battleInput(st.mem);
          if (input === 'busy' && i > 1) break;
          if (input !== 'busy') await press(page, 'a');
          await sleep(300);
        }
        let st;
        for (let i = 0; i < 80; i++) {
          st = await getStatus(page);
          if (!st.inBattle || battleInput(st.mem) === 'action') break;
          if (battleInput(st.mem) === 'move') await press(page, 'b');
          else await press(page, 'a');
          await sleep(300);
        }
        if (!st.inBattle) { stillIn = false; break; }
        turns++;
        const g = gimmicksUsed(st.mem, 1);
        everDynamaxed ||= g.DYNAMAX;
        if (g[c.gimmick]) used = species(readBattleMon(st.mem, 1, 'species')).constName;
      }
      check(Boolean(used), `${c.what} (seed ${c.seed}, ${leader} leading: ${used ? `used it on turn ${turns}, now ${used}` : `not in ${turns} turns${stillIn ? '' : ', battle ended'}`})`);
      check(!everDynamaxed, `RED never Dynamaxes (seed ${c.seed})`);
    } catch (err) {
      failures++;
      console.log('FAIL ', err.message);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
