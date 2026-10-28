// Decodes party Pokemon (struct Pokemon) from raw RAM and checks teams
// against the rules. Layouts, names and game data (base stats, learnsets,
// moves, items) come from the build itself (game.mjs).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GAME_DIR, symbol, layout, value, field, readBits, id, constName, species, move, item,
} from './game.mjs';
import { listFor, matchesList, checkStats, isZCrystal, isMegaStone, canMegaEvolve, baseSpecies, typesOf, megaFormeFor, checkTeamLimits } from './sets.mjs';

const NATURES = ['Hardy', 'Lonely', 'Brave', 'Adamant', 'Naughty', 'Bold', 'Docile', 'Relaxed', 'Impish', 'Lax',
  'Timid', 'Hasty', 'Serious', 'Jolly', 'Naive', 'Modest', 'Mild', 'Quiet', 'Bashful', 'Rash', 'Calm', 'Gentle',
  'Sassy', 'Careful', 'Quirky'];

// Where each of the four 12-byte substructures (0 = species/item, 1 = moves,
// 2 = EVs, 3 = IVs/misc) sits, by personality % 24. Gen 3's order, unchanged
// in the expansion (sSubstructOffsets in pokemon.c).
const ORDERS = ['0123', '0132', '0213', '0231', '0312', '0321', '1023', '1032', '1203', '1230', '1302', '1320',
  '2013', '2031', '2103', '2130', '2301', '2310', '3012', '3021', '3102', '3120', '3201', '3210'];

const STAT_FIELDS = ['hp', 'attack', 'defense', 'speed', 'spAttack', 'spDefense'];
export const STAT_NAMES = ['HP', 'Atk', 'Def', 'Spe', 'SpA', 'SpD'];

export function decodeMon(bytes) {
  const buf = Buffer.from(bytes);
  const B = layout('BoxPokemon');
  const personality = buf.readUInt32LE(B.personality.off);
  const otId = buf.readUInt32LE(B.otId.off);
  const key = (personality ^ otId) >>> 0;
  const secure = Buffer.alloc(B.secure.size);
  for (let i = 0; i < secure.length; i += 4) secure.writeUInt32LE((buf.readUInt32LE(B.secure.off + i) ^ key) >>> 0, i);
  const subSize = secure.length / 4;
  const order = ORDERS[personality % 24];
  const sub = (type) => secure.subarray(order.indexOf(String(type)) * subSize, order.indexOf(String(type)) * subSize + subSize);
  const s0 = sub(0), s1 = sub(1), s2 = sub(2), s3 = sub(3);
  const bits = (buffer, struct, name) => readBits(buffer, 0, layout(struct)[name]);

  const speciesId = bits(s0, 'PokemonSubstruct0', 'species');
  if (speciesId === 0) return null;
  const moves = [1, 2, 3, 4].map((i) => bits(s1, 'PokemonSubstruct1', `move${i}`));
  const nature = (personality % 25) ^ field(buf, 0, 'BoxPokemon', 'hiddenNatureModifier');
  const shinyValue = ((otId >>> 16) ^ (otId & 0xFFFF) ^ (personality >>> 16) ^ (personality & 0xFFFF)) >>> 0;
  return {
    personality,
    species: speciesId,
    speciesName: species(speciesId).name,
    constName: species(speciesId).constName,
    heldItem: bits(s0, 'PokemonSubstruct0', 'heldItem'),
    teraType: bits(s0, 'PokemonSubstruct0', 'teraType'),
    friendship: field(s0, 0, 'PokemonSubstruct0', 'friendship'),
    moves,
    moveNames: moves.filter(Boolean).map((m) => move(m).name),
    pp: [1, 2, 3, 4].map((i) => bits(s1, 'PokemonSubstruct1', `pp${i}`)),
    hyperTrained: ['HP', 'Attack', 'Defense', 'Speed', 'SpAttack', 'SpDefense'].map((s) => bits(s1, 'PokemonSubstruct1', `hyperTrained${s}`)),
    evs: ['hpEV', 'attackEV', 'defenseEV', 'speedEV', 'spAttackEV', 'spDefenseEV'].map((f) => field(s2, 0, 'PokemonSubstruct2', f)),
    ivs: ['hpIV', 'attackIV', 'defenseIV', 'speedIV', 'spAttackIV', 'spDefenseIV'].map((f) => bits(s3, 'PokemonSubstruct3', f)),
    abilityNum: bits(s3, 'PokemonSubstruct3', 'abilityNum'),
    ability: species(speciesId).abilities[bits(s3, 'PokemonSubstruct3', 'abilityNum')],
    metLocation: field(s3, 0, 'PokemonSubstruct3', 'metLocation'),
    fateful: bits(s3, 'PokemonSubstruct3', 'modernFatefulEncounter') === 1,
    nature: NATURES[nature] ?? `#${nature}`,
    level: field(buf, 0, 'Pokemon', 'level'),
    hp: field(buf, 0, 'Pokemon', 'hp'),
    maxHp: field(buf, 0, 'Pokemon', 'maxHP'),
    stats: [field(buf, 0, 'Pokemon', 'maxHP'), ...STAT_FIELDS.slice(1).map((f) => field(buf, 0, 'Pokemon', f))], // HP Atk Def Spe SpA SpD
    shiny: (shinyValue < value('SHINY_ODDS')) !== (field(buf, 0, 'BoxPokemon', 'shinyModifier') === 1),
  };
}

// side: 'Player' or 'Enemy' (gParties[B_TRAINER_PLAYER] / [B_TRAINER_OPPONENT_A]).
export function partyAddress(side = 'Player') {
  const trainer = value(side === 'Player' ? 'B_TRAINER_PLAYER' : 'B_TRAINER_OPPONENT_A');
  return symbol('gParties') + trainer * value('PARTY_SIZE') * layout('Pokemon').size;
}

export function readParty(memory, side = 'Player') {
  const trainer = value(side === 'Player' ? 'B_TRAINER_PLAYER' : 'B_TRAINER_OPPONENT_A');
  const base = partyAddress(side);
  const size = layout('Pokemon').size;
  const count = memory.read(symbol('gPartiesCount') + trainer, 1)[0];
  const party = [];
  for (let i = 0; i < 6; i++) party.push(decodeMon(memory.read(base + i * size, size)));
  return { count, party };
}

// Writes that set a party Pokemon's friendship: its data re-encrypted and the
// checksum fixed, the way the game stores them.
export function friendshipWrites(memory, side, slot, value) {
  const P = layout('Pokemon'), B = layout('BoxPokemon');
  const addr = partyAddress(side) + slot * P.size;
  const buf = Buffer.from(memory.read(addr, P.size));
  const personality = buf.readUInt32LE(B.personality.off), otId = buf.readUInt32LE(B.otId.off);
  const key = (personality ^ otId) >>> 0;
  const secure = Buffer.alloc(B.secure.size);
  for (let i = 0; i < secure.length; i += 4) secure.writeUInt32LE((buf.readUInt32LE(B.secure.off + i) ^ key) >>> 0, i);
  const subSize = secure.length / 4;
  secure[ORDERS[personality % 24].indexOf('0') * subSize + layout('PokemonSubstruct0').friendship.off] = value;
  let checksum = 0;
  for (let i = 0; i < secure.length; i += 2) checksum = (checksum + secure.readUInt16LE(i)) & 0xFFFF;
  const encrypted = Buffer.alloc(secure.length);
  for (let i = 0; i < secure.length; i += 4) encrypted.writeUInt32LE((secure.readUInt32LE(i) ^ key) >>> 0, i);
  return [
    { addr: addr + B.secure.off, bytes: [...encrypted] },
    { addr: addr + B.checksum.off, bytes: [checksum & 0xFF, checksum >> 8] },
  ];
}

export const itemName = (it) => (it ? item(it).name : 'no item');

export function formatMon(mon) {
  if (!mon) return '(empty)';
  return `${mon.speciesName.padEnd(12)} (${String(species(mon.species).bst).padStart(3)}) Lv${mon.level} ${mon.nature.padEnd(7)}`
    + ` EV ${mon.evs.join('/')}${mon.shiny ? ' SHINY' : ''} @ ${itemName(mon.heldItem)}`
    + `\n               ${mon.moveNames.join(', ')}`;
}

// --- Rules ------------------------------------------------------------------------
// Written out here independently of dailyred_team.c; only its tunable numbers
// and lists (odds, levels, the legendaries, the later evolutions) are read
// from it, so tuning them keeps the tests in step.

const teamSource = readFileSync(join(GAME_DIR, 'src/dailyred_team.c'), 'utf8');
const define = (name) => Number(teamSource.match(new RegExp(`#define ${name}\\s+(\\d+)`))[1]);
export const MIN_TEAM_BST = define('MIN_TEAM_BASE_STAT_TOTAL');
export const LEGENDARY_TEAM_ODDS = define('LEGENDARY_TEAM_ODDS');
export const MIRROR_RED_ODDS = define('MIRROR_RED_ODDS');
const LEVEL_STARTER = define('LEVEL_STARTER');
const LEVEL_PIKACHU = define('LEVEL_PIKACHU');
const listIn = (pattern, prefix) => [...teamSource.match(pattern)[1].matchAll(new RegExp(`\\b${prefix}_(\\w+)`, 'g'))].map((m) => m[1]);
export const PARADOX_DOG_LIST = listIn(/sParadoxDogs\[\] =\s*\{([^}]*)\}/, 'SPECIES').map((n) => id('SPECIES', n));
export const LEGENDARY_LIST = [...listIn(/sLegendaries\[\] =\s*\{([^}]*)\}/, 'SPECIES').map((n) => id('SPECIES', n)), ...PARADOX_DOG_LIST];

export const isLegendary = (mon) => species(mon.species).legendary || PARADOX_DOG_LIST.includes(mon.species);
export const teamBaseStatTotal = (party) => party.filter(Boolean).reduce((sum, m) => sum + species(m.species).bst, 0);

// Daily Red's species scope, rebuilt from the ROM's evolution tables
// (independently of sLaterEvolutions in dailyred_team.c): the 386 Pokemon of
// Generations 1-3 and everything they evolve into in later generations, in
// regular form (not regional forms, alternate forms or battle-only forms).
let laterEvolutionCache;
export function laterEvolutions() {
  if (laterEvolutionCache) return laterEvolutionCache;
  const last = id('SPECIES', 'DEOXYS');
  const isRegularForm = (sp) => {
    const info = species(sp);
    return !info.regional && !info.battleOnly && (info.forms.length === 0 || info.forms[0] === sp);
  };
  const found = new Set();
  const queue = Array.from({ length: last }, (_, i) => i + 1);
  while (queue.length) {
    for (const evo of species(queue.shift()).evolutions) {
      if (evo.target > last && !found.has(evo.target) && isRegularForm(evo.target)) {
        found.add(evo.target);
        queue.push(evo.target);
      }
    }
  }
  return (laterEvolutionCache = found);
}

// The player's species pool: the scope above, in regular form.
export const isEligibleSpecies = (sp) => (sp >= 1 && sp <= id('SPECIES', 'DEOXYS')) || laterEvolutions().has(sp);
export const LATER_EVOLUTION_LIST = listIn(/sLaterEvolutions\[\] =\s*\{([^}]*)\}/, 'SPECIES').map((n) => id('SPECIES', n));
export const isFinalStage = (sp) => species(sp).evolutions.length === 0;

// RED's starter -> the player's possible starters (as the spec states it).
const S = (name) => id('SPECIES', name);
export const COUNTERS = new Map([
  ['VENUSAUR', ['CHARIZARD', 'TYPHLOSION', 'BLAZIKEN']],
  ['CHARIZARD', ['BLASTOISE', 'FERALIGATR', 'SWAMPERT']],
  ['BLASTOISE', ['VENUSAUR', 'MEGANIUM', 'SCEPTILE']],
].map(([red, mine]) => [S(red), mine.map(S)]));

// The first draw of the player's RNG after boot (seeded with the seed itself,
// see dailyred.c): the mirror-RED roll.
export function predictPlayerRolls(seed) {
  const state = (Math.imul(1103515245, seed >>> 0) + 24691) >>> 0;
  return { mirror: (state >>> 16) % 100 < MIRROR_RED_ODDS };
}

// Checks a party read from RAM against the player's team rules, given RED's
// party for the same run (his starter decides ours) and, for the first team
// after boot, predictPlayerRolls(seed). Returns a list of problems (empty
// when the team is valid).
export function validateTeam({ count, party }, redParty, rolls = null) {
  const problems = [];
  if (count !== 6 || !party.every(Boolean)) problems.push(`party has ${count} Pokemon, expected 6`);
  const mons = party.filter(Boolean);
  if (new Set(mons.map((m) => baseSpecies(m.species))).size !== mons.length) problems.push('the same species twice');
  const total = teamBaseStatTotal(mons);
  if (total < MIN_TEAM_BST) problems.push(`team base stat total ${total} is under the minimum ${MIN_TEAM_BST}`);

  // The starter: one that counters RED's (any of the nine if he has all three).
  const redStarters = (redParty ?? []).filter((m) => m && COUNTERS.has(m.species)).map((m) => m.species);
  const allowed = redStarters.length === 1 ? COUNTERS.get(redStarters[0]) : [...COUNTERS.values()].flat();
  const starters = mons.filter((m) => allowed.includes(m.species) && m.level === LEVEL_STARTER);
  if (starters.length !== 1) problems.push(`${starters.length} starters for RED's ${redStarters.map((sp) => species(sp).name).join('/') || '?'}`);
  const starter = starters[0];
  // Another Pokemon Mega Evolving (MEGA_SWAP_ODDS% of the days one can): the
  // starter holds a Z-Crystal instead.
  // A Mega Stone, or Rayquaza on one of its Mega sets (its regular sets know
  // Dragon Ascent too, without being the day's Mega).
  const onMegaSet = (m) => { const p = []; matchesList(m, listFor(megaFormeFor(m), 'MEGA'), p, ''); return p.length === 0; };
  const isTheMega = (m) => isMegaStone(m.heldItem) || (canMegaEvolve(m) && onMegaSet(m));
  const otherMegas = mons.filter((m) => m !== starter && isTheMega(m));
  if (otherMegas.length > 1) problems.push(`${otherMegas.length} Pokemon besides the starter can Mega Evolve`);
  if (starter) {
    const tag = starter.speciesName;
    const megas = species(starter.species).formChanges.filter((f) => f.method === 'BATTLE_MEGA_EVOLUTION_ITEM');
    const crystal = starter.heldItem ? item(starter.heldItem) : null;
    if (megas.length && !otherMegas.length) {
      const mega = megaFormeFor(starter);
      if (!mega) problems.push(`${tag} doesn't hold its Mega Stone`);
      else matchesList(starter, listFor(mega, 'MEGA'), problems, tag);
    } else {
      if (!isZCrystal(starter.heldItem) || !species(starter.species).types.includes(crystal.secondaryId)) {
        problems.push(`${tag} doesn't hold its type's Z-Crystal${otherMegas.length ? ` (${otherMegas[0].speciesName} Mega Evolves)` : ''}`);
      }
      matchesList(starter, listFor(starter.species, 'ZMOVE'), problems, tag);
    }
  }

  // The mirror day: a shiny Pikachu like RED's, and a legendary for sure.
  const pikachu = mons.find((m) => m.species === S('PIKACHU'));
  const mirror = Boolean(pikachu);
  if (rolls && rolls.mirror !== mirror) problems.push(`mirror day ${mirror}, the seed's roll says ${rolls.mirror}`);
  if (pikachu) {
    if (!pikachu.shiny) problems.push('the mirror Pikachu isn\'t shiny');
    if (pikachu.level !== LEVEL_PIKACHU) problems.push(`Pikachu: level ${pikachu.level}`);
    if (pikachu.heldItem !== id('ITEM', 'LIGHT_BALL') || !pikachu.moves.includes(id('MOVE', 'VOLT_TACKLE'))) problems.push('Pikachu lacks its Light Ball or Volt Tackle');
    matchesList(pikachu, listFor(S('PIKACHU'), 'NORMAL'), problems, 'Pikachu');
  }
  const legendaries = mons.filter((m) => LEGENDARY_LIST.includes(m.species));
  if (legendaries.length > 1) problems.push(`${legendaries.length} legendaries`);
  if (mirror && legendaries.length !== 1) problems.push('a mirror day without its legendary');
  // Never RED's legendary (in any forme).
  const redBases = new Set((redParty ?? []).filter(Boolean).map((m) => baseSpecies(m.species)));
  for (const m of legendaries) if (redBases.has(baseSpecies(m.species))) problems.push(`${m.speciesName}: RED has it too`);

  // The other Pokemon.
  for (const m of mons) {
    const tag = m.speciesName;
    checkStats(m, problems);
    if (!m.fateful || m.metLocation !== value('METLOC_FATEFUL_ENCOUNTER')) problems.push(`${tag}: not marked as an event Pokemon`);
    if (m === starter || m === pikachu) continue;
    // The paradox dogs come from outside the scope, as legendaries (sParadoxDogs).
    if (!isEligibleSpecies(m.species) && !PARADOX_DOG_LIST.includes(m.species)) problems.push(`${tag}: not an in-scope species`);
    if (!isFinalStage(m.species)) problems.push(`${tag}: not fully evolved`);
    if (isZCrystal(m.heldItem)) problems.push(`${tag} holds ${item(m.heldItem).name}`);
    const list = isTheMega(m) ? listFor(megaFormeFor(m), 'MEGA') : listFor(m.species, 'NORMAL');
    matchesList(m, list, problems, tag);
    if (list && m.level !== list.level) problems.push(`${tag}: level ${m.level}, its tier's is ${list.level}`);
    if (m.level < 94 || m.level > 99) problems.push(`${tag}: level ${m.level} outside 94-99`);
  }

  // At most one starter (the counter-starter: the five never add another)
  // and at most one Eeveelution.
  const STARTERS = ['VENUSAUR', 'CHARIZARD', 'BLASTOISE', 'MEGANIUM', 'TYPHLOSION', 'FERALIGATR', 'SCEPTILE', 'BLAZIKEN', 'SWAMPERT'].map(S);
  const EEVEELUTIONS = ['VAPOREON', 'JOLTEON', 'FLAREON', 'ESPEON', 'UMBREON', 'LEAFEON', 'GLACEON', 'SYLVEON'].map(S);
  const starterCount = mons.filter((m) => STARTERS.includes(baseSpecies(m.species))).length;
  if (starterCount > 1) problems.push(`${starterCount} starters`);
  const eeveelutionCount = mons.filter((m) => EEVEELUTIONS.includes(baseSpecies(m.species))).length;
  if (eeveelutionCount > 1) problems.push(`${eeveelutionCount} Eeveelutions`);

  // One item held twice at most, one type shared at most.
  checkTeamLimits(mons, problems);
  return problems;
}

export { constName };
