#!/usr/bin/env node
// Builds Daily Red's set table, expansion/src/dailyred_sets.c, from Pokémon
// Showdown's Random Battle generators.
//
//   cd scripts/sets && npm install && node generate.mjs
//
// One table serves every team builder in the game: each one looks up the
// species it wants and picks one of that species' sets (with Showdown's odds).
// For each Showdown entry this calls Showdown's own randomSet() many times,
// the way its Random Battle team builder does, and keeps the distinct sets
// with how often they came up.
//
// Which generations' sets a species uses: its NORMAL list mixes the sets of
// every Random Battles generation from 7 to 9 that has the species (Gen 7: the
// last generation with Mega Evolution and Z-Moves; Gen 8 and 9 add newer items
// and moves), each generation an equal share of the list, plus the
// hand-written lead sets in lead-sets.mjs (LEAD_SHARE of the list, when the
// species has any).
//
// The table has one list of sets per species and kind (DAILYRED_SETS_*):
//   NORMAL  no Z-Crystal and no Mega Stone (Showdown's sets for a team that
//           already has its Z-Move user). Every species has one.
//   MEGA    the sets of a Mega Evolution (Charizard-Mega-X...): the species to
//           create is the base form, holding the stone. Pokemon Insurgence's
//           Mega Typhlosion (INSURGENCE_MEGAS) has no Showdown sets of its
//           own: its sets are hand-written.
//   ZMOVE   Z-Crystals: RED's legendaries' (Showdown's odds); the starters'
//           always hold one (RED's Kanto starters; yours, when another of your
//           Pokemon Mega Evolves): when the set has none, the one for its
//           strongest STAB type. RED's capped Pikachu's: a Pikanium Z and Volt
//           Tackle.
//   TERA    Gen 9 sets with their Tera type, for the Kanto starters.
//
// The ROM gives every Pokemon perfect stats (all IVs maxed by hyper training),
// so the IVs in the table only decide Hidden Power's type. Random Battle sets
// have neutral natures and the same EVs in every stat, so each set gets a
// competitive spread instead (competitiveSpread below): a nature that helps
// it and 252/252/4 EVs, from its Showdown role, its attacks and its base stats.
//
// The output is deterministic (fixed PRNG seed, pinned Showdown version), and
// it is checked against the expansion's own constants: every species, move,
// item and ability must exist there, and every ability must be one the
// species can have. Run it again after changing the options below.

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LEAD_SETS, LEAD_SHARE } from './lead-sets.mjs';

const require = createRequire(import.meta.url);
const { Teams, Dex } = require('pokemon-showdown');
const PS_VERSION = require('pokemon-showdown/package.json').version;

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const SAMPLES = Number(option('samples', 400)); // randomSet() calls per list
const MIN_SHARE = Number(option('min-share', 0.02)); // drop sets rarer than this
const MAX_SETS = Number(option('max-sets', 10)); // per generation in a list, most common first
const SEED = [0x4441, 0x494c, 0x5952, 0x4544]; // "DAILYRED"
const GAME = resolve(HERE, option('game', '../../expansion'));
const OUT = resolve(HERE, option('out', join(GAME, 'src/dailyred_sets.c')));

const GENS = [7, 8, 9];
const generators = new Map(GENS.map((gen) => [gen, Teams.getGenerator(`gen${gen}randombattle`, SEED)]));
const dexes = new Map(GENS.map((gen) => [gen, Dex.forGen(gen)]));
const entriesOf = (gen) => Object.keys(generators.get(gen).randomSets);
// Pokemon Champions' Random Battles: the only sets for the Megas added after
// Gen 7 (Mega Meganium, Mega Feraligatr).
const CHAMPIONS = 'champions';
generators.set(CHAMPIONS, Teams.getGenerator('gen9championsrandombattle', SEED));
dexes.set(CHAMPIONS, Dex.forGen(9));

// RED's legendaries: their sets may hold a Z-Crystal (see dailyred_red.c).
const RED_LEGENDARIES = ['articuno', 'zapdos', 'moltres', 'raikou', 'entei', 'suicune', 'mewtwo', 'mew',
  'deoxys', 'deoxysattack', 'deoxysdefense', 'deoxysspeed'];
const KANTO_STARTERS = ['venusaur', 'charizard', 'blastoise'];
// The player's starter, picked to counter RED's (see dailyred_team.c): Megas
// with their stone, or a Z-Crystal when another of the team Mega Evolves.
const LATER_MEGAS = ['meganiummega', 'feraligatrmega'];
// Megas from Pokemon Insurgence that Daily Red adds to the expansion
// (Typhlosion's, for your starter). Showdown doesn't have them, so their sets
// are hand-written (Typhlosion's own Random Battle sets are all Choice Specs
// and Choice Scarf ones, which make no sense without the Choice item), checked
// like the lead sets. `level` is the player's level when it's one of the five
// (Typhlosion never is: it's only ever the starter, at 100).
const MEGA_FAST_SPECIAL = { hp: 4, atk: 0, def: 0, spa: 252, spd: 0, spe: 252 };
const INSURGENCE_MEGAS = [
  { base: 'typhlosion', name: 'Typhlosion-Mega (Insurgence)', species: 'SPECIES_TYPHLOSION_MEGA', stone: 'Typhlosionite', level: 95,
    sets: [
      // Hubris (Sp. Atk +1 on a KO) and no Choice lock: Eruption first, coverage after.
      { ability: 'Flash Fire', moves: ['Eruption', 'Fire Blast', 'Focus Blast', 'Scorching Sands'], nature: 'Timid', role: 'Fast Attacker' },
      { ability: 'Flash Fire', moves: ['Eruption', 'Flamethrower', 'Focus Blast', 'Shadow Ball'], nature: 'Timid', role: 'Fast Attacker' },
      { ability: 'Flash Fire', moves: ['Work Up', 'Fire Blast', 'Focus Blast', 'Scorching Sands'], nature: 'Timid', role: 'Setup Sweeper' },
      { ability: 'Blaze', moves: ['Sunny Day', 'Eruption', 'Solar Beam', 'Focus Blast'], nature: 'Timid', role: 'Setup Sweeper' },
    ].map((st) => ({ species: 'Typhlosion', item: 'Typhlosionite', evs: MEGA_FAST_SPECIAL, ...st })) },
];
const Z_STARTERS = ['meganium', 'typhlosion', 'feraligatr', 'sceptile', 'blaziken', 'swampert'];

// Daily Red's signature moves for the Kanto and Johto starters (and their
// Megas), which Showdown doesn't have: a set of theirs gets its own in place
// of its strongest attack of the same type and category (Charizard's Burning
// Meteor, physical or special by its higher stat, takes either); a set
// without one (Meganium's physical sets...) keeps its moves. Typhlosion's
// Pyroclastic takes Work Up's place (its other sets, Choice ones, have no
// slot for a status move). See "Signature moves" in the README.
const SIGNATURE_MOVES = {
  Venusaur: { id: 'havocbloom', constant: 'MOVE_HAVOC_BLOOM', type: 'Grass', category: 'Special' },
  Blastoise: { id: 'twinpulse', constant: 'MOVE_TWIN_PULSE', type: 'Water', category: 'Special' },
  Charizard: { id: 'flaremeteor', constant: 'MOVE_FLARE_METEOR', type: 'Fire' },
  Meganium: { id: 'blightpetal', constant: 'MOVE_BLIGHT_PETAL', type: 'Grass', category: 'Special' },
  Typhlosion: { id: 'pyroclastic', constant: 'MOVE_PYROCLASTIC', move: 'workup' },
  Feraligatr: { id: 'jawcrash', constant: 'MOVE_JAW_CRASH', type: 'Water', category: 'Physical' },
};
const SIGNATURE_CONSTANTS = new Map(Object.values(SIGNATURE_MOVES).map((m) => [m.id, m.constant]));
// The Gen 3 starters' moves that only their families (and these few) keep in
// Daily Red; a set of anyone else's that has one is left out.
const EXCLUSIVE_MOVES = {
  leafblade: ['Treecko', 'Grovyle', 'Sceptile', 'Leafeon', 'Gallade'],
  blazekick: ['Torchic', 'Combusken', 'Blaziken', 'Hitmonlee', 'Zapdos-Galar'],
  muddywater: ['Mudkip', 'Marshtomp', 'Swampert', 'Barboach', 'Whiscash', 'Wooper', 'Quagsire'],
};

// Every final-stage starter of Generations 1-9 (their whole families are left
// out of RED's random pick).
const STARTER_ROOTS = new Set(['bulbasaur', 'charmander', 'squirtle', 'chikorita', 'cyndaquil', 'totodile',
  'treecko', 'torchic', 'mudkip', 'turtwig', 'chimchar', 'piplup', 'snivy', 'tepig', 'oshawott', 'chespin',
  'fennekin', 'froakie', 'rowlet', 'litten', 'popplio', 'grookey', 'scorbunny', 'sobble', 'sprigatito',
  'fuecoco', 'quaxly', 'pichu']); // and Pikachu's family: RED always has Pikachu, and never Raichu
const NOT_RANDOM_TAGS = ['Restricted Legendary', 'Sub-Legendary', 'Mythical', 'Ultra Beast', 'Paradox'];

// --- The expansion's constants ------------------------------------------------

const readGame = (file) => readFileSync(join(GAME, file), 'utf8');

// Enum entries ("MOVE_X = 1," or "MOVE_Y = MOVE_X,"), aliases resolved to the
// canonical name.
function readEnum(file, prefix) {
  const canonical = new Map();
  for (const m of readGame(file).matchAll(new RegExp(`^\\s*(${prefix}\\w+)\\s*(?:=\\s*([^,/\\n]+))?,`, 'gm'))) {
    const [, name, value] = m;
    const alias = value && value.trim().match(new RegExp(`^(${prefix}\\w+)$`));
    canonical.set(name, alias ? canonical.get(alias[1]) ?? alias[1] : name);
  }
  return canonical;
}

const SPECIES = readEnum('include/constants/species.h', 'SPECIES_');
const MOVES = readEnum('include/constants/moves.h', 'MOVE_');
const ITEMS = readEnum('include/constants/items.h', 'ITEM_');
const ABILITIES = readEnum('include/constants/abilities.h', 'ABILITY_');
const TYPES = readEnum('include/constants/pokemon.h', 'TYPE_');

// Abilities each species can have, from src/data/pokemon/species_info.h. Many
// species are written with macros, so the file goes through the C
// preprocessor first, with the game's own config.
function preprocess(file) {
  const toolchain = resolve(HERE, '../../.toolchain/arm-none-eabi/bin/arm-none-eabi-cpp');
  const cpp = [toolchain, 'arm-none-eabi-cpp', 'cpp'].find((c) => {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  });
  if (!cpp) throw new Error('No C preprocessor found (arm-none-eabi-cpp or cpp).');
  return execFileSync(cpp, ['-P', '-iquote', 'include', '-DMODERN=1', '-DTESTING=0', '-DFIRERED', '-std=gnu17',
    '-include', 'global.h', file], { cwd: GAME, encoding: 'utf8', maxBuffer: 64 << 20 });
}

// And which species the expansion marks as legendary, mythical, Ultra Beast
// or Paradox (RED's random pick leaves them out, with Showdown's own tags).
const SPECIES_ABILITIES = new Map();
const SPECIES_SPECIAL = new Set();
{
  const blocks = preprocess('src/data/pokemon/species_info.h').split(/\[(SPECIES_\w+)\]\s*=/);
  for (let i = 1; i < blocks.length; i += 2) {
    const names = new Set();
    const body = blocks[i + 1].split(/\n\s*\[SPECIES_/)[0];
    for (const line of body.matchAll(/\.abilities\s*=\s*\{([^}]*)\}/g)) {
      for (const a of line[1].matchAll(/ABILITY_\w+/g)) if (a[0] !== 'ABILITY_NONE') names.add(ABILITIES.get(a[0]) ?? a[0]);
    }
    const key = SPECIES.get(blocks[i]) ?? blocks[i];
    SPECIES_ABILITIES.set(key, names);
    if (/\.is(RestrictedLegendary|SubLegendary|Mythical|UltraBeast|Paradox)\s*=\s*(TRUE|1)/.test(body)) SPECIES_SPECIAL.add(key);
  }
}

// --- Showdown names -> expansion constants -------------------------------------

function toConst(name) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/['’.:%]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

// Where the expansion's name differs from Showdown's (beyond the default
// forms found by speciesConst below).
const SPECIES_ALIASES = {
  'Greninja-Bond': 'SPECIES_GRENINJA_BATTLE_BOND',
  'Zygarde-10%': 'SPECIES_ZYGARDE_10',
};
const ITEM_ALIASES = {};
const MOVE_ALIASES = {};
const ABILITY_ALIASES = {
  'As One (Glastrier)': 'ABILITY_AS_ONE_ICE_RIDER',
  'As One (Spectrier)': 'ABILITY_AS_ONE_SHADOW_RIDER',
};

const problems = [];
function constant(table, prefix, aliases, name, what) {
  const key = aliases[name] ?? `${prefix}${toConst(name)}`;
  if (!table.has(key)) {
    problems.push(`${what} "${name}": no ${key} in the expansion`);
    return null;
  }
  return key;
}
// A species Showdown names without its form ("Lycanroc", "Meowstic") is the
// expansion's first form of it (SPECIES_LYCANROC_MIDDAY, SPECIES_MEOWSTIC_M).
const defaultForms = new Map();
function speciesConst(name) {
  const key = SPECIES_ALIASES[name] ?? `SPECIES_${toConst(name)}`;
  if (!SPECIES.has(key)) {
    const form = [...SPECIES.keys()].find((k) => k.startsWith(`${key}_`));
    if (form) {
      defaultForms.set(name, form);
      return form;
    }
  }
  return constant(SPECIES, 'SPECIES_', SPECIES_ALIASES, name, 'species');
}
const itemConst = (name) => (name ? constant(ITEMS, 'ITEM_', ITEM_ALIASES, name, 'item') : 'ITEM_NONE');
const abilityConst = (name) => constant(ABILITIES, 'ABILITY_', ABILITY_ALIASES, name, 'ability');
const typeConst = (name) => (name ? constant(TYPES, 'TYPE_', {}, name, 'type') : 'TYPE_NONE');
function moveConst(dex, id) {
  if (id.startsWith('hiddenpower')) return 'MOVE_HIDDEN_POWER';
  if (SIGNATURE_CONSTANTS.has(id)) return SIGNATURE_CONSTANTS.get(id);
  return constant(MOVES, 'MOVE_', MOVE_ALIASES, dex.moves.get(id).name, 'move');
}

// The species to create with an ability. Some abilities live on a separate
// species in the expansion (Greninja's Battle Bond, Zygarde's Power
// Construct...): look for a forme of the same species that has it.
function speciesWithAbility(speciesKey, abilityKey) {
  const canonical = SPECIES.get(speciesKey);
  if (SPECIES_ABILITIES.get(canonical)?.has(abilityKey)) return speciesKey;
  const family = canonical.replace(/_(50|10|AVERAGE|MIDDAY|SOLO|METEOR_RED|DISGUISED|SHIELD|BAILE|M|NORMAL)$/, '');
  const candidates = [...SPECIES_ABILITIES].filter(([name, abilities]) => (name === family || name.startsWith(`${family}_`)) && abilities.has(abilityKey));
  candidates.sort((a, b) => a[0].length - b[0].length);
  if (candidates.length) return candidates[0][0];
  problems.push(`${speciesKey} can't have ${abilityKey} in the expansion`);
  return speciesKey;
}

// --- Which lists to build ----------------------------------------------------------

// Showdown picks a random cosmetic forme for some species (Vivillon's
// patterns, Florges' colors, Minior's cores...). They battle the same, so the
// table keeps the default one.
// The same goes for formes that battle exactly like their base species (same
// types, base stats and abilities), like Dudunsparce-Three-Segment.
function battleSpecies(dex, name) {
  const species = dex.species.get(name);
  const base = dex.species.get(species.baseSpecies);
  if (base.cosmeticFormes?.includes(species.name)) return base;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (species !== base && !species.battleOnly && same(species.types, base.types) && same(species.baseStats, base.baseStats)
    && same(species.abilities, base.abilities)) return base;
  return species;
}

// The first stage of a species' family (formes without an evolution line of
// their own, like Greninja-Bond, use their base species').
function familyRoot(dex, species) {
  let s = species.prevo || species.baseSpecies === species.name ? species : dex.species.get(species.baseSpecies);
  for (let guard = 0; s.prevo && guard < 5; guard++) s = dex.species.get(s.prevo);
  return dex.species.get(s.baseSpecies).id;
}

const lists = [];
// Every generation's Showdown entries for each species, for its NORMAL list.
const normalSources = new Map(); // Showdown species id -> { species, sources }
for (const gen of GENS) {
  const dex = dexes.get(gen);
  for (const id of entriesOf(gen)) {
    const species = dex.species.get(id);
    if (gen > 7 && species.name.endsWith('-Gmax')) continue; // no Dynamax in Daily Red
    if (species.isMega || species.isPrimal) {
      if (gen === 7) lists.push({ id, gen, kind: 'MEGA', species, details: {}, sources: [{ gen, id }] });
      continue;
    }
    const onlyDynamax = generators.get(gen).randomSets[id].sets?.every((st) => st.role === 'Dynamax User');
    if (!normalSources.has(species.id)) normalSources.set(species.id, { species, sources: [] });
    normalSources.get(species.id).sources.push({ gen, id, onlyDynamax });
  }
}
for (const { species, sources } of normalSources.values()) {
  // A Gen 8 entry whose only sets are built for Dynamax is left out when
  // another generation has the species; otherwise its sets are used as plain
  // sets (their moves are fine without Dynamax).
  let use = sources.filter((src) => !src.onlyDynamax);
  if (!use.length) use = sources.map((src) => ({ ...src, allowDynamaxSets: true }));
  const list = { id: species.id, gen: use[0].gen, kind: 'NORMAL', species, details: { zMove: 1 }, sources: use };
  lists.push(list);
  // RED's capped Pikachu: the same sets, holding a Pikanium Z.
  if (species.id === 'pikachu') lists.push({ ...list, kind: 'ZMOVE', pikaniumZ: true });
}
for (const id of RED_LEGENDARIES) lists.push({ id, gen: 7, kind: 'ZMOVE', species: dexes.get(7).species.get(id), details: {}, sources: [{ gen: 7, id }] });
for (const id of KANTO_STARTERS) {
  lists.push({ id, gen: 7, kind: 'ZMOVE', species: dexes.get(7).species.get(id), details: {}, forceZ: true, sources: [{ gen: 7, id }] });
  lists.push({ id, gen: 9, kind: 'TERA', species: dexes.get(9).species.get(id), details: {}, sources: [{ gen: 9, id }] });
}
for (const id of LATER_MEGAS) lists.push({ id, gen: CHAMPIONS, kind: 'MEGA', species: Dex.species.get(id), details: {}, sources: [{ gen: CHAMPIONS, id }] });
for (const id of Z_STARTERS) lists.push({ id, gen: 7, kind: 'ZMOVE', species: dexes.get(7).species.get(id), details: {}, forceZ: true, sources: [{ gen: 7, id }] });
for (const mega of INSURGENCE_MEGAS) {
  const base = normalSources.get(mega.base);
  if (!base) throw new Error(`${mega.name}: no Showdown sets for ${mega.base}`);
  lists.push({ id: mega.base, gen: base.sources[0].gen, kind: 'MEGA', species: base.species, details: { zMove: 1 },
    sources: base.sources.filter((src) => !src.onlyDynamax), insurgence: mega });
}

// The player's level for each species, from its Gen 7 Showdown tier (Gen 8,
// then Gen 9, for species Gen 7 doesn't have): the stronger the tier, the
// lower the level. A "BL" tier (banned to the tier above) counts as the tier
// above.
const TIER_LEVELS = [
  [['AG', 'Uber', '(Uber)'], 94],
  [['OU', '(OU)', 'UUBL'], 95],
  [['UU', '(UU)', 'RUBL'], 96],
  [['RU', '(RU)', 'NUBL'], 97],
  [['NU', '(NU)', 'PUBL'], 98],
];
const LOWEST_TIER_LEVEL = 99; // PU and below
const UNTIERED = ['Illegal', 'Unreleased', 'CAP', 'CAP NFE', 'CAP LC', ''];
function tierOf(species) {
  for (const gen of GENS) {
    const tier = dexes.get(gen).species.get(species.name).tier ?? '';
    if (!UNTIERED.includes(tier)) return { tier, gen };
  }
  return { tier: Dex.species.get(species.name).tier ?? 'none', gen: 9 };
}
function tierLevel(tier) {
  for (const [tiers, level] of TIER_LEVELS) if (tiers.includes(tier)) return level;
  return LOWEST_TIER_LEVEL;
}

// RED's random pick: a fully evolved Pokemon from a Gen 1 family, in its
// regular form: a Pokemon of the Gen 1 Pokedex (national dex 1-151), or a
// later Pokemon that evolves from one (Crobat, Scizor, Blissey, Magnezone,
// Kleavor, Annihilape...; not from a regional form, so no Sirfetch'd or Mr.
// Rime). Not a starter (nor Pikachu's family), legendary or mythical. "Fully
// evolved" is judged with the latest generation's data, so a Pokemon that
// gained an evolution later (Magneton, Scyther, Electabuzz...) is out.
const RANDOM_PICK_LAST_DEX = 151;
function isFromGen1Family(species) {
  for (let s = species, guard = 0; s && guard < 5; guard++) {
    if (s.forme) return false; // a regional (or other) form, or evolved from one
    if (s.num >= 1 && s.num <= RANDOM_PICK_LAST_DEX) return true;
    s = s.prevo ? Dex.species.get(s.prevo) : null;
  }
  return false;
}
function isRandomPick(list) {
  if (list.kind !== 'NORMAL') return false;
  const dex = Dex;
  const species = Dex.species.get(list.species.name);
  if (species.forme || !isFromGen1Family(species)) return false;
  if (species.nfe || species.battleOnly) return false;
  if (species.tags.some((t) => NOT_RANDOM_TAGS.includes(t))) return false;
  if (STARTER_ROOTS.has(familyRoot(dex, species))) return false;
  return true;
}

// --- Sampling --------------------------------------------------------------------

const STAT_ORDER = ['hp', 'atk', 'def', 'spa', 'spd', 'spe']; // Showdown's order, kept in the table

function canonicalSet(dex, set) {
  return {
    species: battleSpecies(dex, set.species).name,
    item: set.item,
    ability: set.ability,
    moves: [...set.moves].sort(),
    nature: set.nature || '',
    evs: STAT_ORDER.map((s) => set.evs[s]),
    ivs: STAT_ORDER.map((s) => set.ivs[s]),
    teraType: set.teraType ?? '',
  };
}

// The Z-Crystal for a set without one: its strongest STAB type (primary type
// first on ties).
function addZCrystal(dex, set) {
  const species = dex.species.get(set.species);
  const held = dex.items.get(set.item);
  // Keep a crystal Showdown chose if it's for one of the species' types.
  if (held.zMove && held.zMoveType && species.types.includes(held.zMoveType)) return set;
  let best = null;
  for (const id of set.moves) {
    const move = dex.moves.get(id);
    if (move.category === 'Status' || !species.types.includes(move.type)) continue;
    const score = move.basePower * 10 + (move.type === species.types[0] ? 1 : 0);
    if (!best || score > best.score) best = { type: move.type, score };
  }
  if (!best) throw new Error(`${set.species} has no STAB attack for a Z-Crystal`);
  const crystal = dex.items.all().find((i) => i.zMoveType === best.type && !i.itemUser);
  return { ...set, item: crystal.name };
}

// Pikachu always knows Volt Tackle (in place of its other Electric attack, or
// its last move) and holds a Light Ball (RED's and your mirror-day Pikachu)
// or, in its ZMOVE list (RED's capped Pikachu), a Pikanium Z, which turns
// Volt Tackle into Catastropika. Gen 8 and 9 give Pikachu a random cap
// (Pikachu-Unova...): it's the regular Pikachu here.
function forcePikachu(dex, set, list) {
  if (dex.species.get(set.species).baseSpecies !== 'Pikachu' || dex.species.get(set.species).battleOnly) return set;
  const moves = [...set.moves];
  if (!moves.includes('volttackle')) {
    const electric = moves.findIndex((m) => dex.moves.get(m).type === 'Electric' && dex.moves.get(m).category !== 'Status');
    moves[electric >= 0 ? electric : moves.length - 1] = 'volttackle';
  }
  return { ...set, species: 'Pikachu', item: list.pikaniumZ ? 'Pikanium Z' : 'Light Ball', moves };
}

// A set with Daily Red's move rules (SIGNATURE_MOVES, EXCLUSIVE_MOVES): null
// when it has a move its species doesn't keep.
function signatureSet(dex, set) {
  const species = dex.species.get(set.species);
  const isMega = Boolean(species.forme?.startsWith('Mega'));
  const name = isMega ? species.baseSpecies : species.name;
  for (const [move, keepers] of Object.entries(EXCLUSIVE_MOVES)) {
    if (set.moves.includes(move) && !keepers.includes(name)) return null;
  }
  const sig = !species.forme || isMega ? SIGNATURE_MOVES[species.baseSpecies] : null;
  if (!sig || set.moves.includes(sig.id)) return set;
  let slot = -1;
  if (sig.move) {
    slot = set.moves.indexOf(sig.move);
  } else {
    const attacks = set.moves.map((id, i) => ({ move: dex.moves.get(id), i }))
      .filter(({ move }) => move.type === sig.type && move.category !== 'Status' && !move.id.startsWith('hiddenpower')
        && (!sig.category || move.category === sig.category));
    attacks.sort((a, b) => b.move.basePower - a.move.basePower);
    if (attacks.length) slot = attacks[0].i;
  }
  if (slot < 0) return set;
  const moves = [...set.moves];
  moves[slot] = sig.id;
  return { ...set, moves };
}

// Gimmick sets Daily Red leaves out (Showdown plays them, but they're odd in
// a straight battle). Samples that hit one are dropped, so the remaining sets
// keep Showdown's odds among themselves.
const GIMMICK_MOVES = new Set(['holdhands', 'celebrate', 'happyhour', 'splash', 'conversion']);
function gimmickReason(dex, list, set) {
  if (set.role === 'Dynamax User' && !list.allowDynamaxSets) return 'built for Dynamax (Max Moves)';
  if (list.kind !== 'TERA' && set.moves.includes('terablast')) return 'Tera Blast without a Tera type';
  const item = dex.items.get(set.item);
  if (item.zMove) {
    // A Z-Crystal powers up one of the set's attacks, never a status move.
    const moves = set.moves.map((m) => dex.moves.get(m));
    const powered = item.zMoveFrom ? moves.filter((m) => m.name === item.zMoveFrom) : moves.filter((m) => m.type === item.zMoveType);
    if (!powered.some((m) => m.category !== 'Status')) return 'status Z-Move';
  }
  if (set.moves.some((m) => GIMMICK_MOVES.has(m))) return 'gimmick move (Hold Hands, Celebrate, Happy Hour, Splash, Conversion)';
  return null;
}
const dropped = new Map(); // reason -> samples

// --- Competitive natures and EVs ---------------------------------------------------
//
// What a set is built to do decides its spread:
//   fast attacker      +Speed, minus the attack it doesn't use (Jolly, Timid);
//                      252 attack / 252 Speed / 4 HP
//   bulky attacker     +attack (Adamant, Modest); 252 HP / 252 attack / 4 to
//                      the lower defence
//   mixed attacker     +its main attack or Speed, minus a defence (Naive,
//                      Lonely...); 252 main attack, 252 Speed (or HP if
//                      bulky), 4 the other attack
//   defensive          +a defence, minus an unused attack (Bold, Impish, Calm,
//                      Careful); 252 HP / 252 that defence / 4 the other
//   Trick Room / Gyro Ball sets lower Speed instead (Brave, Quiet, Relaxed,
//   Sassy) and put nothing in it.
// Fast or bulky comes from Showdown's role for the set ('Fast Attacker',
// 'Bulky Support'...), a Choice Scarf always means fast, and a set without a
// role is fast from base Speed 80. A defensive set raises the defence its
// setup move doesn't (Calm Mind raises Sp. Def, so Bold) or Defense for Body
// Press, otherwise its lower defence.
const NATURES = {
  atk: { spa: 'Adamant', spe: 'Brave', def: 'Lonely', spd: 'Naughty' },
  spa: { atk: 'Modest', spe: 'Quiet', def: 'Mild', spd: 'Rash' },
  spe: { atk: 'Timid', spa: 'Jolly', def: 'Hasty', spd: 'Naive' },
  def: { atk: 'Bold', spa: 'Impish', spd: 'Lax', spe: 'Relaxed' },
  spd: { atk: 'Calm', spa: 'Careful', def: 'Gentle', spe: 'Sassy' },
};
const FAST_ROLES = ['Fast Attacker', 'Setup Sweeper', 'Fast Support', 'Fast Bulky Setup'];
const BULKY_ROLES = ['Bulky Attacker', 'Wallbreaker', 'AV Pivot', 'Bulky Setup'];
const DEFENSIVE_ROLES = ['Bulky Support', 'Staller'];
// Attacks whose damage doesn't come from the user's Attack or Sp. Atk.
const FIXED_DAMAGE = new Set(['seismictoss', 'nightshade', 'superfang', 'endeavor', 'finalgambit', 'ruination',
  'counter', 'mirrorcoat', 'metalburst', 'psywave', 'dragonrage', 'sonicboom', 'naturesmadness', 'foulplay', 'bodypress']);
const SLOW_MOVES = new Set(['trickroom', 'gyroball']);
// Setup moves that make a Bulky Setup set defensive, and the defence they raise.
const DEFENSIVE_SETUP = { calmmind: 'spd', amnesia: 'spd', bulkup: 'def', curse: 'def', irondefense: 'def',
  acidarmor: 'def', barrier: 'def', cottonguard: 'def', stockpile: 'def', cosmicpower: 'def', coil: 'def' };

function competitiveSpread(dex, set) {
  const species = dex.species.get(set.species);
  const base = species.baseStats;
  const moves = set.moves.map((m) => dex.moves.get(m));
  const weight = { atk: 0, spa: 0 };
  for (const m of moves) {
    if (m.category === 'Status' || FIXED_DAMAGE.has(m.id)) continue;
    const strong = !m.basePower || m.basePower >= 60 || m.multihit;
    weight[m.category === 'Physical' ? 'atk' : 'spa'] += strong ? 1 : 0.5;
  }
  const slow = moves.some((m) => SLOW_MOVES.has(m.id));
  const setup = moves.map((m) => DEFENSIVE_SETUP[m.id]).find(Boolean);
  const role = set.role;
  let kind;
  if (DEFENSIVE_ROLES.includes(role) || (role === 'Bulky Setup' && setup)) kind = 'defensive';
  else if (set.item === 'Choice Scarf') kind = 'fast';
  else if (FAST_ROLES.includes(role)) kind = 'fast';
  else if (BULKY_ROLES.includes(role)) kind = 'bulky';
  else if (weight.atk + weight.spa < 1.5) kind = 'defensive';
  else kind = base.spe >= 80 ? 'fast' : 'bulky';
  // A fast set with no attacks to boost (status moves only) keeps its Speed
  // and bulk: 252 HP / 252 Speed.
  const attacking = weight.atk + weight.spa > 0;

  const evs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  let up, down;
  const unusedAttack = weight.atk > 0 && weight.spa === 0 ? 'spa' : 'atk';
  const lowerDefence = base.def <= base.spd ? 'def' : 'spd';
  const higherDefence = lowerDefence === 'def' ? 'spd' : 'def';
  if (kind === 'defensive' || (kind === 'fast' && !attacking)) {
    const defence = moves.some((m) => m.id === 'bodypress') ? 'def'
      : setup ? (setup === 'spd' ? 'def' : 'spd') : lowerDefence;
    if (kind === 'fast') {
      up = 'spe'; down = unusedAttack;
      evs.hp = 252; evs.spe = 252; evs[defence] = 4;
    } else {
      up = defence; down = slow ? 'spe' : unusedAttack;
      evs.hp = 252; evs[defence] = 252; evs[defence === 'def' ? 'spd' : 'def'] = 4;
    }
  } else {
    const main = weight.atk > weight.spa || (weight.atk === weight.spa && base.atk >= base.spa) ? 'atk' : 'spa';
    const other = main === 'atk' ? 'spa' : 'atk';
    const mixed = weight[other] >= 1 && weight[other] >= weight[main] / 2;
    if (slow) {
      up = main; down = 'spe';
      evs.hp = 252; evs[main] = 252; evs[mixed ? other : lowerDefence] = 4;
    } else if (kind === 'fast') {
      up = 'spe'; down = mixed ? higherDefence : other;
      evs[main] = 252; evs.spe = 252; evs[mixed ? other : 'hp'] = 4;
    } else {
      up = main; down = mixed ? higherDefence : other;
      evs.hp = 252; evs[main] = 252; evs[mixed ? other : lowerDefence] = 4;
    }
  }
  // Shedinja always has 1 HP: its HP EVs go to Speed.
  if (base.hp === 1 && evs.hp) {
    evs.spe += evs.hp;
    evs.hp = 0;
    if (evs.spe > 252) { evs.def += evs.spe - 252; evs.spe = 252; }
  }
  return { ...set, nature: NATURES[up][down], evs };
}

// Lead sets: the hand-written ones (lead-sets.mjs), in the same shape as
// Showdown's, checked against Showdown's learnsets (any generation, the
// species' pre-evolutions included).
const toID = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '');
function canLearn(speciesName, moveId) {
  if (toID(speciesName) === 'smeargle') return !Dex.moves.get(moveId).flags.nosketch; // Sketch
  for (let s = Dex.species.get(speciesName), guard = 0; s?.exists && guard < 5; guard++) {
    const learnset = Dex.species.getLearnsetData(s.id)?.learnset ?? Dex.species.getLearnsetData(toID(s.baseSpecies))?.learnset;
    if (learnset?.[moveId]) return true;
    s = s.prevo ? Dex.species.get(s.prevo) : null;
  }
  return false;
}
// A hand-written set, checked and in canonical form (null if it fails).
function handWrittenSet(lead) {
  const species = Dex.species.get(lead.species);
  if (!species.exists) { problems.push(`lead set: no species "${lead.species}" in Showdown`); return null; }
  const moves = lead.moves.map(toID);
  moves.forEach((m, i) => {
    if (!Dex.moves.get(m).exists) problems.push(`lead set ${lead.species}: no move "${lead.moves[i]}" in Showdown`);
    else if (!canLearn(lead.species, m)) problems.push(`lead set ${lead.species}: can't learn ${lead.moves[i]}`);
  });
  if (!Dex.items.get(lead.item).exists && !INSURGENCE_MEGAS.some((m) => m.stone === lead.item)) problems.push(`lead set ${lead.species}: no item "${lead.item}" in Showdown`);
  if (!Object.values(species.abilities).includes(lead.ability)) problems.push(`lead set ${lead.species}: can't have ${lead.ability}`);
  const evTotal = Object.values(lead.evs).reduce((a, b) => a + b, 0);
  if (evTotal > 510) problems.push(`lead set ${lead.species}: ${evTotal} EVs`);
  const ivs = { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 };
  const set = signatureSet(dexes.get(9), { ...lead, species: species.name, moves, ivs });
  if (!set) return null;
  return { set: canonicalSet(dexes.get(9), set), gen: 9, role: lead.role, handWritten: true };
}
const leadSetsBySpecies = new Map();
for (const lead of LEAD_SETS) {
  const entry = handWrittenSet(lead);
  if (!entry) continue;
  const id = Dex.species.get(lead.species).id;
  if (!leadSetsBySpecies.has(id)) leadSetsBySpecies.set(id, []);
  leadSetsBySpecies.get(id).push(entry);
}
const leadsUsed = new Set();

// One generation's sets for a list: Showdown's randomSet() SAMPLES times,
// rare sets dropped, the MAX_SETS most common kept, each with its share of
// that generation's samples.
function sampleSource(list, source) {
  const generator = generators.get(source.gen);
  const dex = dexes.get(source.gen);
  const counts = new Map();
  let distinct = 0;
  for (let i = 0; i < SAMPLES; i++) {
    let set = generator.randomSet(source.id, { ...list.details }, false);
    const reason = gimmickReason(dex, { ...list, allowDynamaxSets: source.allowDynamaxSets }, set);
    if (reason) {
      dropped.set(reason, (dropped.get(reason) ?? 0) + 1);
      continue;
    }
    if (list.forceZ) set = addZCrystal(dex, set);
    set = forcePikachu(dex, set, list);
    set = competitiveSpread(dex, set);
    set = signatureSet(dex, set);
    if (!set) {
      dropped.set('a move only the Gen 3 starters (and a few others) keep', (dropped.get('a move only the Gen 3 starters (and a few others) keep') ?? 0) + 1);
      continue;
    }
    if (list.insurgence) set = { ...set, item: list.insurgence.stone };
    const item = dex.items.get(set.item);
    if (list.kind === 'NORMAL' && (item.zMove || item.megaStone)) throw new Error(`${list.id}: NORMAL set holds ${set.item}`);
    if (list.kind !== 'TERA') set = { ...set, teraType: undefined };
    const c = canonicalSet(dex, set);
    const key = JSON.stringify(c);
    if (!counts.has(key)) { counts.set(key, { set: c, count: 0, role: set.role, gen: source.gen }); distinct++; }
    counts.get(key).count++;
  }
  let sets = [...counts.values()];
  const total = sets.reduce((n, st) => n + st.count, 0);
  if (!total) return { sets: [], distinct };
  sets = sets.filter((st) => st.count / total >= MIN_SHARE);
  if (!sets.length) sets = [...counts.values()]; // every set is rare: keep them all
  sets.sort((a, b) => b.count - a.count || (a.set.moves.join() < b.set.moves.join() ? -1 : 1));
  sets = sets.slice(0, MAX_SETS);
  const kept = sets.reduce((n, st) => n + st.count, 0);
  return { sets: sets.map((st) => ({ ...st, share: st.count / kept })), distinct };
}

// A stall set (RED takes at most one, see dailyred_red.c): Showdown's
// staller and bulky support roles, and any set whose nature raises a defence
// (its spread is built to take hits, not to attack).
const DEFENSIVE_NATURES = new Set(['Bold', 'Impish', 'Lax', 'Relaxed', 'Calm', 'Careful', 'Gentle', 'Sassy']);
function isStall(set, role) {
  return role === 'Staller' || role === 'Bulky Support' || DEFENSIVE_NATURES.has(set.nature);
}

const startTime = Date.now();
for (const list of lists) {
  // Each generation an equal share of the list; the lead sets LEAD_SHARE.
  const own = list.insurgence?.sets?.map(handWrittenSet).filter(Boolean);
  const sampled = own ? [] : list.sources.map((source) => sampleSource(list, source)).filter((r) => r.sets.length);
  const leads = own ?? (list.kind === 'NORMAL' ? leadSetsBySpecies.get(list.species.id) ?? [] : []);
  if (leads.length && !own) leadsUsed.add(list.species.id);
  const showdownShare = leads.length ? 1 - LEAD_SHARE : 1;
  const merged = new Map();
  const add = (entry, share) => {
    const key = JSON.stringify(entry.set);
    if (!merged.has(key)) merged.set(key, { set: entry.set, role: entry.role, gen: entry.gen, handWritten: entry.handWritten, share: 0 });
    merged.get(key).share += share;
  };
  for (const r of sampled) for (const st of r.sets) add(st, (showdownShare * st.share) / sampled.length);
  for (const lead of leads) add(lead, (sampled.length ? LEAD_SHARE : 1) / leads.length);
  list.distinct = sampled.reduce((n, r) => n + r.distinct, 0) + leads.length;
  if (!merged.size) {
    // Every set is a gimmick one (Magikarp's Splash...): no list, so no team uses the species.
    if (list.kind !== 'NORMAL' || RED_LEGENDARIES.includes(list.id) || KANTO_STARTERS.includes(list.id)) {
      throw new Error(`${list.id} (Gen ${list.gen}, ${list.kind}) has no sets left`);
    }
    list.sets = [];
    continue;
  }
  list.sets = [...merged.values()].sort((a, b) => b.share - a.share || (a.set.moves.join() < b.set.moves.join() ? -1 : 1));
  list.gens = [...new Set(sampled.map((r) => r.sets[0].gen))];
}
for (const id of leadSetsBySpecies.keys()) if (!leadsUsed.has(id)) problems.push(`lead sets for ${id}, which has no NORMAL list`);
const sampleSeconds = (Date.now() - startTime) / 1000;

// --- Converting to the expansion's constants -----------------------------------------

const outLists = [];
const outSets = [];
const noSets = lists.filter((l) => !l.sets.length).map((l) => l.species.name);
for (const list of lists.filter((l) => l.sets.length)) {
  const key = list.insurgence ? constant(SPECIES, 'SPECIES_', { [list.insurgence.name]: list.insurgence.species }, list.insurgence.name, 'species')
    : speciesConst(list.species.name);
  const firstSet = outSets.length;
  const maxShare = Math.max(...list.sets.map((st) => st.share));
  for (const { set, share, role, gen, handWritten } of list.sets) {
    const dex = dexes.get(gen);
    const abilityKey = abilityConst(set.ability);
    const createKey = speciesConst(set.species);
    outSets.push({
      species: createKey && abilityKey ? speciesWithAbility(createKey, abilityKey) : createKey,
      item: itemConst(set.item),
      ability: abilityKey,
      moves: set.moves.map((m) => moveConst(dex, m)),
      nature: set.nature ? `NATURE_${toConst(set.nature)}` : 'NATURE_SERIOUS',
      evs: set.evs,
      ivs: set.ivs,
      teraType: typeConst(set.teraType),
      friendship: set.moves.includes('frustration') ? 0 : 255,
      stall: isStall(set, role),
      weight: Math.max(1, Math.round((share * 255) / maxShare)),
      comment: `${role ? `${role}, ` : ''}${handWritten ? 'hand-written' : gen === CHAMPIONS ? 'Champions' : `Gen ${gen}`}${list.insurgence && !handWritten ? ` ${list.species.name}'s` : ''}, ${(100 * share).toFixed(share < 0.1 ? 1 : 0)}%`,
    });
  }
  outLists.push({
    name: list.insurgence?.name ?? list.species.name,
    gen: list.gen,
    gens: list.gens,
    kind: list.kind,
    species: key,
    base: list.species.baseSpecies,
    firstSet,
    numSets: outSets.length - firstSet,
    randomPick: isRandomPick(list) && !SPECIES_SPECIAL.has(SPECIES.get(key)),
    ...(() => {
      if (list.insurgence) return { tier: 'not on Showdown', tierGen: 'Insurgence', level: list.insurgence.level };
      const { tier, gen } = tierOf(list.species);
      return { tier, tierGen: gen, level: tierLevel(tier) };
    })(),
  });
}

if (problems.length) {
  console.error(`${new Set(problems).size} problem(s):\n  ${[...new Set(problems)].join('\n  ')}`);
  process.exit(1);
}

// The random-pick lists, grouped by species (so Rotom's five formes count as
// one Pokemon).
const pickGroups = new Map();
outLists.forEach((l, i) => {
  if (!l.randomPick) return;
  if (!pickGroups.has(l.base)) pickGroups.set(l.base, []);
  pickGroups.get(l.base).push(i);
});

// --- Writing the C file ------------------------------------------------------------------

const strip = (prefix, name) => name.slice(prefix.length);
const ivsExpr = ([hp, atk, def, spa, spd, spe]) => `TRAINER_PARTY_IVS(${hp}, ${atk}, ${def}, ${spe}, ${spa}, ${spd})`;
const lines = [];
lines.push(`// Generated by scripts/sets/generate.mjs. Don't edit by hand: change the`);
lines.push(`// script's options and run it again.`);
lines.push(`//`);
lines.push(`// Source: Pokémon Showdown ${PS_VERSION} (MIT license), Random Battle sets from`);
lines.push(`// Gens 7, 8 and 9, each an equal share of a species' list (Mega and Z-Move lists`);
lines.push(`// Gen 7, Tera lists Gen 9, Pokémon Champions for Mega Meganium and Mega`);
lines.push(`// Feraligatr, hand-written for Pokémon Insurgence's Mega`);
lines.push(`// Typhlosion), and the hand-written lead sets of scripts/sets/lead-sets.mjs`);
lines.push(`// (${LEAD_SHARE * 100}% of a list). ${SAMPLES} randomSet() calls per generation, sets under`);
lines.push(`// ${MIN_SHARE * 100}% dropped, at most ${MAX_SETS} per generation.`);
lines.push(`// Gimmick sets left out (gimmickReason in the script): ${[...dropped.keys()].join('; ')}.`);
lines.push(`// ${outSets.length} sets in ${outLists.length} lists; ${pickGroups.size} species for RED's random pick.`);
lines.push(``);
lines.push(`#include "global.h"`);
lines.push(`#include "data.h"`);
lines.push(`#include "dailyred.h"`);
lines.push(`#include "constants/abilities.h"`);
lines.push(`#include "constants/items.h"`);
lines.push(`#include "constants/moves.h"`);
lines.push(`#include "constants/pokemon.h"`);
lines.push(`#include "constants/species.h"`);
lines.push(``);
lines.push(`// species, item, ability, moves, nature, EVs (HP/Atk/Def/SpA/SpD/Spe), IVs`);
lines.push(`// (same order; only Hidden Power's type uses them), Tera type, friendship,`);
lines.push(`// weight within the list, and 1 for a stall set (RED takes at most one).`);
lines.push(`#define SET(sp, it, ab, m1, m2, m3, m4, nat, evs_, ivs_, tera, fr, w, st) \\`);
lines.push(`    {.species = SPECIES_##sp, .item = ITEM_##it, .ability = ABILITY_##ab, \\`);
lines.push(`     .moves = {MOVE_##m1, MOVE_##m2, MOVE_##m3, MOVE_##m4}, .nature = NATURE_##nat, \\`);
lines.push(`     .evs = evs_, .ivs = ivs_, .teraType = TYPE_##tera, .friendship = fr, .weight = w, .stall = st}`);
lines.push(`#define EVS(hp, atk, def, spa, spd, spe) {hp, atk, def, spa, spd, spe}`);
lines.push(`#define IVS(hp, atk, def, spa, spd, spe) TRAINER_PARTY_IVS(hp, atk, def, spe, spa, spd)`);
lines.push(``);
lines.push(`const struct DailyRedSet gDailyRedSets[] =`);
lines.push(`{`);
for (const l of outLists) {
  const from = l.gens?.length === 0 ? 'hand-written' : `${(l.gens ?? [l.gen]).map((g) => (g === CHAMPIONS ? 'Champions' : `Gen ${g}`)).join(', ')}${l.tierGen === 'Insurgence' ? ` ${l.base}'s` : ''}`;
  lines.push(`    // ${l.name}, ${l.kind} (${from})`);
  for (let i = 0; i < l.numSets; i++) {
    const s = outSets[l.firstSet + i];
    const moves = [...s.moves, 'MOVE_NONE', 'MOVE_NONE', 'MOVE_NONE'].slice(0, 4).map((m) => strip('MOVE_', m));
    const fields = [strip('SPECIES_', s.species), strip('ITEM_', s.item), strip('ABILITY_', s.ability), ...moves,
      strip('NATURE_', s.nature), `EVS(${s.evs.join(', ')})`, `IVS(${s.ivs.join(', ')})`, strip('TYPE_', s.teraType), s.friendship, s.weight, s.stall ? 1 : 0];
    lines.push(`    SET(${fields.join(', ')}), // ${s.comment}`);
  }
}
lines.push(`};`);
lines.push(``);
lines.push(`#undef SET`);
lines.push(`#undef EVS`);
lines.push(`#undef IVS`);
lines.push(``);
lines.push(`// .level: the player's level for the species, from its Showdown tier (94 for`);
lines.push(`// Ubers, 95 OU, 96 UU, 97 RU, 98 NU, 99 PU and below; "BL" tiers count as the tier above).`);
lines.push(``);
lines.push(`const struct DailyRedSetList gDailyRedSetLists[] =`);
lines.push(`{`);
outLists.forEach((l, i) => {
  const tier = l.tierGen === 'Insurgence' ? `Pokémon Insurgence, ${l.tier}` : `Gen ${l.tierGen} ${l.tier}`;
  lines.push(`    [${i}] = {.species = ${l.species}, .firstSet = ${l.firstSet}, .numSets = ${l.numSets}, .kind = DAILYRED_SETS_${l.kind}, .level = ${l.level}}, // ${l.name}, ${tier}`);
});
lines.push(`};`);
lines.push(``);
lines.push(`const u16 gDailyRedNumSetLists = ARRAY_COUNT(gDailyRedSetLists);`);
lines.push(``);
lines.push(`// RED's random pick: the lists of each species, grouped (first list, count).`);
lines.push(`const struct DailyRedPickGroup gDailyRedPickGroups[] =`);
lines.push(`{`);
const pickOrder = [];
for (const [base, members] of pickGroups) {
  lines.push(`    {.first = ${pickOrder.length}, .count = ${members.length}}, // ${base}`);
  pickOrder.push(...members);
}
lines.push(`};`);
lines.push(``);
lines.push(`const u16 gDailyRedNumPickGroups = ARRAY_COUNT(gDailyRedPickGroups);`);
lines.push(``);
lines.push(`const u16 gDailyRedPickLists[] =`);
lines.push(`{`);
for (let i = 0; i < pickOrder.length; i += 12) lines.push(`    ${pickOrder.slice(i, i + 12).join(', ')},`);
lines.push(`};`);
lines.push(``);
writeFileSync(OUT, lines.join('\n'));

console.log(`Default forms used: ${[...defaultForms].map(([n, k]) => `${n} -> ${k}`).join(', ')}`);
const droppedTotal = [...dropped.values()].reduce((a, b) => a + b, 0);
console.log(`Gimmick samples dropped: ${droppedTotal} (${[...dropped].map(([r, n]) => `${r}: ${n}`).join('; ')})`
  + `${noSets.length ? `; no sets left for ${noSets.join(', ')}` : ''}.`);
const distinct = lists.filter((l) => l.sets.length).reduce((a, l) => a + l.distinct, 0);
const byGen = [...GENS, CHAMPIONS].map((g) => `${g === CHAMPIONS ? 'Champions' : `Gen ${g}`}: ${outLists.filter((l) => (l.gens ?? [l.gen]).includes(g)).length}`).join(', ');
console.log(`Wrote ${relative(process.cwd(), OUT)}: ${outSets.length} sets (of ${distinct} distinct generated) in `
  + `${outLists.length} lists (${byGen}), ${pickGroups.size} species for RED's random pick `
  + `(sampling took ${sampleSeconds.toFixed(1)}s).`);
