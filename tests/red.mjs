// RED's team: reading it from RAM (gDailyRedRedParty, which the game builds
// at the start of each run), predicting each seed's top-level rolls, and
// checking his rules (written out here independently of dailyred_red.c; only
// the odds, levels and pool are read from it, so tuning them keeps the tests
// in step).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GAME_DIR, symbol, layout, value, field, rom, romOffset, id, constName, species, move, item } from './game.mjs';
import { decodeMon } from './party.mjs';
import { setOf, setLists, listFor, matchesList, checkStats, perfectStats, isZCrystal, isMegaStone, baseSpecies, typesOf, checkTeamLimits } from './sets.mjs';

export { setLists, perfectStats };

const redSource = readFileSync(join(GAME_DIR, 'src/dailyred_red.c'), 'utf8');
const define = (name) => Number(redSource.match(new RegExp(`#define ${name}\\s+(\\d+)`))[1]);
const RED_RNG_SALT = Number(readFileSync(join(GAME_DIR, 'src/dailyred.c'), 'utf8').match(/#define RED_RNG_SALT (0x[0-9A-Fa-f]+)/)[1]);

export const ODDS = {
  original: define('ORIGINAL_TEAM_ODDS'),
  megaMewtwo: define('MEGA_MEWTWO_ODDS'),
  mew: define('MEW_ODDS'),
  shinyMew: define('SHINY_MEW_ODDS'),
  deoxys: define('DEOXYS_ODDS'),
  mewtwo: define('MEWTWO_ODDS'),
  galarianBird: define('GALARIAN_BIRD_ODDS'),
  johtoDog: define('JOHTO_DOG_ODDS'),
  paradoxDog: define('PARADOX_DOG_ODDS'),
  cap: define('CAP_PIKACHU_ODDS'),
};
export const LEVELS = {
  pikachu: define('LEVEL_PIKACHU'),
  starter: define('LEVEL_STARTER'),
  legendary: define('LEVEL_LEGENDARY'),
  mewtwo: define('LEVEL_MEWTWO'),
  pick: define('LEVEL_PICK'),
  original: define('LEVEL_ORIGINAL_TEAM'),
};
const S = (name) => id('SPECIES', name);
const I = (name) => id('ITEM', name);
const M = (name) => id('MOVE', name);
export const POOL = [...redSource.match(/sRedPool\[\] =\s*\{([^}]*)\}/)[1].matchAll(/SPECIES_(\w+)/g)].map((m) => S(m[1]));

// The starters, with what they pair with (as the spec states it).
const STARTERS = [
  { name: 'VENUSAUR', stones: ['VENUSAURITE'], bird: 'MOLTRES', galarianBird: 'MOLTRES_GALAR', dog: 'ENTEI', paradoxDog: 'GOUGING_FIRE', z: 'GRASSIUM_Z' },
  { name: 'CHARIZARD', stones: ['CHARIZARDITE_X', 'CHARIZARDITE_Y'], bird: 'ARTICUNO', galarianBird: 'ARTICUNO_GALAR', dog: 'SUICUNE', paradoxDog: 'WALKING_WAKE', z: 'FIRIUM_Z' },
  { name: 'BLASTOISE', stones: ['BLASTOISINITE'], bird: 'ZAPDOS', galarianBird: 'ZAPDOS_GALAR', dog: 'RAIKOU', paradoxDog: 'RAGING_BOLT', z: 'WATERIUM_Z' },
];
const MEGA_FORMES = new Map([
  ['VENUSAURITE', 'VENUSAUR_MEGA'], ['CHARIZARDITE_X', 'CHARIZARD_MEGA_X'], ['CHARIZARDITE_Y', 'CHARIZARD_MEGA_Y'],
  ['BLASTOISINITE', 'BLASTOISE_MEGA'], ['MEWTWONITE_X', 'MEWTWO_MEGA_X'], ['MEWTWONITE_Y', 'MEWTWO_MEGA_Y'],
].map(([stone, forme]) => [I(stone), S(forme)]));
const DEOXYS = ['DEOXYS_NORMAL', 'DEOXYS_ATTACK', 'DEOXYS_DEFENSE', 'DEOXYS_SPEED'].map(S);
const EEVEELUTIONS = ['VAPOREON', 'JOLTEON', 'FLAREON', 'ESPEON', 'UMBREON', 'LEAFEON', 'GLACEON', 'SYLVEON'].map(S);
const FEMALE = [...EEVEELUTIONS, S('LAPRAS'), S('GYARADOS')];
const HAZARDS = ['STEALTH_ROCK', 'SPIKES', 'TOXIC_SPIKES', 'STICKY_WEB', 'STONE_AXE', 'CEASELESS_EDGE'].map(M);
const CAPS = ['ORIGINAL', 'HOENN', 'SINNOH', 'UNOVA', 'KALOS', 'ALOLA', 'PARTNER', 'WORLD'].map((c) => S(`PIKACHU_${c}`));

// --- Predicting a seed's rolls -----------------------------------------------------
// The first four draws of RED's RNG (ISO_RANDOMIZE1, upper 16 bits) after
// boot: original team, starter, legendary roll, capped Pikachu.

export function legendaryKind(roll) {
  const order = [['megaMewtwo', ODDS.megaMewtwo], ['mew', ODDS.mew], ['deoxys', ODDS.deoxys], ['mewtwo', ODDS.mewtwo],
    ['galarianBird', ODDS.galarianBird], ['johtoDog', ODDS.johtoDog], ['paradoxDog', ODDS.paradoxDog]];
  for (const [kind, odds] of order) {
    if (roll < odds) return kind === 'mew' && roll < ODDS.shinyMew ? 'shinyMew' : kind;
    roll -= odds;
  }
  return 'bird';
}

export function predictRolls(seed) {
  let state = (seed ^ RED_RNG_SALT) >>> 0;
  const next = () => {
    state = (Math.imul(1103515245, state) + 24691) >>> 0;
    return state >>> 16;
  };
  const original = next() % 100 < ODDS.original;
  const starter = next() % 3;
  const legendary = legendaryKind(next() % 100);
  const cap = next() % 100 < ODDS.cap && !original;
  return { original, starter: STARTERS[starter].name, legendary, cap };
}

// --- Reading -----------------------------------------------------------------------

export function readRedParty(memory) {
  const size = layout('Pokemon').size;
  const base = symbol('gDailyRedRedParty');
  return Array.from({ length: value('PARTY_SIZE') }, (_, i) => decodeMon(memory.read(base + i * size, size)));
}

export function genderOf(mon) {
  const ratio = species(mon.species).genderRatio;
  if (ratio === value('MON_GENDERLESS')) return 'genderless';
  if (ratio === value('MON_FEMALE')) return 'female';
  if (ratio === value('MON_MALE')) return 'male';
  return (mon.personality & 0xFF) < ratio ? 'female' : 'male';
}

const base = baseSpecies;

// Checks RED's six against his rules; `rolls` is predictRolls(seed) for the
// first team after boot (later teams: pass null to skip the roll checks).
// Returns { kind, problems }.
export function validateRed(party, rolls = null) {
  const problems = [];
  const mons = party.filter(Boolean);
  if (mons.length !== 6) problems.push(`RED has ${mons.length} Pokemon`);
  if (new Set(mons.map((m) => base(m.species))).size !== mons.length) problems.push('the same species twice');

  for (const m of mons) {
    const tag = m.speciesName;
    checkStats(m, problems);
    const gender = genderOf(m);
    const ratio = species(m.species).genderRatio;
    const fixed = [value('MON_MALE'), value('MON_FEMALE'), value('MON_GENDERLESS')].includes(ratio);
    const want = fixed ? gender : FEMALE.includes(base(m.species)) ? 'female' : 'male';
    if (gender !== want) problems.push(`${tag}: ${gender}, expected ${want}`);
  }
  const zCount = mons.filter((m) => isZCrystal(m.heldItem)).length;
  if (zCount > 1) problems.push(`${zCount} Z-Crystals`);
  const teraCount = mons.filter((m) => m.teraType !== value('TYPE_MYSTERY')).length;

  const starters = mons.filter((m) => STARTERS.some((s) => S(s.name) === m.species));
  const pikachu = mons.find((m) => base(m.species) === S('PIKACHU'));
  const original = starters.length === 3;
  // Pikachu: capped on CAP_PIKACHU_ODDS% of his usual days; built physical
  // or special from fixed moves; a Light Ball, or on his usual days
  // sometimes a Z-Crystal (Pikanium Z: physical; Pikashunium Z: capped
  // special), and then it leads with the totem aura.
  const capped = Boolean(pikachu && CAPS.includes(pikachu.species));
  const pikachuZ = Boolean(pikachu && isZCrystal(pikachu.heldItem));
  if (rolls && pikachu && rolls.cap !== capped) problems.push(`capped Pikachu ${capped}, the seed's roll says ${rolls.cap}`);
  if (!pikachu) problems.push('no Pikachu');
  else {
    const has = (...names) => names.every((n) => pikachu.moves.includes(M(n)));
    if (original && (capped || pikachuZ)) problems.push('a capped or Z-Crystal Pikachu on an original-team day');
    if (pikachu.species !== S('PIKACHU') && !capped) problems.push(`Pikachu is ${pikachu.speciesName}`);
    const physical = pikachu.moves.includes(M('VOLT_TACKLE'));
    const shape = capped
      ? (physical ? has('VOLT_TACKLE', 'IRON_TAIL', 'QUICK_ATTACK') : has('THUNDERBOLT', 'SURF', 'VOLT_SWITCH'))
      : (physical ? has('VOLT_TACKLE', 'EXTREME_SPEED') : (has('VOLT_SWITCH') && (has('THUNDERBOLT') || has('ELECTRO_BALL'))));
    if (!shape) problems.push(`Pikachu's moves (${pikachu.moveNames.join(', ')}) aren't a ${capped ? 'capped ' : ''}${physical ? 'physical' : 'special'} build`);
    if (new Set(pikachu.moves).size !== 4) problems.push('Pikachu has a move twice');
    const items = ['LIGHT_BALL', ...(original ? [] : physical ? ['PIKANIUM_Z'] : capped ? ['PIKASHUNIUM_Z'] : [])].map(I);
    if (!items.includes(pikachu.heldItem)) problems.push(`Pikachu holds ${item(pikachu.heldItem).name}`);
    if (pikachu.shiny) problems.push('Pikachu is shiny');
  }

  if (rolls && rolls.original !== original) problems.push(`original team ${original}, the seed's roll says ${rolls.original}`);
  let leaders;
  let kind;

  if (original) {
    kind = 'original team';
    const second = mons.find((m) => m.species === S('ESPEON') || m.species === S('LAPRAS'));
    const snorlax = mons.find((m) => m.species === S('SNORLAX'));
    if (!second || !snorlax) problems.push(`original team isn't Pikachu, Espeon/Lapras, Snorlax and the three starters (${mons.map((m) => m.speciesName).join(', ')})`);
    for (const m of mons) if (m.level !== LEVELS.original) problems.push(`${m.speciesName}: level ${m.level}, expected ${LEVELS.original}`);
    const gimmicks = starters.map((m) => {
      if (isMegaStone(m.heldItem)) return 'MEGA';
      if (isZCrystal(m.heldItem)) return 'ZMOVE';
      if (m.teraType !== value('TYPE_MYSTERY')) return 'TERA';
      return 'none';
    });
    if (gimmicks.slice().sort().join() !== 'MEGA,TERA,ZMOVE') problems.push(`the starters' gimmicks are ${gimmicks.join(', ')}, expected one each of Mega, Z-Move and Tera`);
    starters.forEach((m, i) => {
      const listSpecies = gimmicks[i] === 'MEGA' ? MEGA_FORMES.get(m.heldItem) : m.species;
      matchesList(m, listFor(listSpecies, gimmicks[i]), problems, m.speciesName);
    });
    if (teraCount !== 1) problems.push(`${teraCount} Pokemon can Terastallize`);
    for (const m of [second, snorlax].filter(Boolean)) {
      matchesList(m, listFor(m.species, 'NORMAL'), problems, m.speciesName);
      if (isMegaStone(m.heldItem) || isZCrystal(m.heldItem)) problems.push(`${m.speciesName} holds ${item(m.heldItem).name}`);
    }
    leaders = [pikachu].filter(Boolean); // HGSS days: Pikachu always leads
  } else {
    if (starters.length !== 1) problems.push(`${starters.length} Kanto starters`);
    const starter = starters[0];
    const info = starter && STARTERS.find((s) => S(s.name) === starter.species);
    if (rolls && starter && rolls.starter !== info.name) problems.push(`starter ${info.name}, the seed's roll says ${rolls.starter}`);
    if (teraCount) problems.push(`${teraCount} Pokemon can Terastallize`);
    if (pikachu && pikachu.level !== LEVELS.pikachu) problems.push(`Pikachu: level ${pikachu.level}`);

    // The legendary.
    // The paradox dogs aren't legendary in the game data, but are his legendary.
    const PARADOX_DOGS = STARTERS.map((st) => S(st.paradoxDog));
    const legendaries = mons.filter((m) => species(m.species).legendary || PARADOX_DOGS.includes(m.species));
    if (legendaries.length !== 1) problems.push(`${legendaries.length} legendaries`);
    const legend = legendaries[0];
    if (info && legend) {
      const sp = legend.species;
      if (sp === S(info.bird)) kind = 'bird';
      else if (sp === S(info.galarianBird)) kind = 'galarianBird';
      else if (sp === S(info.dog)) kind = 'johtoDog';
      else if (sp === S(info.paradoxDog)) kind = 'paradoxDog';
      else if (sp === S('MEWTWO')) kind = MEGA_FORMES.has(legend.heldItem) ? 'megaMewtwo' : 'mewtwo';
      else if (DEOXYS.includes(sp)) kind = 'deoxys';
      else if (sp === S('MEW')) kind = legend.shiny ? 'shinyMew' : 'mew';
      else problems.push(`${legend.speciesName} isn't one of ${info.name}'s legendaries`);
      if (rolls && kind && rolls.legendary !== kind) problems.push(`legendary ${kind}, the seed's roll says ${rolls.legendary}`);
      if (legend.shiny !== (kind === 'shinyMew')) problems.push(`${legend.speciesName} shiny: ${legend.shiny}`);
      const wantLevel = kind === 'mewtwo' || kind === 'megaMewtwo' ? LEVELS.mewtwo : LEVELS.legendary;
      if (legend.level !== wantLevel) problems.push(`${legend.speciesName}: level ${legend.level}, expected ${wantLevel}`);
      if (kind === 'megaMewtwo') {
        matchesList(legend, listFor(MEGA_FORMES.get(legend.heldItem), 'MEGA'), problems, 'Mega Mewtwo');
      } else if (kind === 'galarianBird' || kind === 'paradoxDog' || pikachuZ) {
        // The Galarian birds' sets are Gen 8 and the paradox dogs' Gen 9 (no
        // Z-Moves); a capped Pikachu has his Z-Move.
        matchesList(legend, listFor(sp, 'NORMAL'), problems, legend.speciesName);
        if (isMegaStone(legend.heldItem) || isZCrystal(legend.heldItem)) problems.push(`${legend.speciesName} holds ${item(legend.heldItem).name}`);
      } else if (kind) {
        // Its Z-Move sets, or its regular ones when those are all stall sets.
        if (!setOf(legend, listFor(sp, 'ZMOVE'))) matchesList(legend, listFor(sp, 'NORMAL'), problems, legend.speciesName);
        if (isMegaStone(legend.heldItem)) problems.push(`${legend.speciesName} holds a Mega Stone`);
      }
    }

    // The starter: its Mega Stone, or a regular set when Mewtwo Mega Evolves.
    if (starter) {
      if (starter.level !== LEVELS.starter) problems.push(`${starter.speciesName}: level ${starter.level}, expected ${LEVELS.starter}`);
      if (kind === 'megaMewtwo' && pikachuZ) {
        if (isZCrystal(starter.heldItem) || isMegaStone(starter.heldItem)) problems.push(`${starter.speciesName} holds ${item(starter.heldItem).name} on a Mega Mewtwo, Z-Pikachu day`);
        matchesList(starter, listFor(starter.species, 'NORMAL'), problems, starter.speciesName);
      } else if (kind === 'megaMewtwo') {
        if (!setOf(starter, listFor(starter.species, 'ZMOVE'))) matchesList(starter, listFor(starter.species, 'NORMAL'), problems, starter.speciesName);
      } else {
        if (!info.stones.map(I).includes(starter.heldItem)) problems.push(`${starter.speciesName} doesn't hold its Mega Stone`);
        else matchesList(starter, listFor(MEGA_FORMES.get(starter.heldItem), 'MEGA'), problems, starter.speciesName);
      }
    }

    // The three picks.
    const picks = mons.filter((m) => m !== starter && m !== pikachu && m !== legend);
    if (picks.length !== 3) problems.push(`${picks.length} picks`);
    const fromPool = picks.filter((m) => POOL.includes(m.species));
    if (fromPool.length < 2) problems.push(`only ${fromPool.length} picks from RED's pool`);
    const anyPick = picks.find((m) => !POOL.includes(m.species)) ?? picks[2];
    for (const m of picks) {
      const tag = m.speciesName;
      if (m.level !== LEVELS.pick) problems.push(`${tag}: level ${m.level}, expected ${LEVELS.pick}`);
      if (isMegaStone(m.heldItem) || isZCrystal(m.heldItem)) problems.push(`${tag} holds ${item(m.heldItem).name}`);
      matchesList(m, listFor(m.species, 'NORMAL'), problems, tag);
    }
    if (anyPick) {
      const info2 = species(anyPick.species);
      const tag = anyPick.speciesName;
      if (info2.legendary || info2.ultraBeast || info2.paradox) problems.push(`${tag}: legendary, Ultra Beast or Paradox`);
      if (info2.evolutions.length) problems.push(`${tag}: not fully evolved`);
      if (!isGen1Family(anyPick.species)) problems.push(`${tag}: not from a Gen 1 family`);
      if ([S('RAICHU'), S('PIKACHU')].includes(base(anyPick.species))) problems.push(`${tag}: Pikachu's family`);
    }
    for (let i = 0; i < picks.length; i++) {
      for (let j = i + 1; j < picks.length; j++) {
        const shared = [...typesOf(picks[i])].filter((t) => typesOf(picks[j]).has(t));
        if (shared.length) problems.push(`${picks[i].speciesName} and ${picks[j].speciesName} share ${shared.join('/')}`);
      }
    }
    if (picks.filter((m) => EEVEELUTIONS.includes(m.species)).length > 1) problems.push('more than one Eeveelution');
    leaders = (pikachuZ ? [pikachu] : [pikachu, ...picks]).filter(Boolean); // a Z-Crystal Pikachu always leads
    // Hyper offense: one stall set at most.
    const stall = [legend, starter, ...picks].filter((m) => {
      if (!m) return false;
      for (const kindName of ['NORMAL', 'ZMOVE', 'MEGA']) {
        const st = setOf(m, listFor(kindName === 'MEGA' ? MEGA_FORMES.get(m.heldItem) : m.species, kindName));
        if (st) return st.stall;
      }
      return false;
    });
    if (stall.length > 1) problems.push(`${stall.length} stall sets (${stall.map((m) => m.speciesName).join(', ')})`);
  }

  // One item held twice at most, one type shared at most.
  checkTeamLimits(mons, problems);

  // The lead.
  const lead = party[0];
  if (lead && !leaders.includes(lead)) problems.push(`leads with ${lead.speciesName}`);
  const setters = leaders.filter((m) => m.moves.some((mv) => HAZARDS.includes(mv)));
  if (lead && setters.length && !setters.includes(lead)) problems.push(`leads with ${lead.speciesName} although ${setters.map((m) => m.speciesName).join(', ')} sets hazards`);

  return { kind, problems };
}

// A regular form (not a regional or other alternate form).
const isRegularForm = (sp) => {
  const info = species(sp);
  return !info.regional && !info.battleOnly && (info.forms.length === 0 || info.forms[0] === sp);
};
let prevos = null;
function prevoOf(sp) {
  if (!prevos) {
    prevos = new Map();
    for (let s = 1; s < value('NUM_SPECIES'); s++) {
      for (const e of species(s).evolutions) if (!prevos.has(e.target)) prevos.set(e.target, s);
    }
  }
  return prevos.get(sp);
}

// From a Gen 1 family: a regular-form Pokemon of the Gen 1 Pokedex (national
// dex 1-151), or one that evolves from one (Crobat, Scizor, Kleavor...).
export function isGen1Family(sp) {
  for (let s = sp, i = 0; s && i < 5; s = prevoOf(s), i++) {
    if (!isRegularForm(s)) return false;
    const n = species(s).natDexNum;
    if (n >= 1 && n <= 151) return true;
  }
  return false;
}

// RED's random pick (gDailyRedPickGroups in the ROM): every entry from a Gen 1
// family, fully evolved and none a starter (any generation's family),
// Pikachu's family, legendary, mythical, Ultra Beast or Paradox Pokemon.
// Returns { count, problems }.
const STARTER_ROOTS = ['BULBASAUR', 'CHARMANDER', 'SQUIRTLE', 'CHIKORITA', 'CYNDAQUIL', 'TOTODILE', 'TREECKO', 'TORCHIC',
  'MUDKIP', 'TURTWIG', 'CHIMCHAR', 'PIPLUP', 'SNIVY', 'TEPIG', 'OSHAWOTT', 'CHESPIN', 'FENNEKIN', 'FROAKIE', 'ROWLET',
  'LITTEN', 'POPPLIO', 'GROOKEY', 'SCORBUNNY', 'SOBBLE', 'SPRIGATITO', 'FUECOCO', 'QUAXLY', 'PICHU'];
export function validatePickGroups() {
  const problems = [];
  const prevo = new Map();
  for (let sp = 1; sp < value('NUM_SPECIES'); sp++) {
    for (const e of species(sp).evolutions) if (!prevo.has(e.target)) prevo.set(e.target, sp);
  }
  const root = (sp) => {
    let s = base(sp);
    for (let i = 0; i < 5 && prevo.has(s); i++) s = base(prevo.get(s));
    return s;
  };
  const roots = new Set(STARTER_ROOTS.map(S));
  const G = layout('DailyRedPickGroup');
  const groups = rom().readUInt16LE(romOffset(symbol('gDailyRedNumPickGroups')));
  const lists = setLists();
  const seen = new Set();
  for (let g = 0; g < groups; g++) {
    const at = romOffset(symbol('gDailyRedPickGroups')) + g * G.size;
    const first = field(rom(), at, 'DailyRedPickGroup', 'first'), count = field(rom(), at, 'DailyRedPickGroup', 'count');
    for (let i = 0; i < count; i++) {
      const list = lists[rom().readUInt16LE(romOffset(symbol('gDailyRedPickLists')) + (first + i) * 2)];
      const info = species(list.species);
      const tag = info.name;
      seen.add(list.species);
      if (list.kind !== 'NORMAL') problems.push(`${tag}: a ${list.kind} list`);
      if (info.legendary || info.ultraBeast || info.paradox) problems.push(`${tag}: legendary, Ultra Beast or Paradox`);
      if (info.evolutions.length) problems.push(`${tag}: not fully evolved`);
      if (info.battleOnly) problems.push(`${tag}: a battle-only forme`);
      if (!isGen1Family(list.species)) problems.push(`${tag}: not from a Gen 1 family`);
      if (roots.has(root(list.species))) problems.push(`${tag}: a starter or Pikachu's family`);
    }
  }
  return { count: groups, formes: seen.size, problems };
}

export function formatRedMon(mon) {
  if (!mon) return '(empty)';
  const tera = mon.teraType !== value('TYPE_MYSTERY') ? ` Tera ${constName('TYPE', mon.teraType)}` : '';
  return `${mon.speciesName.padEnd(12)} Lv${mon.level} ${genderOf(mon).padEnd(10)} ${mon.nature.padEnd(7)}`
    + ` EV ${mon.evs.join('/')}${mon.shiny ? ' SHINY' : ''}${tera} @ ${mon.heldItem ? item(mon.heldItem).name : 'no item'}`
    + `\n               ${mon.moveNames.join(', ')}`;
}

export { move };
