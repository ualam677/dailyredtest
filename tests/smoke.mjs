// End-to-end smoke test: boots the real ROM in headless Chrome through the
// website's emulator and checks the whole game loop.
//
//   cd tests && npm install && npm test
//
// Screenshots are written to tests/output/ for a visual check.
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  startServer, launchBrowser, bootGame, sleep, press, screenshot,
  getStatus, waitFor, walkTo, face, patchMemory, readVar, symbol, value, u16,
  startRedBattle, waitForActionMenu, forceWin, readGameStatus, memField, objectFacing,
  battleMonField, readBattleMon, activePartySlot, faintWrites, unkillableWrites,
  bitsWrite, saveSnapshot, loadSnapshot, u32, battleInput,
} from './lib.mjs';
import { GAME_DIR, id, readBits, layout, field, rom, romOffset, textAt, species } from './game.mjs';
import { readParty, formatMon, validateTeam, friendshipWrites, laterEvolutions, LATER_EVOLUTION_LIST } from './party.mjs';

const OUT = new URL('./output/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const VAR_BATTLES = value('VAR_DAILYRED_BATTLES');
const VAR_WINS = value('VAR_DAILYRED_WINS');
const STYLE_SET = value('OPTIONS_BATTLE_STYLE_SET');
const START = [value('DAILYRED_START_X'), value('DAILYRED_START_Y')];
const RED_FRONT = [9, 12]; // the tile below RED, at the top of the stairs
const SPECIES_PIKACHU = id('SPECIES', 'PIKACHU');

// Direction RED's overworld object faces.
const redFacing = (mem) => objectFacing(mem, value('LOCALID_DAILYRED_RED'));

// The Options menu's battle style (a bitfield in SaveBlock2).
function optionsBattleStyle(mem) {
  const saveBlock2 = mem.read(symbol('gSaveBlock2Ptr'), 4).readUInt32LE(0);
  return readBits(mem.read(saveBlock2, layout('SaveBlock2').size), 0, layout('SaveBlock2').optionsBattleStyle);
}

let failures = 0;
function check(ok, message) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
  if (!ok) failures++;
}

const teamKey = (party) => party.map((m) => m && `${m.species}:${m.moves.join(',')}`).join('|');

function checkTeam(label, team) {
  const problems = validateTeam(team);
  check(problems.length === 0, `${label}: valid team (6 different in-scope species, level 100, learnable moves, legal stats, held items)${problems.length ? ': ' + problems.join('; ') : ''}`);
}

async function talkToRed(page, shot) {
  await walkTo(page, [RED_FRONT]);
  await face(page, 'up');
  if (shot) { await sleep(500); await screenshot(page, shot); }
  await press(page, 'a');
  for (let i = 0; i < 20; i++) {
    const s = await getStatus(page);
    if (s.inBattle) return s;
    await press(page, 'a');
    await sleep(500);
  }
  throw new Error('battle did not start');
}

// Mashes A through the battle and the post-battle messages until the next run
// has started: back at the start tile with the battle counter increased.
async function finishBattle(page, battlesBefore) {
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    for (let i = 0; i < 6; i++) { await press(page, 'a'); await sleep(250); }
    const s = await getStatus(page);
    if (s.inOverworld && s.x === START[0] && s.y === START[1] && readVar(s.mem, VAR_BATTLES) === battlesBefore + 1) return s;
  }
  throw new Error('battle did not finish');
}

// RED's lines and the record messages, read from the ROM.
check(textAt('DailyRed_Summit_Text_RedIntro') === '…', `RED's intro is "…" (got "${textAt('DailyRed_Summit_Text_RedIntro')}")`);
check(textAt('DailyRed_Summit_Text_RedVictory') === '…', `RED's win line is "…" (got "${textAt('DailyRed_Summit_Text_RedVictory')}")`);
check(textAt('DailyRed_Summit_Text_RedDefeat') === '…!', `RED's loss line is "…!" (got "${textAt('DailyRed_Summit_Text_RedDefeat')}")`);
check(textAt('DailyRed_Summit_Text_RecordWin').endsWith('Play again tomorrow!') && textAt('DailyRed_Summit_Text_RecordLoss').endsWith('Try again tomorrow.')
  && textAt('DailyRed_Summit_Text_NextRun').includes('Climb back up and face RED!'), 'the record and come-back-tomorrow messages are kept');

// The vs Red theme: in the song table under MUS_DAILYRED_VS_RED, with its own
// voicegroup, and every track loops back (mid2agb turned the MIDI's loop
// markers into a GOTO at the end of each of its 10 tracks).
const songEntry = romOffset(symbol('gSongTable')) + value('MUS_DAILYRED_VS_RED') * layout('Song').size;
check(field(rom(), songEntry, 'Song', 'header') === symbol('mus_dailyred_vs_red'), 'MUS_DAILYRED_VS_RED is the vs Red theme');
const songHeader = romOffset(symbol('mus_dailyred_vs_red'));
check(rom().readUInt32LE(songHeader + 4) === symbol('voicegroup_dailyred_vs_red'), 'the song uses its own voicegroup (voicegroup_dailyred_vs_red)');
const songAsm = readFileSync(join(GAME_DIR, 'sound/songs/midi/mus_dailyred_vs_red.s'), 'utf8');
check(rom()[songHeader] === 10 && (songAsm.match(/\bGOTO\b/g) ?? []).length === 10, `all ${rom()[songHeader]} tracks of the song loop`);

// Mechanics: no friendship/affection battle effects.
check(value('B_AFFECTION_MECHANICS') === 0 && value('B_FRIENDSHIP_BOOST') === 0, 'affection and friendship battle boosts are off (B_AFFECTION_MECHANICS, B_FRIENDSHIP_BOOST)');

// Species scope: the later-generation evolutions in dailyred_team.c are
// exactly the ones the ROM's evolution tables lead to from Gens 1-3.
const scopeTable = new Set(LATER_EVOLUTION_LIST), scopeRom = laterEvolutions();
const missing = [...scopeRom].filter((sp) => !scopeTable.has(sp)), extra = [...scopeTable].filter((sp) => !scopeRom.has(sp));
check(!missing.length && !extra.length, `the later-evolution list matches the game's evolutions (${scopeRom.size} species)`
  + `${missing.length ? '; missing ' + missing.map((sp) => species(sp).name).join(', ') : ''}${extra.length ? '; not evolutions: ' + extra.map((sp) => species(sp).name).join(', ') : ''}`);

const server = await startServer();
const browser = await launchBrowser();
let page;
try {
  // 1. Same seed => same team, different seed => different team.
  const teams = {};
  for (const seed of [1001, 1001, 2002]) {
    page = await browser.newPage();
    await bootGame(page, server.url, { seed });
    const s = await waitFor(page, (st) => st.inOverworld, { what: 'overworld' });
    const team = readParty(s.mem);
    (teams[seed] ??= []).push(teamKey(team.party));
    if (teams[seed].length === 1) {
      checkTeam(`seed ${seed}`, team);
      console.log(team.party.map((m) => '      ' + formatMon(m)).join('\n'));
    }
    await page.close();
  }
  check(teams[1001][0] === teams[1001][1], 'same seed gives the same team');
  check(teams[1001][0] !== teams[2002][0], 'different seeds give different teams');

  // 2. Boot, look around, open the menus.
  page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await bootGame(page, server.url, { seed: 424242 });
  let s = await waitFor(page, (st) => st.inOverworld, { what: 'overworld' });
  check(s.x === START[0] && s.y === START[1], `player starts at ${START} (got ${s.x},${s.y})`);
  check(redFacing(s.mem) === value('DIR_NORTH'), 'RED faces away from the player, out over the drop');
  check(optionsBattleStyle(s.mem) === STYLE_SET, 'battle style starts as SET');
  const saveBlock1 = s.mem.read(symbol('gSaveBlock1Ptr'), 4).readUInt32LE(0);
  const keyItems = layout('SaveBlock1').bag_keyItems;
  const keyItemIds = Array.from({ length: keyItems.count }, (_, i) => memField(s.mem, saveBlock1 + keyItems.off + i * keyItems.elemSize, 'ItemSlot', 'itemId'));
  check(keyItemIds.includes(id('ITEM', 'MEGA_RING')) && keyItemIds.includes(id('ITEM', 'Z_POWER_RING')), 'the player starts with a Mega Ring and a Z-Power Ring');
  await sleep(1500);
  await screenshot(page, `${OUT}/01-start.png`);
  await press(page, 'start'); await sleep(800);
  await screenshot(page, `${OUT}/02-start-menu.png`);
  await press(page, 'a'); await sleep(2500);
  await screenshot(page, `${OUT}/03-party.png`);
  await press(page, 'a'); await sleep(800);
  await screenshot(page, `${OUT}/04-party-actions.png`);
  await press(page, 'a'); await sleep(2500);
  await screenshot(page, `${OUT}/05-summary.png`);
  await press(page, 'right'); await sleep(800);
  await screenshot(page, `${OUT}/06-summary-stats.png`);
  await press(page, 'right'); await sleep(800);
  await screenshot(page, `${OUT}/07-summary-moves.png`);
  for (const b of ['b', 'b', 'b', 'b']) { await press(page, b); await sleep(1200); }
  s = await waitFor(page, (st) => st.inOverworld, { what: 'back in the overworld' });
  const team1 = readParty(s.mem);

  // Options: Battle Style is locked on SET.
  await press(page, 'start'); await sleep(800);
  await press(page, 'down'); await sleep(300);
  await press(page, 'a'); await sleep(2500);
  await press(page, 'down'); await sleep(300);
  await press(page, 'down'); await sleep(300);
  await press(page, 'right'); await sleep(300);
  await press(page, 'left'); await sleep(300);
  await press(page, 'left'); await sleep(500);
  await screenshot(page, `${OUT}/08-options.png`);
  await press(page, 'b'); await sleep(2500);
  await press(page, 'b'); await sleep(1000);
  s = await waitFor(page, (st) => st.inOverworld, { what: 'back from the options' });
  check(optionsBattleStyle(s.mem) === STYLE_SET, "the Options menu can't switch battle style away from SET");

  // 3. Climb to RED -> trainer battle on the peak. Force a win.
  s = await talkToRed(page, `${OUT}/08b-red.png`);
  check(s.inBattle, 'talking to RED starts a battle');
  check(s.mem.read(symbol('gBattleEnvironment'), 1)[0] === value('BATTLE_ENVIRONMENT_MOUNTAIN'), 'battle uses the mountain background');
  check(memField(s.mem, symbol('gBattleScripting'), 'BattleScripting', 'battleStyle') === STYLE_SET, 'the battle runs in SET style');
  check(memField(s.mem, symbol('gTrainerBattleParameter'), 'TrainerBattleParameter', 'params_opponentA') === value('TRAINER_DAILYRED_RED'), 'opponent is TRAINER_DAILYRED_RED');
  check(memField(s.mem, symbol('gMPlayInfo_BGM'), 'MusicPlayerInfo', 'songHeader') === symbol('mus_dailyred_vs_red'), "RED's battle plays the vs Red theme");
  const red = readParty(s.mem, 'Enemy');
  console.log(red.party.map((m) => '      ' + formatMon(m)).join('\n'));
  check(red.party.map((m) => m?.constName).join(',') === 'PIKACHU,ESPEON,SNORLAX,VENUSAUR,CHARIZARD,BLASTOISE', "RED's team is Pikachu, Espeon, Snorlax, Venusaur, Charizard, Blastoise");
  check(red.party.every((m) => m.level === 100 && m.ivs.every((iv) => iv === 31) && m.heldItem !== 0), "RED's Pokemon are level 100 with perfect IVs and held items");
  check(red.party.every((m) => m.evs.reduce((a, b) => a + b, 0) >= 508), "RED's Pokemon have their EV spreads");
  await waitForActionMenu(page);
  check((await getStatus(page)).mem.read(symbol('gBattleWeather'), 2).readUInt16LE(0) === 0, "the summit's snow doesn't start any battle weather");
  await screenshot(page, `${OUT}/09-battle.png`);

  // KO RED's lead while the rest of his team is healthy. In SHIFT style the
  // game would now ask "Will LEAF change POKeMON?" and A would open the party
  // menu (leaving the battle screen); in SET style RED just sends the next one.
  await patchMemory(page, [
    ...unkillableWrites(),                                 // ours: can't be KO'd, Seismic Toss for 100
    { addr: battleMonField(1, 'hp'), bytes: u16(1) },      // RED's active mon: 1 HP
  ]);
  let stayedInBattle = true, nextMonOut = false;
  for (let i = 0; i < 60 && !nextMonOut; i++) {
    await press(page, 'a'); await sleep(250);
    const st = await getStatus(page);
    if (!st.inBattle) { stayedInBattle = false; break; }
    nextMonOut = readBattleMon(st.mem, 1, 'species') !== SPECIES_PIKACHU;
  }
  check(nextMonOut && stayedInBattle, 'after RED\'s Pokemon faints he sends the next one with no switch prompt');
  await screenshot(page, `${OUT}/10-next-mon.png`);

  // Now finish: only RED's active Pokemon is left, at 1 HP.
  s = await getStatus(page);
  const activeSlot = activePartySlot(s.mem, 1); // battler 1 = RED
  await patchMemory(page, [
    ...[0, 1, 2, 3, 4, 5].filter((i) => i !== activeSlot).flatMap((i) => faintWrites('Enemy', i, s.mem)),
    { addr: battleMonField(1, 'hp'), bytes: u16(1) },
  ]);
  s = await finishBattle(page, 0);
  check(readVar(s.mem, VAR_WINS) === 1 && readVar(s.mem, VAR_BATTLES) === 1, 'win is recorded (1 win / 1 battle)');
  const team2 = readParty(s.mem);
  checkTeam('team after a win', team2);
  check(teamKey(team2.party) !== teamKey(team1.party), 'a new team is generated after the win');
  check(redFacing(s.mem) === value('DIR_NORTH'), 'RED faces the drop again for the next run');
  await screenshot(page, `${OUT}/11-after-win.png`);

  // 4. Battle again, with the whole team at max friendship (and battle
  //    animations off to keep it quick), then force a loss.
  s = await getStatus(page);
  const saveBlock2 = s.mem.read(symbol('gSaveBlock2Ptr'), 4).readUInt32LE(0);
  await patchMemory(page, [
    ...[0, 1, 2, 3, 4, 5].flatMap((i) => friendshipWrites(s.mem, 'Player', i, value('MAX_FRIENDSHIP'))),
    bitsWrite(s.mem, saveBlock2, layout('SaveBlock2').optionsBattleSceneOff, 1),
  ]);
  s = await getStatus(page);
  const maxFriends = readParty(s.mem);
  check(maxFriends.party.every((m) => m.friendship === value('MAX_FRIENDSHIP')) && validateTeam(maxFriends).length === 0, 'the team is at max friendship (and its data still checks out)');
  s = await talkToRed(page);
  check(s.inBattle, 'RED can be battled again');
  await waitForActionMenu(page);
  s = await getStatus(page);
  check(readBattleMon(s.mem, 0, 'affectionHearts') === value('AFFECTION_FIVE_HEARTS'), 'in battle, our Pokemon has full affection (five hearts)');

  // With affection on, a five-heart Pokemon hangs on to a knockout blow 20%
  // of the time. Here it never should. Each try: ours at 1 HP with nothing
  // else that could save it (no item or ability, Normal type) uses Splash,
  // RED's Pokemon only has Tackle, and the RNG starts somewhere new.
  await saveSnapshot(page);
  const TRIES = 20, splash = id('MOVE', 'SPLASH'), tackle = id('MOVE', 'TACKLE'), normal = id('TYPE', 'NORMAL');
  let fainted = 0, survived = 0, noTurn = 0;
  for (let t = 0; t < TRIES; t++) {
    await loadSnapshot(page, [
      { addr: battleMonField(0, 'hp'), bytes: u16(1) },
      { addr: battleMonField(0, 'item'), bytes: u16(0) },
      { addr: battleMonField(0, 'ability'), bytes: u16(0) },
      { addr: battleMonField(0, 'types'), bytes: [normal, normal] },
      { addr: battleMonField(0, 'moves'), bytes: [0, 1, 2, 3].flatMap(() => u16(splash)) },
      { addr: battleMonField(0, 'pp'), bytes: [20, 20, 20, 20] },
      { addr: battleMonField(1, 'moves'), bytes: [0, 1, 2, 3].flatMap(() => u16(tackle)) },
      { addr: battleMonField(1, 'pp'), bytes: [35, 35, 35, 35] },
      { addr: symbol('gRngValue'), bytes: [0, 1, 2, 3].flatMap(() => u32((Math.random() * 2 ** 32) >>> 0)) },
    ]);
    // FIGHT, then Splash (A in the turn menu, then in the move list), until
    // RED has used Tackle (its PP drops); then look once the hit has landed.
    let attacked = false;
    for (let i = 0; i < 40 && !attacked; i++) {
      const st = await getStatus(page);
      attacked = readBattleMon(st.mem, 1, 'pp')[0] < 35;
      if (!attacked && battleInput(st.mem) !== 'busy') await press(page, 'a');
      await sleep(300);
    }
    await sleep(2500);
    const hp = readBattleMon((await getStatus(page)).mem, 0, 'hp');
    if (!attacked) noTurn++;
    else if (hp === 0) fainted++;
    else survived++;
  }
  check(fainted === TRIES, `at max friendship our Pokemon never hangs on: of ${TRIES} knockout blows it survived ${survived}`
    + `${noTurn ? ` (${noTurn} tries never got to RED's attack)` : ''} (with affection on, about 4 would)`);
  await screenshot(page, `${OUT}/11b-max-friendship.png`);
  await loadSnapshot(page);

  s = await getStatus(page);
  await patchMemory(page, [
    ...[0, 1, 2, 3, 4, 5].filter((i) => i !== activePartySlot(s.mem, 0)).flatMap((i) => faintWrites('Player', i, s.mem)),
    { addr: battleMonField(0, 'hp'), bytes: u16(1) },
  ]);
  s = await finishBattle(page, 1);
  check(readVar(s.mem, VAR_WINS) === 1 && readVar(s.mem, VAR_BATTLES) === 2, 'loss is recorded (1 win / 2 battles), no white-out');
  const team3 = readParty(s.mem);
  checkTeam('team after a loss', team3);
  check(teamKey(team3.party) !== teamKey(team2.party), 'a new team is generated after the loss');
  await screenshot(page, `${OUT}/12-after-loss.png`);

  // 5. The website's daily game: the record carries over from the website,
  //    the game ends after one battle and stays put until the site closes it.
  await page.close();
  page = await browser.newPage();
  await bootGame(page, server.url, { seed: 31337, daily: true, wins: 4, battles: 9 });
  s = await waitFor(page, (st) => st.inOverworld, { what: 'overworld (daily game)' });
  check(readVar(s.mem, VAR_WINS) === 4 && readVar(s.mem, VAR_BATTLES) === 9, "the daily game starts from the website's record (4 wins / 9 battles)");
  await sleep(1000);
  await startRedBattle(page);
  check(readGameStatus((await getStatus(page)).mem)?.phase === 1, 'the game reports that the battle has started');
  const resetKeys = ['a', 'b', 'start', 'select'];
  await page.evaluate((keys) => keys.forEach((k) => window.emu.pressDown(k)), resetKeys);
  await sleep(500);
  await page.evaluate((keys) => keys.forEach((k) => window.emu.pressUp(k)), resetKeys);
  await sleep(3000);
  check((await getStatus(page)).inBattle, 'soft reset (A+B+Start+Select) is off during the daily battle');
  await press(page, 'b'); await sleep(500); // close anything the key combo opened
  await forceWin(page);
  let shot = 0, over = null;
  for (let i = 0; i < 120 && !over; i++) {
    await press(page, 'a'); await sleep(300);
    const st = await getStatus(page);
    if (!st.inBattle) await screenshot(page, `${OUT}/14-daily-end-${String(shot++).padStart(2, '0')}.png`);
    const status = readGameStatus(st.mem);
    if (status?.phase === 3) over = { st, status };
  }
  check(over && over.status.result === 1, 'the game reports the win, then that the daily game is over');
  check(over && readVar(over.st.mem, VAR_WINS) === 5 && readVar(over.st.mem, VAR_BATTLES) === 10, 'the record message counts this battle (5 wins / 10 battles)');
  for (let i = 0; i < 10; i++) { await press(page, 'a'); await sleep(300); }
  s = await getStatus(page);
  const after = readGameStatus(s.mem);
  check(!s.inBattle && after?.phase === 3 && readVar(s.mem, VAR_BATTLES) === 10, 'after the daily game is over, pressing A does nothing (no second battle)');
  await screenshot(page, `${OUT}/15-daily-over.png`);

  // 6. Without a seed (e.g. a desktop emulator) the title screen appears and
  //    pressing Start goes straight into the summit with a team.
  await page.close();
  page = await browser.newPage();
  await bootGame(page, server.url);
  await sleep(4000);
  check(!(await getStatus(page)).inOverworld, 'without a seed the game shows the intro/title first');
  for (let i = 0; i < 40 && !(await getStatus(page)).inOverworld; i++) {
    await press(page, 'start');
    await sleep(600);
  }
  s = await waitFor(page, (st) => st.inOverworld, { what: 'overworld after the title screen' });
  await sleep(1000);
  await screenshot(page, `${OUT}/13-no-seed-start.png`);
  checkTeam('team without a seed', readParty(s.mem));
} catch (err) {
  failures++;
  console.log('FAIL ', err.message);
  if (page) await page.screenshot({ path: `${OUT}/error.png` }).catch(() => {});
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
