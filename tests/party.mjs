// Decodes party Pokemon (struct Pokemon) from raw RAM and checks teams
// against the rules. Layouts, names and game data (base stats, learnsets,
// moves, items) come from the build itself (game.mjs).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  GAME_DIR, symbol, layout, value, field, readBits, id, constName, species, move, item, tmhmMoves,
} from './game.mjs';

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
  const evTotal = mon.evs.reduce((x, y) => x + y, 0);
  return `${mon.speciesName.padEnd(12)} (${String(species(mon.species).bst).padStart(3)}) Lv${mon.level} ${mon.nature.padEnd(7)} HP ${mon.hp}/${mon.maxHp}`
    + ` IV ${mon.ivs.join('/')} EV ${mon.evs.join('/')} (${evTotal})${mon.shiny ? ' SHINY' : ''}`
    + ` @ ${itemName(mon.heldItem)}`
    + `\n               ${mon.moveNames.join(', ')}`;
}

// --- Rules ------------------------------------------------------------------------

// Everything the species can learn by level-up (any level) or TM/HM, from the
// ROM's own learnset tables.
const learnableCache = new Map();
export function learnableMoves(sp) {
  if (!learnableCache.has(sp)) {
    const info = species(sp);
    const teachable = new Set(info.teachable);
    learnableCache.set(sp, new Set([...info.levelUp.map((l) => l.move), ...tmhmMoves().filter((m) => teachable.has(m))]));
  }
  return learnableCache.get(sp);
}

// Moves whose damage doesn't come from the user's Attack / Sp. Atk (written
// out here independently of dailyred_team.c).
const FIXED_DAMAGE_EFFECTS = new Set(['BIDE', 'OHKO', 'FIXED_PERCENT_DAMAGE', 'FIXED_HP_DAMAGE', 'LEVEL_DAMAGE', 'PSYWAVE',
  'REFLECT_DAMAGE', 'ENDEAVOR', 'FINAL_GAMBIT']);
// Moves whose type is decided in battle.
const VARIABLE_TYPE_EFFECTS = new Set(['HIDDEN_POWER', 'WEATHER_BALL', 'NATURAL_GIFT', 'CHANGE_TYPE_ON_ITEM', 'REVELATION_DANCE',
  'AURA_WHEEL', 'TERRAIN_PULSE', 'RAGING_BULL', 'IVY_CUDGEL', 'TERA_BLAST', 'TERA_STARSTORM']);
export const isDamaging = (m) => move(m).category !== 'STATUS';
export const usesAttackingStat = (m) => isDamaging(m) && !FIXED_DAMAGE_EFFECTS.has(move(m).effect);

// The constants and pools in dailyred_team.c, so the tests always match the game.
const teamSource = readFileSync(join(GAME_DIR, 'src/dailyred_team.c'), 'utf8');
const define = (name) => Number(teamSource.match(new RegExp(`#define ${name}\\s+(\\d+)`))[1]);
export const MIN_TEAM_BST = define('MIN_TEAM_BASE_STAT_TOTAL');
export const MIN_TEAM_IV = define('MIN_TEAM_IV');
export const LEGENDARY_TEAM_ODDS = define('LEGENDARY_TEAM_ODDS');
const listIn = (pattern, prefix) => [...teamSource.match(pattern)[1].matchAll(new RegExp(`\\b${prefix}_(\\w+)`, 'g'))].map((m) => m[1]);
const GENERAL_ITEMS = new Set(listIn(/sBattleItems\[\] =\s*\{([^}]*)\}/, 'ITEM').map((n) => id('ITEM', n)));
const BOOSTERS = new Map([...teamSource.match(/sTypeBoostItems\[NUMBER_OF_MON_TYPES\] =\s*\{([^}]*)\}/)[1]
  .matchAll(/\[TYPE_(\w+)\]\s*=\s*ITEM_(\w+)/g)].map((m) => [id('ITEM', m[2]), m[1]]));
export const LEGENDARY_LIST = listIn(/sLegendaries\[\] =\s*\{([^}]*)\}/, 'SPECIES').map((n) => id('SPECIES', n));

export const isLegendary = (mon) => species(mon.species).legendary;
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

// The EV rule, written independently of the C code: 252 into each of the two
// highest base stats (Attack / Sp. Atk only if an attack of that category uses
// them; ties go Atk, SpA, Speed, HP, Def, SpD) and 6 into HP, or into the
// third-best stat if HP is one of the two.
export function expectedEVs(mon) {
  const base = species(mon.species).baseStats;
  const usable = [true, false, true, true, false, true];
  for (const m of mon.moves.filter(Boolean)) {
    if (usesAttackingStat(m)) usable[move(m).category === 'PHYSICAL' ? 1 : 4] = true;
  }
  const order = [1, 4, 3, 0, 2, 5].filter((stat) => usable[stat]).sort((a, b) => base[b] - base[a]); // sort is stable
  const evs = [0, 0, 0, 0, 0, 0];
  evs[order[0]] = 252;
  evs[order[1]] = 252;
  evs[order[0] !== 0 && order[1] !== 0 ? 0 : order[2]] = 6;
  return evs;
}

// Checks a party read from RAM against the player's team rules. Returns a
// list of problems (empty when the team is valid).
export function validateTeam({ count, party }) {
  const problems = [];
  if (count !== 6 || !party.every(Boolean)) problems.push(`party has ${count} Pokemon, expected 6`);
  const mons = party.filter(Boolean);
  if (new Set(mons.map((m) => m.species)).size !== mons.length) problems.push('duplicate species');
  const total = teamBaseStatTotal(mons);
  if (total < MIN_TEAM_BST) problems.push(`team base stat total ${total} is under the minimum ${MIN_TEAM_BST}`);
  if (mons.filter(isLegendary).length > 1) problems.push('more than one legendary');
  for (const m of mons) {
    const tag = m.speciesName;
    if (!isEligibleSpecies(m.species)) problems.push(`${tag}: not an eligible species`);
    if (m.level !== 100) problems.push(`${tag}: level ${m.level}`);
    if (m.hp !== m.maxHp || m.hp === 0) problems.push(`${tag}: HP ${m.hp}/${m.maxHp}`);
    if (m.moveNames.length === 0) problems.push(`${tag}: no moves`);
    if (new Set(m.moveNames).size !== m.moveNames.length) problems.push(`${tag}: duplicate moves`);
    const learnable = learnableMoves(m.species);
    for (const mv of m.moves.filter(Boolean)) {
      if (!learnable.has(mv)) problems.push(`${tag}: can't learn ${move(mv).name}`);
    }
    const expected = Math.min(4, learnable.size);
    if (m.moveNames.length !== expected) problems.push(`${tag}: ${m.moveNames.length} moves, expected ${expected}`);
    if ([...learnable].some(isDamaging) && !m.moves.filter(Boolean).some(isDamaging)) problems.push(`${tag}: no damaging move`);
    const evTotal = m.evs.reduce((a, b) => a + b, 0);
    if (evTotal > 510 || m.evs.some((e) => e > 252)) problems.push(`${tag}: illegal EVs ${m.evs.join('/')}`);
    if (m.ivs.some((iv) => iv < MIN_TEAM_IV || iv > 31)) problems.push(`${tag}: IVs ${m.ivs.join('/')} not all ${MIN_TEAM_IV}-31`);
    const wantEVs = expectedEVs(m);
    if (wantEVs.join('/') !== m.evs.join('/')) problems.push(`${tag}: EVs ${m.evs.join('/')}, expected ${wantEVs.join('/')}`);
    if (m.pp.some((pp, i) => m.moves[i] && pp === 0)) problems.push(`${tag}: a move has 0 PP`);
    const boostType = BOOSTERS.get(m.heldItem);
    if (boostType) {
      const attacks = m.moves.filter((mv) => mv && usesAttackingStat(mv) && !VARIABLE_TYPE_EFFECTS.has(move(mv).effect));
      if (!attacks.some((mv) => move(mv).type === boostType)) problems.push(`${tag}: holds a ${boostType} booster without a ${boostType} attack`);
    } else if (!GENERAL_ITEMS.has(m.heldItem)) {
      problems.push(`${tag}: held item ${itemName(m.heldItem)} isn't in the item pool`);
    }
    if (!m.fateful || m.metLocation !== value('METLOC_FATEFUL_ENCOUNTER')) problems.push(`${tag}: not marked as an event Pokemon`);
  }
  return problems;
}

export { constName };
