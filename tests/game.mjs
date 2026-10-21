// What the tests know about the game, taken from the build itself instead of
// being written out again here:
//   - constants (species, moves, items, abilities, types, move effects, hold
//     effects and a few named ones) with the values the compiler gives them;
//   - struct layouts (offsets, sizes and bitfields) for reading RAM out of
//     save states and tables out of the ROM;
//   - the ROM's data tables: species (base stats, types, abilities, names,
//     learnsets, evolutions, form changes), moves, items and TMs/HMs.
//
// Constants and layouts come from compiling a small generated C file against
// expansion/include with the project toolchain. The result is cached in
// tests/output/.cache/ and rebuilt whenever the ELF changes.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const GAME_DIR = join(ROOT, 'expansion');
export const ELF = join(GAME_DIR, 'pokefirered.elf');
export const ROM = join(GAME_DIR, 'pokefirered.gba');
const CACHE_DIR = join(ROOT, 'tests/output/.cache');

export function tool(name) {
  const local = join(ROOT, `.toolchain/arm-none-eabi/bin/arm-none-eabi-${name}`);
  return existsSync(local) ? local : `arm-none-eabi-${name}`;
}

// The same preprocessor flags as the expansion Makefile's FireRed build.
const CPPFLAGS = ['-iquote', 'include', '-Wno-trigraphs', '-DMODERN=1', '-DTESTING=0', '-DFIRERED', '-std=gnu17'];
const CFLAGS = ['-mthumb', '-mthumb-interwork', '-mabi=apcs-gnu', '-mtune=arm7tdmi', '-march=armv4t', '-O0', '-fdata-sections', '-w'];

// Enums whose enumerators the tests can look up by name (and back).
const ENUMS = {
  SPECIES: 'Species',
  MOVE: 'Move',
  ITEM: 'Item',
  ABILITY: 'Ability',
  TYPE: 'Type',
  EFFECT: 'BattleMoveEffects',
  HOLD_EFFECT: 'HoldEffect',
  CATEGORY: 'DamageCategory',
  FORM_CHANGE: 'FormChanges',
  TRAINER_CLASS: 'TrainerClassID',
};

// Single values (macros or enumerators) the tests use.
const NAMED = [
  'MAX_LEVEL', 'PARTY_SIZE', 'MAX_MON_MOVES', 'NUM_STATS', 'POKEMON_NAME_LENGTH', 'NUM_ALL_MACHINES',
  'MOVE_UNAVAILABLE', 'LEVEL_UP_MOVE_END', 'EVOLUTIONS_END', 'NUMBER_OF_MON_TYPES', 'NUM_SPECIES', 'MOVES_COUNT', 'ITEMS_COUNT',
  'B_TRAINER_PLAYER', 'B_TRAINER_OPPONENT_A', 'B_OUTCOME_WON', 'B_OUTCOME_LOST',
  'VARS_START', 'VAR_DAILYRED_BATTLES', 'VAR_DAILYRED_WINS',
  'BATTLE_ENVIRONMENT_MOUNTAIN', 'OPTIONS_BATTLE_STYLE_SET', 'LOCALID_DAILYRED_RED', 'DIR_NORTH',
  'DAILYRED_START_X', 'DAILYRED_START_Y', 'TRAINER_DAILYRED_RED', 'METLOC_FATEFUL_ENCOUNTER', 'SHINY_ODDS',
  'MAP_OFFSET', 'OBJECT_EVENTS_COUNT', 'MAX_BATTLERS_COUNT', 'MUS_DAILYRED_VS_RED', 'MUS_RG_VS_CHAMPION', 'TRAINER_CLASS_DAILYRED',
  'B_AFFECTION_MECHANICS', 'B_FRIENDSHIP_BOOST', 'MAX_FRIENDSHIP', 'AFFECTION_FIVE_HEARTS', 'POCKET_KEY_ITEMS',
  'TYPE_NONE', 'TYPE_MYSTERY', 'MON_MALE', 'MON_FEMALE', 'MON_GENDERLESS',
  'DAILYRED_SETS_NORMAL', 'DAILYRED_SETS_MEGA', 'DAILYRED_SETS_ZMOVE', 'DAILYRED_SETS_TERA',
  'TRAINERS_COUNT', 'DIFFICULTY_NORMAL', 'MUGSHOT_COLOR_YELLOW', 'MUGSHOT_COLOR_RED', 'B_TRANSITION_MUGSHOT',
  'GIMMICKS_COUNT', 'GIMMICK_MEGA', 'GIMMICK_Z_MOVE', 'GIMMICK_DYNAMAX', 'GIMMICK_TERA',
  'BATTLE_ENVIRONMENT_SNOW', 'TRAINER_PIC_DAILYRED_RED', 'TRAINER_PIC_DAILYRED_LEAF',
];

// 64-bit values (AI flags), read as BigInt with wideValue().
const WIDE = ['AI_FLAG_SMART_TRAINER', 'AI_FLAG_PREDICTION', 'AI_FLAG_SMART_TERA'];

// Struct members to measure: plain members get an offset and a size,
// bitfields (bits) a bit position and width.
const STRUCTS = {
  Pokemon: { type: 'struct Pokemon', fields: ['box', 'status', 'level', 'hp', 'maxHP', 'attack', 'defense', 'speed', 'spAttack', 'spDefense'] },
  BoxPokemon: {
    type: 'struct BoxPokemon', fields: ['personality', 'otId', 'nickname[]', 'otName[]', 'checksum', 'secure'],
    bits: ['hiddenNatureModifier', 'shinyModifier', 'hpLost', 'isEgg', 'hasSpecies', 'isBadEgg'],
  },
  PokemonSubstruct0: { type: 'struct PokemonSubstruct0', fields: ['ppBonuses', 'friendship'], bits: ['species', 'teraType', 'heldItem', 'experience', 'pokeball'] },
  PokemonSubstruct1: {
    type: 'struct PokemonSubstruct1',
    bits: ['move1', 'move2', 'move3', 'move4', 'pp1', 'pp2', 'pp3', 'pp4', 'hyperTrainedHP', 'hyperTrainedAttack',
      'hyperTrainedDefense', 'hyperTrainedSpeed', 'hyperTrainedSpAttack', 'hyperTrainedSpDefense'],
  },
  PokemonSubstruct2: { type: 'struct PokemonSubstruct2', fields: ['hpEV', 'attackEV', 'defenseEV', 'speedEV', 'spAttackEV', 'spDefenseEV'] },
  PokemonSubstruct3: {
    type: 'struct PokemonSubstruct3', fields: ['metLocation'],
    bits: ['metLevel', 'hpIV', 'attackIV', 'defenseIV', 'speedIV', 'spAttackIV', 'spDefenseIV', 'isEgg', 'abilityNum', 'modernFatefulEncounter'],
  },
  BattlePokemon: {
    type: 'struct BattlePokemon',
    fields: ['species', 'attack', 'defense', 'speed', 'spAttack', 'spDefense', 'moves[]', 'statStages[]', 'ability', 'types[]', 'pp[]', 'hp',
      'level', 'friendship', 'maxHP', 'item', 'personality', 'status1', 'otId', 'affectionHearts'],
  },
  SpeciesInfo: {
    type: 'struct SpeciesInfo',
    fields: ['baseHP', 'baseAttack', 'baseDefense', 'baseSpeed', 'baseSpAttack', 'baseSpDefense', 'types[]', 'genderRatio', 'friendship',
      'abilities[]', 'speciesName[]', 'levelUpLearnset', 'teachableLearnset', 'evolutions', 'formSpeciesIdTable', 'formChangeTable'],
    bits: ['natDexNum', 'isRestrictedLegendary', 'isSubLegendary', 'isMythical', 'isUltraBeast', 'isParadox', 'isTotem',
      'isMegaEvolution', 'isPrimalReversion', 'isUltraBurst', 'isGigantamax', 'isTeraForm', 'isAlolanForm', 'isGalarianForm',
      'isHisuianForm', 'isPaldeanForm'],
  },
  LevelUpMove: { type: 'struct LevelUpMove', fields: ['move', 'level'] },
  Evolution: { type: 'struct Evolution', fields: ['method', 'param', 'targetSpecies', 'params'] },
  FormChange: { type: 'struct FormChange', fields: ['targetSpecies', 'param1', 'param2', 'param3', 'param4'], bits: ['method'] },
  MoveInfo: { type: 'struct MoveInfo', fields: ['name', 'pp'], bits: ['effect', 'type', 'category', 'power', 'accuracy', 'priority'] },
  ItemInfo: { type: 'struct ItemInfo', fields: ['name', 'holdEffect', 'holdEffectParam', 'secondaryId'] },
  TmHmIndexKey: { type: 'struct TmHmIndexKey', fields: ['itemId', 'moveId'] },
  Main: { type: 'struct Main', fields: ['callback1', 'callback2'] },
  PlayerAvatar: { type: 'struct PlayerAvatar', fields: ['objectEventId'] },
  ObjectEvent: { type: 'struct ObjectEvent', fields: ['localId', 'currentCoords'], bits: ['active', 'facingDirection'] },
  SaveBlock1: { type: 'struct SaveBlock1', fields: ['vars[]', 'location', 'bag.keyItems[]'] },
  SaveBlock2: { type: 'struct SaveBlock2', bits: ['optionsBattleStyle', 'optionsTextSpeed', 'optionsBattleSceneOff'] },
  ItemSlot: { type: 'struct ItemSlot', fields: ['itemId', 'quantity'] },
  BattleScripting: { type: 'struct BattleScripting', fields: ['battleStyle'] },
  TrainerBattleParameter: { type: 'TrainerBattleParameter', fields: ['params.opponentA'] },
  MusicPlayerInfo: { type: 'struct MusicPlayerInfo', fields: ['songHeader', 'status'] },
  Song: { type: 'struct Song', fields: ['header', 'ms', 'me'] },
  DailyRedSet: {
    type: 'struct DailyRedSet',
    fields: ['ivs', 'species', 'item', 'ability', 'moves[]', 'evs[]', 'nature', 'teraType', 'friendship', 'weight'],
  },
  DailyRedSetList: { type: 'struct DailyRedSetList', fields: ['species', 'firstSet', 'numSets', 'kind', 'level'] },
  DailyRedPickGroup: { type: 'struct DailyRedPickGroup', fields: ['first', 'count'] },
  BattleStruct: { type: 'struct BattleStruct', fields: ['gimmick.activated[]'] },
  AiThinkingStruct: { type: 'struct AiThinkingStruct', fields: ['aiFlags[]'] },
  Trainer: { type: 'struct Trainer', fields: ['aiFlags', 'party', 'trainerClass', 'trainerPic'], bits: ['partySize', 'mugshotColor'] },
  BattleEnvironment: { type: 'struct BattleEnvironment', fields: ['background.tileset', 'background.tilemap', 'palette'] },
};

const HEADERS = [
  'global.h', 'gba/m4a_internal.h', 'main.h', 'battle.h', 'battle_setup.h', 'dailyred.h', 'data.h', 'battle_gimmick.h', 'battle_transition.h', 'battle_environment.h', 'constants/battle_ai.h', 'event_object_movement.h', 'fieldmap.h', 'item.h', 'move.h', 'pokemon.h',
  'constants/abilities.h', 'constants/battle.h', 'constants/battle_move_effects.h', 'constants/dailyred.h', 'constants/event_objects.h',
  'constants/form_change_types.h', 'constants/global.h', 'constants/hold_effects.h', 'constants/items.h', 'constants/map_event_ids.h',
  'constants/moves.h', 'constants/opponents.h', 'constants/pokemon.h', 'constants/region_map_sections.h', 'constants/species.h',
  'constants/songs.h', 'constants/trainers.h', 'constants/vars.h',
];

// --- Building the info ----------------------------------------------------------

// Enumerator names of `enum <name> { ... }` in preprocessed C, in order.
function enumerators(text, name) {
  const head = new RegExp(`\\benum\\s+(?:__attribute__\\s*\\(\\(\\s*\\w+\\s*\\)\\)\\s*)?${name}\\s*\\{`, 'g');
  const m = head.exec(text);
  if (!m) throw new Error(`enum ${name} not found`);
  let depth = 1, i = head.lastIndex;
  const start = i;
  for (; depth; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth--;
  }
  const body = text.slice(start, i - 1);
  const names = [];
  let paren = 0, item = '';
  for (const ch of body + ',') {
    if (ch === '(') paren++;
    if (ch === ')') paren--;
    if (ch === ',' && paren === 0) {
      const id = item.trim().match(/^([A-Za-z_]\w*)/);
      if (id) names.push(id[1]);
      item = '';
    } else item += ch;
  }
  return names;
}

function generateSource(enumNames) {
  const lines = HEADERS.map((h) => `#include "${h}"`);
  lines.push('#define DRT_VALUE(name, expr) const s32 DRT_v_##name __attribute__((used)) = (expr);');
  for (const name of NAMED) lines.push(`DRT_VALUE(${name}, ${name})`);
  for (const name of WIDE) lines.push(`const u64 DRT_w_${name} __attribute__((used)) = (${name});`);
  for (const [key, spec] of Object.entries(STRUCTS)) {
    lines.push(`DRT_VALUE(${key}__size, sizeof(${spec.type}))`);
    for (const spelled of spec.fields ?? []) {
      // "name[]" marks an array member, measured per element too.
      const f = spelled.replace('[]', '');
      const id = f.replace(/\./g, '_');
      lines.push(`DRT_VALUE(${key}_${id}__off, offsetof(${spec.type}, ${f}))`);
      lines.push(`DRT_VALUE(${key}_${id}__size, sizeof(((${spec.type} *)0)->${f}))`);
      const elem = spelled.endsWith('[]') ? `sizeof(((${spec.type} *)0)->${f}[0])` : `sizeof(((${spec.type} *)0)->${f})`;
      lines.push(`DRT_VALUE(${key}_${id}__elem, ${elem})`);
    }
    // A bitfield's place: set it to all ones in an otherwise empty struct.
    for (const f of spec.bits ?? []) lines.push(`const ${spec.type} DRT_b_${key}_${f} __attribute__((used)) = { .${f} = -1 };`);
  }
  for (const [key, names] of Object.entries(enumNames)) {
    lines.push(`const s32 DRT_e_${key}[] __attribute__((used)) = {`);
    for (const n of names) lines.push(`    ${n},`);
    lines.push('};');
  }
  return lines.join('\n') + '\n';
}

// Section contents of an object file, from `objdump -s`.
function sections(objFile) {
  const out = execFileSync(tool('objdump'), ['-s', objFile], { encoding: 'utf8', maxBuffer: 256 << 20 });
  const result = new Map();
  let current = null;
  for (const line of out.split('\n')) {
    const head = line.match(/^Contents of section (\S+):/);
    if (head) { current = []; result.set(head[1], current); continue; }
    const data = current && line.match(/^ ([0-9a-f]+) (.{35})/);
    if (data) for (const hex of data[2].replace(/ /g, '').match(/../g) ?? []) current.push(parseInt(hex, 16));
  }
  return new Map([...result].map(([k, v]) => [k, Buffer.from(v)]));
}

function bitRange(bytes) {
  let lo = -1, hi = -1;
  for (let i = 0; i < bytes.length * 8; i++) {
    if (bytes[i >> 3] & (1 << (i & 7))) { if (lo < 0) lo = i; hi = i; }
  }
  if (lo < 0) throw new Error('bitfield not found');
  return { bit: lo, width: hi - lo + 1 };
}

function build() {
  mkdirSync(CACHE_DIR, { recursive: true });
  const pre = join(CACHE_DIR, 'enums.c');
  writeFileSync(pre, HEADERS.map((h) => `#include "${h}"`).join('\n') + '\n');
  const text = execFileSync(tool('cpp'), [...CPPFLAGS, '-P', pre], { cwd: GAME_DIR, encoding: 'utf8', maxBuffer: 256 << 20 });
  const enumNames = Object.fromEntries(Object.entries(ENUMS).map(([key, name]) => [key, enumerators(text, name)]));

  const src = join(CACHE_DIR, 'game-info.c');
  const obj = join(CACHE_DIR, 'game-info.o');
  writeFileSync(src, generateSource(enumNames));
  execFileSync(tool('gcc'), [...CPPFLAGS, ...CFLAGS, '-c', src, '-o', obj], { cwd: GAME_DIR, stdio: ['ignore', 'ignore', 'inherit'] });
  const secs = sections(obj);
  const section = (sym) => {
    const s = secs.get(`.rodata.${sym}`);
    if (!s) throw new Error(`section for ${sym} missing`);
    return s;
  };

  const values = {};
  for (const name of NAMED) values[name] = section(`DRT_v_${name}`).readInt32LE(0);
  const wide = {};
  for (const name of WIDE) wide[name] = section(`DRT_w_${name}`).readBigUInt64LE(0).toString();
  const layout = {};
  for (const [key, spec] of Object.entries(STRUCTS)) {
    const s = { size: section(`DRT_v_${key}__size`).readInt32LE(0) };
    for (const spelled of spec.fields ?? []) {
      const id = spelled.replace('[]', '').replace(/\./g, '_');
      const size = section(`DRT_v_${key}_${id}__size`).readInt32LE(0);
      const elemSize = section(`DRT_v_${key}_${id}__elem`).readInt32LE(0);
      s[id] = { off: section(`DRT_v_${key}_${id}__off`).readInt32LE(0), size, elemSize, array: spelled.endsWith('[]'), count: size / elemSize };
    }
    for (const f of spec.bits ?? []) s[f] = bitRange(section(`DRT_b_${key}_${f}`));
    layout[key] = s;
  }
  const enums = {};
  for (const [key, names] of Object.entries(enumNames)) {
    const data = section(`DRT_e_${key}`);
    enums[key] = Object.fromEntries(names.map((n, i) => [n, data.readInt32LE(i * 4)]));
  }
  return { values, wide, layout, enums };
}

let infoCache;
export function info() {
  if (infoCache) return infoCache;
  if (!existsSync(ELF)) throw new Error(`${ELF} not found: build the ROM first (scripts/build-rom.sh)`);
  const st = statSync(ELF);
  const key = createHash('sha1').update(`${st.size}:${st.mtimeMs}:`).update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
  const file = join(CACHE_DIR, 'game-info.json');
  if (existsSync(file)) {
    const cached = JSON.parse(readFileSync(file, 'utf8'));
    if (cached.key === key) return (infoCache = cached);
  }
  infoCache = { key, ...build() };
  writeFileSync(file, JSON.stringify(infoCache));
  return infoCache;
}

export const value = (name) => {
  const v = info().values[name];
  if (v === undefined) throw new Error(`no value ${name} (add it to NAMED in game.mjs)`);
  return v;
};
export const wideValue = (name) => {
  const v = info().wide[name];
  if (v === undefined) throw new Error(`no wide value ${name} (add it to WIDE in game.mjs)`);
  return BigInt(v);
};
export const layout = (struct) => info().layout[struct];

// Name -> id and id -> name for one of ENUMS (first name wins for aliases).
const enumMaps = new Map();
function enumMap(key) {
  if (!enumMaps.has(key)) {
    const byName = new Map(Object.entries(info().enums[key]));
    const byId = new Map();
    for (const [n, id] of byName) if (!byId.has(id)) byId.set(id, n);
    enumMaps.set(key, { byName, byId });
  }
  return enumMaps.get(key);
}
// Enumerator prefixes, where they differ from the key.
const PREFIXES = { CATEGORY: 'DAMAGE_CATEGORY' };
const prefixOf = (key) => `${PREFIXES[key] ?? key}_`;
export function id(key, name) {
  const full = name.startsWith(prefixOf(key)) ? name : prefixOf(key) + name;
  const v = enumMap(key).byName.get(full);
  if (v === undefined) throw new Error(`unknown ${full}`);
  return v;
}
// The enumerator's name without its prefix (SPECIES_PIKACHU -> PIKACHU).
export function constName(key, v) {
  const n = enumMap(key).byId.get(v);
  if (n === undefined) return `#${v}`;
  return n.startsWith(prefixOf(key)) ? n.slice(prefixOf(key).length) : n;
}
export const enumNames = (key) => [...enumMap(key).byName.keys()];

// --- Symbols ----------------------------------------------------------------------

let symbolCache, allSymbols;
export function symbols() {
  if (symbolCache) return symbolCache;
  const out = execFileSync(tool('nm'), [ELF], { encoding: 'utf8', maxBuffer: 64 << 20 });
  symbolCache = new Map();
  allSymbols = new Map();
  for (const line of out.split('\n')) {
    const [addr, , name] = line.trim().split(/\s+/);
    if (!name) continue;
    symbolCache.set(name, parseInt(addr, 16));
    if (!allSymbols.has(name)) allSymbols.set(name, []);
    allSymbols.get(name).push(parseInt(addr, 16));
  }
  return symbolCache;
}

// Every address with this name (static functions can share one, e.g. each
// battle controller has its own HandleInputChooseAction).
export function symbolsNamed(name) {
  symbols();
  return allSymbols.get(name) ?? [];
}

export function symbol(name) {
  const addr = symbols().get(name);
  if (addr === undefined) throw new Error(`symbol ${name} not found in ${ELF}`);
  return addr;
}

// --- Reading structs --------------------------------------------------------------

export function readBits(buf, base, { bit, width }) {
  let v = 0;
  for (let i = 0; i < width; i++) {
    const b = bit + i;
    if (buf[base + (b >> 3)] & (1 << (b & 7))) v += 2 ** i;
  }
  return v;
}

function readUInt(buf, at, size) {
  if (size === 1) return buf[at];
  if (size === 2) return buf.readUInt16LE(at);
  if (size === 4) return buf.readUInt32LE(at);
  throw new Error(`can't read a ${size}-byte value`);
}

// A struct member: a number, or an array of numbers for array members.
export function field(buf, base, struct, name) {
  const f = layout(struct)[name];
  if (!f) throw new Error(`no field ${struct}.${name} (add it to STRUCTS in game.mjs)`);
  if (f.bit !== undefined) return readBits(buf, base, f);
  if (f.array) return Array.from({ length: f.count }, (_, i) => readUInt(buf, base + f.off + i * f.elemSize, f.elemSize));
  return readUInt(buf, base + f.off, f.size);
}

// --- The ROM's data tables ------------------------------------------------------------

let romBuf;
export function rom() {
  return (romBuf ??= readFileSync(ROM));
}
export const romOffset = (ptr) => ptr - 0x08000000;

// The game's character set (charmap.txt), for names stored in the ROM.
let charmap;
export function decodeText(buf, at, maxLen = 64) {
  if (!charmap) {
    charmap = new Map();
    for (const m of readFileSync(join(GAME_DIR, 'charmap.txt'), 'utf8').matchAll(/^'(.)'\s*=\s*([0-9A-F]{2})\s*$/gmu)) {
      const code = parseInt(m[2], 16);
      if (!charmap.has(code)) charmap.set(code, m[1]);
    }
  }
  let s = '';
  for (let i = 0; i < maxLen; i++) {
    const c = buf[at + i];
    if (c === 0xFF) break;
    s += charmap.get(c) ?? '?';
  }
  return s;
}
const romText = (ptr) => (ptr ? decodeText(rom(), romOffset(ptr)) : '');

// A string in the ROM by its symbol (e.g. a map script's text), decoded.
// Control codes (line breaks, placeholders) come out as "?".
export const textAt = (name) => decodeText(rom(), romOffset(symbol(name)), 256);

function romArray(ptr, struct, isEnd) {
  const out = [];
  if (!ptr) return out;
  const size = layout(struct).size;
  for (let at = romOffset(ptr); ; at += size) {
    const read = (f) => field(rom(), at, struct, f);
    if (isEnd(read)) break;
    out.push(read);
    if (out.length > 1000) throw new Error(`runaway ${struct} list`);
  }
  return out;
}

const speciesCache = new Map();
export function species(sp) {
  if (speciesCache.has(sp)) return speciesCache.get(sp);
  const at = romOffset(symbol('gSpeciesInfo')) + sp * layout('SpeciesInfo').size;
  const r = (f) => field(rom(), at, 'SpeciesInfo', f);
  const flag = (f) => r(f) === 1;
  const levelUp = romArray(r('levelUpLearnset'), 'LevelUpMove', (f) => f('move') === value('LEVEL_UP_MOVE_END'))
    .map((f) => ({ move: f('move'), level: f('level') }));
  const teachable = [];
  if (r('teachableLearnset')) {
    for (let p = romOffset(r('teachableLearnset')); rom().readUInt16LE(p) !== value('MOVE_UNAVAILABLE'); p += 2) teachable.push(rom().readUInt16LE(p));
  }
  const evolutions = romArray(r('evolutions'), 'Evolution', (f) => f('method') === value('EVOLUTIONS_END'))
    .map((f) => ({ method: f('method'), param: f('param'), target: f('targetSpecies') }));
  const terminator = id('FORM_CHANGE', 'TERMINATOR');
  const formChanges = romArray(r('formChangeTable'), 'FormChange', (f) => f('method') === terminator)
    .map((f) => ({ method: constName('FORM_CHANGE', f('method')), target: f('targetSpecies'), param1: f('param1'), param2: f('param2') }));
  const forms = [];
  if (r('formSpeciesIdTable')) {
    for (let p = romOffset(r('formSpeciesIdTable')); rom().readUInt16LE(p) !== 0xFFFF; p += 2) forms.push(rom().readUInt16LE(p));
  }
  const info = {
    id: sp,
    constName: constName('SPECIES', sp),
    name: decodeText(rom(), at + layout('SpeciesInfo').speciesName.off, layout('SpeciesInfo').speciesName.size),
    // Stat order used everywhere in the tests: HP, Atk, Def, Speed, Sp. Atk, Sp. Def.
    baseStats: ['baseHP', 'baseAttack', 'baseDefense', 'baseSpeed', 'baseSpAttack', 'baseSpDefense'].map(r),
    types: [...new Set(r('types'))],
    abilities: r('abilities'),
    genderRatio: r('genderRatio'),
    friendship: r('friendship'),
    natDexNum: r('natDexNum'),
    legendary: flag('isRestrictedLegendary') || flag('isSubLegendary') || flag('isMythical'),
    ultraBeast: flag('isUltraBeast'),
    paradox: flag('isParadox'),
    mega: flag('isMegaEvolution'),
    battleOnly: flag('isMegaEvolution') || flag('isPrimalReversion') || flag('isUltraBurst') || flag('isGigantamax') || flag('isTeraForm'),
    regional: flag('isAlolanForm') || flag('isGalarianForm') || flag('isHisuianForm') || flag('isPaldeanForm'),
    levelUp,
    teachable,
    evolutions,
    formChanges,
    forms,
  };
  info.bst = info.baseStats.reduce((a, b) => a + b, 0);
  speciesCache.set(sp, info);
  return info;
}

const moveCache = new Map();
export function move(mv) {
  if (moveCache.has(mv)) return moveCache.get(mv);
  const at = romOffset(symbol('gMovesInfo')) + mv * layout('MoveInfo').size;
  const r = (f) => field(rom(), at, 'MoveInfo', f);
  const info = {
    id: mv,
    constName: constName('MOVE', mv),
    name: romText(r('name')),
    effect: constName('EFFECT', r('effect')),
    type: constName('TYPE', r('type')),
    category: constName('CATEGORY', r('category')),
    power: r('power'),
    accuracy: r('accuracy'),
    pp: r('pp'),
  };
  moveCache.set(mv, info);
  return info;
}

const itemCache = new Map();
export function item(it) {
  if (itemCache.has(it)) return itemCache.get(it);
  const at = romOffset(symbol('gItemsInfo')) + it * layout('ItemInfo').size;
  const r = (f) => field(rom(), at, 'ItemInfo', f);
  const info = {
    id: it,
    constName: constName('ITEM', it),
    name: romText(r('name')),
    holdEffect: constName('HOLD_EFFECT', r('holdEffect')),
    holdEffectParam: r('holdEffectParam'),
    secondaryId: r('secondaryId'),
  };
  itemCache.set(it, info);
  return info;
}

// Moves taught by TM/HM, in machine order (gTMHMItemMoveIds[1..]).
export function tmhmMoves() {
  const size = layout('TmHmIndexKey').size;
  const base = romOffset(symbol('gTMHMItemMoveIds'));
  return Array.from({ length: value('NUM_ALL_MACHINES') }, (_, i) => field(rom(), base + (i + 1) * size, 'TmHmIndexKey', 'moveId'));
}
