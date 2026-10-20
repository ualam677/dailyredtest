#!/usr/bin/env node
// Builds Daily Red's set table, expansion/src/dailyred_sets.c, from Pokémon
// Showdown's Gen 7 Random Battle generator.
//
//   cd scripts/sets && npm install && node generate.mjs
//
// For every Showdown entry (574 formes, e.g. "Charizard-Mega-X") this calls
// Showdown's own randomSet() many times, the way its Random Battle team
// builder does, and keeps every distinct set it produces with how often it
// came up. Sets are recorded twice: while a team has no Z-Move user yet, and
// once it has one (Showdown then skips "Z-Move user" roles and allows a few
// roles it otherwise skips). The ROM picks among them with those odds, so a
// species plays the way it does on Showdown, with the same variety.
//
// Everything in the ROM is level 100, so sets are generated at level 100:
// Showdown then assumes Bottle Caps for Hidden Power users. The table keeps
// the Hidden Power IVs (the type comes from the IVs in the ROM) and marks the
// stats Bottle Caps would max (hyperTrained). Each entry's Showdown level is
// kept too: it is Showdown's balancing, and Daily Red uses it to measure how
// strong a team is.
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
const { ZeroAttackHPIVs } = require('pokemon-showdown/dist/data/random-battles/gen7/teams.js');
const PS_VERSION = require('pokemon-showdown/package.json').version;

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const FORMAT = 'gen7randombattle';
const SAMPLES = Number(option('samples', 600)); // randomSet() calls per forme, per condition
const MIN_SHARE = Number(option('min-share', 0.01)); // drop sets rarer than this in both conditions
const MAX_SETS = Number(option('max-sets', 24)); // per forme, most common first
const SEED = [0x4441, 0x494c, 0x5952, 0x4544]; // "DAILYRED"
const GAME = resolve(HERE, option('game', '../../expansion'));
const OUT = resolve(HERE, option('out', join(GAME, 'src/dailyred_sets.c')));

const dex = Dex.forGen(7);
const TYPES = dex.types.names(); // Bug, Dark, Dragon, ... Water (bit order of the type masks)

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

// Abilities each species can have, from src/data/pokemon/species_info.h. Many
// species are written with macros (Arceus, Silvally, GENGAR_ABILITIES...), so
// the file goes through the C preprocessor first, with the game's own config.
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

const SPECIES_ABILITIES = new Map();
{
  const blocks = preprocess('src/data/pokemon/species_info.h').split(/\[(SPECIES_\w+)\]\s*=/);
  for (let i = 1; i < blocks.length; i += 2) {
    const names = new Set();
    const body = blocks[i + 1].split(/\n\s*\[SPECIES_/)[0];
    for (const line of body.matchAll(/\.abilities\s*=\s*\{([^}]*)\}/g)) {
      for (const a of line[1].matchAll(/ABILITY_\w+/g)) if (a[0] !== 'ABILITY_NONE') names.add(ABILITIES.get(a[0]) ?? a[0]);
    }
    SPECIES_ABILITIES.set(SPECIES.get(blocks[i]) ?? blocks[i], names);
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

// Where the expansion's name differs from Showdown's.
const SPECIES_ALIASES = {};
const ITEM_ALIASES = {};
const MOVE_ALIASES = {};
const ABILITY_ALIASES = {};

const problems = [];
function constant(table, prefix, aliases, name, what) {
  const key = aliases[name] ?? `${prefix}${toConst(name)}`;
  if (!table.has(key)) {
    problems.push(`${what} "${name}": no ${key} in the expansion`);
    return null;
  }
  return key;
}
const speciesConst = (name) => constant(SPECIES, 'SPECIES_', SPECIES_ALIASES, name, 'species');
const itemConst = (name) => (name ? constant(ITEMS, 'ITEM_', ITEM_ALIASES, name, 'item') : 'ITEM_NONE');
const abilityConst = (name) => constant(ABILITIES, 'ABILITY_', ABILITY_ALIASES, name, 'ability');
function moveConst(id) {
  if (id.startsWith('hiddenpower')) return 'MOVE_HIDDEN_POWER';
  return constant(MOVES, 'MOVE_', MOVE_ALIASES, dex.moves.get(id).name, 'move');
}

// The species to create with an ability. Some abilities live on a separate
// species in the expansion (Zygarde's Power Construct, Greninja's Battle
// Bond...): look for a forme of the same species that has it.
function speciesWithAbility(speciesKey, abilityKey) {
  const canonical = SPECIES.get(speciesKey);
  if (SPECIES_ABILITIES.get(canonical)?.has(abilityKey)) return speciesKey;
  const family = canonical.replace(/_(50|10|AVERAGE|MIDDAY|SOLO|METEOR_RED|DISGUISED|SHIELD|BAILE|M)$/, '');
  const candidates = [...SPECIES_ABILITIES].filter(([name, abilities]) => (name === family || name.startsWith(`${family}_`)) && abilities.has(abilityKey));
  candidates.sort((a, b) => a[0].length - b[0].length);
  if (candidates.length) return candidates[0][0];
  problems.push(`${speciesKey} can't have ${abilityKey} in the expansion`);
  return speciesKey;
}

// --- Showdown's team-building rules, as data -----------------------------------
// From getPokemonCompatibility() in Showdown's data/random-battles/gen7/teams.ts.

const COMPAT_LISTS = {
  DAILYRED_COMPAT_BLISSEY: ['blissey'],
  DAILYRED_COMPAT_CHANSEY: ['chansey'],
  DAILYRED_COMPAT_ILLUMISE: ['illumise'],
  DAILYRED_COMPAT_VOLBEAT: ['volbeat'],
  DAILYRED_COMPAT_WEB: ['ariados', 'shuckle', 'smeargle', 'masquerain', 'kricketune', 'leavanny', 'galvantula', 'ribombee', 'araquanid'],
  DAILYRED_COMPAT_SCREENS: ['meowstic', 'carbink', 'electrode', 'ninetalesalola'],
  DAILYRED_COMPAT_SUN_HATER: ['parasect', 'jynx', 'toxicroak', 'heliolisk'],
  DAILYRED_COMPAT_SUN: ['charizardmegay', 'ninetales', 'groudon', 'torkoal'],
  DAILYRED_COMPAT_SHEDINJA: ['shedinja'],
  DAILYRED_COMPAT_SAND_HAIL: ['tyranitar', 'tyranitarmega', 'hippowdon', 'gigalith', 'abomasnow', 'abomasnowmega', 'aurorus', 'vanilluxe', 'ninetalesalola'],
};

function formeFlags(species) {
  const flags = [];
  if (species.isMega) flags.push('DAILYRED_FORME_MEGA');
  if (dex.getEffectiveness('Fire', species) === 0 && Object.values(species.abilities).some((a) => ['Dry Skin', 'Fluffy'].includes(a))) {
    flags.push('DAILYRED_FORME_DRY_SKIN');
  }
  if (dex.getEffectiveness('Ice', species) > 0 || (dex.getEffectiveness('Ice', species) > -2 && species.types.includes('Water'))) {
    flags.push('DAILYRED_FORME_FREEZE_DRY');
  }
  for (const [flag, ids] of Object.entries(COMPAT_LISTS)) if (ids.includes(species.id)) flags.push(flag);
  return flags;
}

const typeMask = (pred) => TYPES.reduce((mask, t, i) => (pred(t) ? mask | (1 << i) : mask), 0) >>> 0;

// --- Sampling --------------------------------------------------------------------

const generator = Teams.getGenerator(FORMAT, SEED);
const showdownLevel = new Map(Object.keys(generator.randomSets).map((id) => [id, generator.randomSets[id].level]));
generator.getLevel = () => 100; // generate everything as level 100 sets

const HP_TYPE_IVS = (type, zeroAttack) => (zeroAttack ? ZeroAttackHPIVs[type] : dex.types.get(type).HPivs) ?? {};
const STAT_ORDER = ['hp', 'atk', 'def', 'spa', 'spd', 'spe']; // Showdown's order, kept in the table

// Showdown picks a random cosmetic forme for some species (Vivillon's
// patterns, Florges' colors, Minior's cores...). They battle the same, so the
// table keeps the default one.
function battleSpecies(name) {
  const species = dex.species.get(name);
  const base = dex.species.get(species.baseSpecies);
  return base.cosmeticFormes?.includes(species.name) ? base.name : species.name;
}

function canonicalSet(set) {
  const moves = [...set.moves].sort();
  const effective = { ...set.ivs }; // what the stats use (Bottle Caps at level 100)
  const real = { ...set.ivs };
  const hiddenPower = moves.find((m) => m.startsWith('hiddenpower'));
  if (hiddenPower) {
    Object.assign(real, HP_TYPE_IVS(hiddenPower.slice(11), set.ivs.atk === 0));
    // Trick Room sets keep the slowest Speed IV that still gives the type.
    if (set.ivs.spe === 0) real.spe = Math.max(0, real.spe - 30);
  }
  return {
    species: battleSpecies(set.species),
    item: set.item,
    ability: set.ability,
    moves,
    evs: STAT_ORDER.map((s) => set.evs[s]),
    ivs: STAT_ORDER.map((s) => real[s]),
    hyperTrained: STAT_ORDER.reduce((bits, s, i) => (real[s] < effective[s] ? bits | (1 << i) : bits), 0),
    friendship: moves.includes('frustration') ? 0 : 255,
  };
}

const formes = [];
const startTime = Date.now();
for (const id of Object.keys(generator.randomSets)) {
  const species = dex.species.get(id);
  const counts = new Map();
  for (const [slot, details] of [[0, {}], [1, { zMove: 1 }]]) {
    for (let i = 0; i < SAMPLES; i++) {
      let set;
      try {
        set = generator.randomSet(id, { ...details }, false);
      } catch {
        break; // no sets left in this condition (all of them are Z-Move users)
      }
      const c = canonicalSet(set);
      const key = JSON.stringify(c);
      if (!counts.has(key)) counts.set(key, { set: c, count: [0, 0], role: set.role });
      counts.get(key).count[slot]++;
    }
  }
  let sets = [...counts.values()].filter((s) => Math.max(s.count[0], s.count[1]) / SAMPLES >= MIN_SHARE);
  sets.sort((a, b) => (b.count[0] + b.count[1]) - (a.count[0] + a.count[1]) || (a.set.moves.join() < b.set.moves.join() ? -1 : 1));
  sets = sets.slice(0, MAX_SETS);
  formes.push({ id, species, sets, level: showdownLevel.get(id), totalDistinct: counts.size });
}
const sampleSeconds = (Date.now() - startTime) / 1000;

// --- Converting to the expansion's constants -----------------------------------------

const SET_FLAG_RULES = [
  ['DAILYRED_SET_STEALTH_ROCK', (s) => s.moves.includes('stealthrock')],
  ['DAILYRED_SET_SPIKES', (s) => s.moves.includes('spikes')],
  ['DAILYRED_SET_TOXIC_SPIKES', (s) => s.moves.includes('toxicspikes')],
  ['DAILYRED_SET_STICKY_WEB', (s) => s.moves.includes('stickyweb')],
  ['DAILYRED_SET_HAZARD_CLEAR', (s) => s.moves.includes('defog') || s.moves.includes('rapidspin')],
  ['DAILYRED_SET_SCREENS', (s) => s.moves.includes('auroraveil') || (s.moves.includes('reflect') && s.moves.includes('lightscreen'))],
  ['DAILYRED_SET_STATUS_CURE', (s) => s.moves.includes('healbell') || s.moves.includes('aromatherapy')],
  ['DAILYRED_SET_ILLUSION', (s) => s.ability === 'Illusion'],
  ['DAILYRED_SET_FIRE_ABILITY', (s) => ['Dry Skin', 'Fluffy'].includes(s.ability)],
];

const outSets = [];
const outFormes = [];
const groups = new Map(); // baseSpecies -> forme indices
for (const f of formes) {
  const formeConst = speciesConst(f.species.name);
  const firstSet = outSets.length;
  const scale = (n) => (n === 0 ? 0 : Math.max(1, Math.round((n * 250) / SAMPLES)));
  for (const { set, count, role } of f.sets) {
    const item = dex.items.get(set.item);
    const flags = SET_FLAG_RULES.filter(([, rule]) => rule(set)).map(([flag]) => flag);
    if (item.megaStone || f.species.name === 'Rayquaza-Mega') flags.unshift('DAILYRED_SET_MEGA');
    if (item.zMove) flags.unshift('DAILYRED_SET_ZMOVE');
    const abilityKey = abilityConst(set.ability);
    const createKey = speciesConst(set.species);
    outSets.push({
      species: createKey && abilityKey ? speciesWithAbility(createKey, abilityKey) : createKey,
      item: itemConst(set.item),
      ability: abilityKey,
      moves: set.moves.map(moveConst),
      flags,
      evs: set.evs,
      ivs: set.ivs,
      hyperTrained: set.hyperTrained,
      friendship: set.friendship,
      weightOpen: scale(count[0]),
      weightClosed: scale(count[1]),
      formeName: f.species.name,
      comment: `${role}, ${Math.round((100 * count[0]) / SAMPLES)}% / ${Math.round((100 * count[1]) / SAMPLES)}%`,
      names: set,
    });
  }
  const index = outFormes.length;
  outFormes.push({
    id: f.id,
    name: f.species.name,
    species: formeConst,
    firstSet,
    numSets: outSets.length - firstSet,
    level: f.level,
    flags: formeFlags(f.species),
    types: typeMask((t) => f.species.types.includes(t)),
    weak: typeMask((t) => dex.getEffectiveness(t, f.species) > 0),
    doubleWeak: typeMask((t) => dex.getEffectiveness(t, f.species) > 1),
  });
  const base = f.species.baseSpecies;
  if (!groups.has(base)) groups.set(base, []);
  groups.get(base).push(index);
}

// Formes are written grouped by base species, so each group is contiguous.
const orderedFormes = [];
const outGroups = [];
for (const [base, members] of groups) {
  outGroups.push({ base, firstForme: orderedFormes.length, numFormes: members.length, weight: Math.min(Math.ceil(members.length / 3), 3) });
  for (const i of members) orderedFormes.push(outFormes[i]);
}

if (problems.length) {
  console.error(`${problems.length} problem(s):\n  ${[...new Set(problems)].join('\n  ')}`);
  process.exit(1);
}

// --- Writing the C file ------------------------------------------------------------------

const hex = (n) => `0x${(n >>> 0).toString(16).toUpperCase().padStart(5, '0')}`;
const flagsExpr = (flags) => (flags.length ? flags.join(' | ') : '0');
const lines = [];
lines.push(`// Generated by scripts/sets/generate.mjs. Don't edit by hand: change the`);
lines.push(`// script's options and run it again.`);
lines.push(`//`);
lines.push(`// Source: Pokémon Showdown ${PS_VERSION} (MIT license), format ${FORMAT}:`);
lines.push(`// ${SAMPLES} randomSet() calls per forme with and without a Z-Move user on the team,`);
lines.push(`// sets under ${MIN_SHARE * 100}% in both dropped, at most ${MAX_SETS} per forme.`);
lines.push(`// ${outSets.length} sets, ${orderedFormes.length} formes, ${outGroups.length} species.`);
lines.push(`//`);
lines.push(`// Type masks: bit i is ${TYPES.map((t, i) => `${i} ${t}`).join(', ')}.`);
lines.push(``);
lines.push(`#include "global.h"`);
lines.push(`#include "dailyred.h"`);
lines.push(`#include "constants/abilities.h"`);
lines.push(`#include "constants/items.h"`);
lines.push(`#include "constants/moves.h"`);
lines.push(`#include "constants/species.h"`);
lines.push(``);
lines.push(`const u8 gDailyRedNumTypes = ${TYPES.length};`);
lines.push(`const u16 gDailyRedNumSets = ${outSets.length};`);
lines.push(`const u16 gDailyRedNumFormes = ${orderedFormes.length};`);
lines.push(`const u16 gDailyRedNumGroups = ${outGroups.length};`);
lines.push(``);

// Sets are renumbered in forme order.
const setOrder = [];
const firstSetOf = new Map();
for (const f of orderedFormes) {
  firstSetOf.set(f.id, setOrder.length);
  for (let i = 0; i < f.numSets; i++) setOrder.push(outSets[f.firstSet + i]);
}

const strip = (prefix, name) => name.slice(prefix.length);
const shortFlags = (flags) => (flags.length ? flags.map((f) => strip('DAILYRED_SET_', f)).join(' | ') : '0');
lines.push(`// One line per set: species, item, ability, moves, flags, EVs and IVs`);
lines.push(`// (HP/Atk/Def/SpA/SpD/Spe), stats maxed with Bottle Caps, friendship, and its`);
lines.push(`// weight while the team has no Z-Move user / once it has one.`);
lines.push(`#define SET(sp, it, ab, m1, m2, m3, m4, fl, evs_, ivs_, ht, fr, wOpen, wClosed) \\`);
lines.push(`    {.species = SPECIES_##sp, .item = ITEM_##it, .ability = ABILITY_##ab, \\`);
lines.push(`     .moves = {MOVE_##m1, MOVE_##m2, MOVE_##m3, MOVE_##m4}, .flags = (fl), \\`);
lines.push(`     .evs = evs_, .ivs = ivs_, .hyperTrained = ht, .friendship = fr, .weightOpen = wOpen, .weightClosed = wClosed}`);
lines.push(`#define STATS(hp, atk, def, spa, spd, spe) {hp, atk, def, spa, spd, spe}`);
for (const [flag] of [['DAILYRED_SET_MEGA'], ['DAILYRED_SET_ZMOVE'], ...SET_FLAG_RULES]) {
  lines.push(`#define ${strip('DAILYRED_SET_', flag)} ${flag}`);
}
lines.push(``);
lines.push(`const struct DailyRedSet gDailyRedSets[] =`);
lines.push(`{`);
let lastForme = null;
setOrder.forEach((s) => {
  const forme = s.formeName;
  if (forme !== lastForme) {
    const f = orderedFormes.find((x) => x.name === forme);
    lines.push(`    // ${forme} (Showdown level ${f.level})`);
    lastForme = forme;
  }
  const moves = [...s.moves, 'MOVE_NONE', 'MOVE_NONE', 'MOVE_NONE'].slice(0, 4).map((m) => strip('MOVE_', m));
  const fields = [strip('SPECIES_', s.species), strip('ITEM_', s.item), strip('ABILITY_', s.ability), ...moves, shortFlags(s.flags),
    `STATS(${s.evs.join(', ')})`, `STATS(${s.ivs.join(', ')})`, s.hyperTrained, s.friendship, s.weightOpen, s.weightClosed];
  lines.push(`    SET(${fields.join(', ')}), // ${s.comment}`);
});
lines.push(`};`);
lines.push(``);
lines.push(`#undef SET`);
lines.push(`#undef STATS`);
for (const [flag] of [['DAILYRED_SET_MEGA'], ['DAILYRED_SET_ZMOVE'], ...SET_FLAG_RULES]) lines.push(`#undef ${strip('DAILYRED_SET_', flag)}`);
lines.push(``);
lines.push(`const struct DailyRedForme gDailyRedFormes[] =`);
lines.push(`{`);
orderedFormes.forEach((f, i) => {
  lines.push(`    [${i}] = { .species = ${f.species}, .firstSet = ${firstSetOf.get(f.id)}, .numSets = ${f.numSets}, .level = ${f.level}, // ${f.name}`);
  lines.push(`              .flags = ${flagsExpr(f.flags)}, .types = ${hex(f.types)}, .weak = ${hex(f.weak)}, .doubleWeak = ${hex(f.doubleWeak)} },`);
});
lines.push(`};`);
lines.push(``);
lines.push(`const struct DailyRedGroup gDailyRedGroups[] =`);
lines.push(`{`);
outGroups.forEach((g, i) => lines.push(`    [${i}] = { .firstForme = ${g.firstForme}, .numFormes = ${g.numFormes}, .weight = ${g.weight} }, // ${g.base}`));
lines.push(`};`);
lines.push(``);
writeFileSync(OUT, lines.join('\n'));

const distinct = formes.reduce((a, f) => a + f.totalDistinct, 0);
console.log(`Wrote ${relative(process.cwd(), OUT)}: ${outSets.length} sets (of ${distinct} distinct generated), `
  + `${orderedFormes.length} formes, ${outGroups.length} species (sampling took ${sampleSeconds.toFixed(1)}s).`);
