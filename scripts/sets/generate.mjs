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
// Which generation's sets a species uses: Gen 7 Random Battles first (the last
// generation with Mega Evolution and Z-Moves); species Gen 7 doesn't have
// (Gen 8+ species and forms, e.g. Galarian Moltres) come from Gen 8, then Gen 9.
//
// The table has one list of sets per species and kind (DAILYRED_SETS_*):
//   NORMAL  no Z-Crystal and no Mega Stone (Showdown's sets for a team that
//           already has its Z-Move user). Every species has one.
//   MEGA    the sets of a Mega Evolution (Charizard-Mega-X...): the species to
//           create is the base form, holding the stone.
//   ZMOVE   Z-Crystals allowed (Showdown's odds), for RED's legendaries. The
//           Kanto starters' ZMOVE lists always hold a Z-Crystal: when the set
//           has none, the one for its strongest STAB type.
//   TERA    Gen 9 sets with their Tera type, for the Kanto starters.
//
// The ROM gives every Pokemon perfect stats (all IVs maxed by hyper training),
// so the IVs in the table only decide Hidden Power's type. Natures and EVs are
// the set's.
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
const MAX_SETS = Number(option('max-sets', 10)); // per list, most common first
const SEED = [0x4441, 0x494c, 0x5952, 0x4544]; // "DAILYRED"
const GAME = resolve(HERE, option('game', '../../expansion'));
const OUT = resolve(HERE, option('out', join(GAME, 'src/dailyred_sets.c')));

const GENS = [7, 8, 9];
const generators = new Map(GENS.map((gen) => [gen, Teams.getGenerator(`gen${gen}randombattle`, SEED)]));
const dexes = new Map(GENS.map((gen) => [gen, Dex.forGen(gen)]));
const entriesOf = (gen) => Object.keys(generators.get(gen).randomSets);
// Pokemon Champions' Random Battles: the only sets for the Megas added after
// Gen 7 (Mega Meganium, Mega Feraligatr). Its stat points become EVs below.
const CHAMPIONS = 'champions';
generators.set(CHAMPIONS, Teams.getGenerator('gen9championsrandombattle', SEED));
dexes.set(CHAMPIONS, Dex.forGen(9));

// RED's legendaries: their sets may hold a Z-Crystal (see dailyred_red.c).
const RED_LEGENDARIES = ['articuno', 'zapdos', 'moltres', 'raikou', 'entei', 'suicune', 'mewtwo', 'mew',
  'deoxys', 'deoxysattack', 'deoxysdefense', 'deoxysspeed'];
const KANTO_STARTERS = ['venusaur', 'charizard', 'blastoise'];
// The player's starter, picked to counter RED's (see dailyred_team.c): Megas
// with their stone, and Typhlosion (no Mega) with a Firium Z.
const LATER_MEGAS = ['meganiummega', 'feraligatrmega'];
const Z_STARTERS = ['typhlosion'];

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
const covered = new Set(); // Showdown species ids that already have a NORMAL list
for (const gen of GENS) {
  const dex = dexes.get(gen);
  for (const id of entriesOf(gen)) {
    const species = dex.species.get(id);
    if (gen > 7 && species.name.endsWith('-Gmax')) continue; // no Dynamax in Daily Red
    if (species.isMega || species.isPrimal) {
      if (gen === 7) lists.push({ id, gen, kind: 'MEGA', species, details: {} });
      continue;
    }
    if (covered.has(species.id)) continue;
    // Gen 8 species whose only sets are built for Dynamax: Gen 9's sets if it
    // has the species, otherwise those (as plain sets: their moves are fine
    // without Dynamax).
    const onlyDynamax = generators.get(gen).randomSets[id].sets?.every((st) => st.role === 'Dynamax User');
    if (onlyDynamax && gen < 9 && entriesOf(9).includes(id)) continue;
    covered.add(species.id);
    lists.push({ id, gen, kind: 'NORMAL', species, details: { zMove: 1 }, allowDynamaxSets: onlyDynamax });
  }
}
for (const id of RED_LEGENDARIES) lists.push({ id, gen: 7, kind: 'ZMOVE', species: dexes.get(7).species.get(id), details: {} });
for (const id of KANTO_STARTERS) {
  lists.push({ id, gen: 7, kind: 'ZMOVE', species: dexes.get(7).species.get(id), details: {}, forceZ: true });
  lists.push({ id, gen: 9, kind: 'TERA', species: dexes.get(9).species.get(id), details: {} });
}
for (const id of LATER_MEGAS) lists.push({ id, gen: CHAMPIONS, kind: 'MEGA', species: Dex.species.get(id), details: {} });
for (const id of Z_STARTERS) lists.push({ id, gen: 7, kind: 'ZMOVE', species: dexes.get(7).species.get(id), details: {}, forceZ: true });

// The player's level for each species, from its Gen 7 Showdown tier (Gen 8,
// then Gen 9, for species Gen 7 doesn't have): the stronger the tier, the
// lower the level. A "BL" tier (banned to the tier above) counts as the tier
// above.
const TIER_LEVELS = [
  [['AG', 'Uber', '(Uber)', 'OU', '(OU)', 'UUBL'], 95],
  [['UU', '(UU)', 'RUBL'], 96],
  [['RU', '(RU)', 'NUBL'], 97],
];
const LOWEST_TIER_LEVEL = 98; // NU and below (PUBL counts as NU's "tier above" but stays here)
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

// RED's random pick from any generation: fully evolved, not a starter (nor
// Pikachu's family), legendary, mythical, Ultra Beast or Paradox Pokemon.
// Judged with the latest generation's data, so a Pokemon that gained an
// evolution later (Scyther, Ursaring...) counts as not fully evolved.
function isRandomPick(list) {
  if (list.kind !== 'NORMAL') return false;
  const dex = Dex;
  const species = Dex.species.get(list.species.name);
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

// RED's Pikachu always holds a Light Ball and knows Volt Tackle (in place of
// its other Electric attack, or its last move).
function forcePikachu(dex, set) {
  if (set.species !== 'Pikachu') return set;
  const moves = [...set.moves];
  if (!moves.includes('volttackle')) {
    const electric = moves.findIndex((m) => dex.moves.get(m).type === 'Electric' && dex.moves.get(m).category !== 'Status');
    moves[electric >= 0 ? electric : moves.length - 1] = 'volttackle';
  }
  return { ...set, item: 'Light Ball', moves };
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

// Champions sets have stat points (up to 32 per stat), not EVs: every stat
// with points gets 85 EVs, as in the other generations' sets.
function championsEVs(set) {
  return { ...set, evs: Object.fromEntries(Object.entries(set.evs).map(([stat, points]) => [stat, points > 0 ? 85 : 0])) };
}

const startTime = Date.now();
for (const list of lists) {
  const generator = generators.get(list.gen);
  const dex = dexes.get(list.gen);
  const counts = new Map();
  for (let i = 0; i < SAMPLES; i++) {
    let set = generator.randomSet(list.id, { ...list.details }, false);
    if (list.gen === CHAMPIONS) set = championsEVs(set);
    const reason = gimmickReason(dex, list, set);
    if (reason) {
      dropped.set(reason, (dropped.get(reason) ?? 0) + 1);
      continue;
    }
    if (list.forceZ) set = addZCrystal(dex, set);
    set = forcePikachu(dex, set);
    const item = dex.items.get(set.item);
    if (list.kind === 'NORMAL' && (item.zMove || item.megaStone)) throw new Error(`${list.id}: NORMAL set holds ${set.item}`);
    if (list.kind !== 'TERA') set = { ...set, teraType: undefined };
    const c = canonicalSet(dex, set);
    const key = JSON.stringify(c);
    if (!counts.has(key)) counts.set(key, { set: c, count: 0, role: set.role });
    counts.get(key).count++;
  }
  let sets = [...counts.values()];
  const total = sets.reduce((n, s) => n + s.count, 0);
  if (!total) {
    // Every set is a gimmick one (Magikarp's Splash...): no list, so no team uses the species.
    if (list.kind !== 'NORMAL' || RED_LEGENDARIES.includes(list.id) || KANTO_STARTERS.includes(list.id)) {
      throw new Error(`${list.id} (Gen ${list.gen}, ${list.kind}) has no sets left`);
    }
    list.sets = [];
    continue;
  }
  sets = sets.filter((s) => s.count / total >= MIN_SHARE);
  if (!sets.length) sets = [...counts.values()]; // every set is rare: keep them all
  sets.sort((a, b) => b.count - a.count || (a.set.moves.join() < b.set.moves.join() ? -1 : 1));
  list.sets = sets.slice(0, MAX_SETS);
  list.total = total;
  list.distinct = counts.size;
}
const sampleSeconds = (Date.now() - startTime) / 1000;

// --- Converting to the expansion's constants -----------------------------------------

const outLists = [];
const outSets = [];
const noSets = lists.filter((l) => !l.sets.length).map((l) => l.species.name);
for (const list of lists.filter((l) => l.sets.length)) {
  const dex = dexes.get(list.gen);
  const key = speciesConst(list.species.name);
  const firstSet = outSets.length;
  const maxCount = Math.max(...list.sets.map((s) => s.count));
  for (const { set, count, role } of list.sets) {
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
      weight: Math.max(1, Math.round((count * 255) / maxCount)),
      comment: `${role ? `${role}, ` : ''}${Math.round((100 * count) / list.total)}%`,
    });
  }
  outLists.push({
    name: list.species.name,
    gen: list.gen,
    kind: list.kind,
    species: key,
    base: list.species.baseSpecies,
    firstSet,
    numSets: outSets.length - firstSet,
    randomPick: isRandomPick(list) && !SPECIES_SPECIAL.has(SPECIES.get(key)),
    ...(() => {
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
lines.push(`// Gen 7 (Gen 8, then Gen 9, for species Gen 7 doesn't have; Pokémon Champions for`);
lines.push(`// Mega Meganium and Mega Feraligatr). ${SAMPLES} randomSet()`);
lines.push(`// calls per list, sets under ${MIN_SHARE * 100}% dropped, at most ${MAX_SETS} per list.`);
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
lines.push(`// weight within the list.`);
lines.push(`#define SET(sp, it, ab, m1, m2, m3, m4, nat, evs_, ivs_, tera, fr, w) \\`);
lines.push(`    {.species = SPECIES_##sp, .item = ITEM_##it, .ability = ABILITY_##ab, \\`);
lines.push(`     .moves = {MOVE_##m1, MOVE_##m2, MOVE_##m3, MOVE_##m4}, .nature = NATURE_##nat, \\`);
lines.push(`     .evs = evs_, .ivs = ivs_, .teraType = TYPE_##tera, .friendship = fr, .weight = w}`);
lines.push(`#define EVS(hp, atk, def, spa, spd, spe) {hp, atk, def, spa, spd, spe}`);
lines.push(`#define IVS(hp, atk, def, spa, spd, spe) TRAINER_PARTY_IVS(hp, atk, def, spe, spa, spd)`);
lines.push(``);
lines.push(`const struct DailyRedSet gDailyRedSets[] =`);
lines.push(`{`);
for (const l of outLists) {
  lines.push(`    // ${l.name}, ${l.kind} (${l.gen === CHAMPIONS ? 'Champions' : `Gen ${l.gen}`})`);
  for (let i = 0; i < l.numSets; i++) {
    const s = outSets[l.firstSet + i];
    const moves = [...s.moves, 'MOVE_NONE', 'MOVE_NONE', 'MOVE_NONE'].slice(0, 4).map((m) => strip('MOVE_', m));
    const fields = [strip('SPECIES_', s.species), strip('ITEM_', s.item), strip('ABILITY_', s.ability), ...moves,
      strip('NATURE_', s.nature), `EVS(${s.evs.join(', ')})`, `IVS(${s.ivs.join(', ')})`, strip('TYPE_', s.teraType), s.friendship, s.weight];
    lines.push(`    SET(${fields.join(', ')}), // ${s.comment}`);
  }
}
lines.push(`};`);
lines.push(``);
lines.push(`#undef SET`);
lines.push(`#undef EVS`);
lines.push(`#undef IVS`);
lines.push(``);
lines.push(`// .level: the player's level for the species, from its Showdown tier (95 for`);
lines.push(`// OU and up, 96 UU, 97 RU, 98 NU and below; "BL" tiers count as the tier above).`);
lines.push(``);
lines.push(`const struct DailyRedSetList gDailyRedSetLists[] =`);
lines.push(`{`);
outLists.forEach((l, i) => {
  lines.push(`    [${i}] = {.species = ${l.species}, .firstSet = ${l.firstSet}, .numSets = ${l.numSets}, .kind = DAILYRED_SETS_${l.kind}, .level = ${l.level}}, // ${l.name}, Gen ${l.tierGen} ${l.tier}`);
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
const byGen = [...GENS, CHAMPIONS].map((g) => `${g === CHAMPIONS ? 'Champions' : `Gen ${g}`}: ${outLists.filter((l) => l.gen === g).length}`).join(', ');
console.log(`Wrote ${relative(process.cwd(), OUT)}: ${outSets.length} sets (of ${distinct} distinct generated) in `
  + `${outLists.length} lists (${byGen}), ${pickGroups.size} species for RED's random pick `
  + `(sampling took ${sampleSeconds.toFixed(1)}s).`);
