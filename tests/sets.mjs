// The generated set table (gDailyRedSets / gDailyRedSetLists in the ROM) and
// the checks both teams share: a Pokemon carries one of its sets, has perfect
// stats, and what its held item is.
import { symbol, layout, value, field, rom, romOffset, id, species, item } from './game.mjs';

export const NATURES = ['Hardy', 'Lonely', 'Brave', 'Adamant', 'Naughty', 'Bold', 'Docile', 'Relaxed', 'Impish', 'Lax',
  'Timid', 'Hasty', 'Serious', 'Jolly', 'Naive', 'Modest', 'Mild', 'Quiet', 'Bashful', 'Rash', 'Calm', 'Gentle',
  'Sassy', 'Careful', 'Quirky'];
const NATURE_UP_DOWN = (n) => [1 + Math.floor(n / 5), 1 + (n % 5)]; // stat indices in HP/Atk/Def/Spe/SpA/SpD order

let setTable;
export function setLists() {
  if (setTable) return setTable;
  const L = layout('DailyRedSetList'), T = layout('DailyRedSet');
  const lists = [];
  const listBase = romOffset(symbol('gDailyRedSetLists'));
  const count = rom().readUInt16LE(romOffset(symbol('gDailyRedNumSetLists')));
  const kinds = ['NORMAL', 'MEGA', 'ZMOVE', 'TERA'];
  for (let i = 0; i < count; i++) {
    const r = (f) => field(rom(), listBase + i * L.size, 'DailyRedSetList', f);
    const sets = [];
    for (let j = 0; j < r('numSets'); j++) {
      const at = romOffset(symbol('gDailyRedSets')) + (r('firstSet') + j) * T.size;
      const s = (f) => field(rom(), at, 'DailyRedSet', f);
      sets.push({ species: s('species'), item: s('item'), ability: s('ability'), moves: s('moves'), evs: s('evs'),
        nature: s('nature'), teraType: s('teraType'), ivs: s('ivs') });
    }
    lists.push({ species: r('species'), kind: kinds[r('kind')], level: r('level'), sets });
  }
  return (setTable = lists);
}
export const listFor = (sp, kind) => setLists().find((l) => l.species === sp && l.kind === kind);

// Stats with every IV at 31 (what hyper training gives).
export function perfectStats(mon) {
  const base = species(mon.species).baseStats;
  const n = NATURES.indexOf(mon.nature);
  const [up, down] = NATURE_UP_DOWN(n);
  return base.map((b, i) => {
    const core = Math.floor(((2 * b + 31 + Math.floor(mon.evs[i] / 4)) * mon.level) / 100);
    if (i === 0) return mon.species === id('SPECIES', 'SHEDINJA') ? 1 : core + mon.level + 10; // Shedinja: always 1 HP
    let stat = core + 5;
    if (up !== down && i === up) stat = Math.floor((stat * 110) / 100);
    if (up !== down && i === down) stat = Math.floor((stat * 90) / 100);
    return stat;
  });
}

// Perfect stats, full HP and PP: problems for one Pokemon.
export function checkStats(m, problems) {
  const tag = m.speciesName;
  if (!m.hyperTrained.every(Boolean)) problems.push(`${tag}: not every stat hyper trained`);
  if (m.stats.join() !== perfectStats(m).join()) problems.push(`${tag}: stats ${m.stats.join('/')}, perfect would be ${perfectStats(m).join('/')}`);
  if (m.hp !== m.maxHp) problems.push(`${tag}: HP ${m.hp}/${m.maxHp}`);
  if (m.pp.some((pp, i) => m.moves[i] && pp === 0)) problems.push(`${tag}: a move has 0 PP`);
}

export const holdEffect = (it) => (it ? item(it).holdEffect : 'NONE');
export const isZCrystal = (it) => holdEffect(it) === 'Z_CRYSTAL';
export const isMegaStone = (it) => holdEffect(it) === 'MEGA_STONE';
export const baseSpecies = (sp) => species(sp).forms[0] ?? sp;

// The Mega forme a Pokemon turns into (from the species' form change table in
// the ROM), or null: by its held Mega Stone, or, for Rayquaza, by knowing
// Dragon Ascent (it holds no stone).
export function megaFormeFor(mon) {
  const change = species(mon.species).formChanges.find((f) =>
    (f.method === 'BATTLE_MEGA_EVOLUTION_ITEM' && isMegaStone(mon.heldItem) && f.param1 === mon.heldItem)
    || (f.method === 'BATTLE_MEGA_EVOLUTION_MOVE' && mon.moves.includes(f.param1)));
  return change ? change.target : null;
}
export const canMegaEvolve = (mon) => megaFormeFor(mon) !== null;

// A Pokemon's types, and its Mega forme's.
export function typesOf(mon) {
  const mega = megaFormeFor(mon);
  return new Set([...species(mon.species).types, ...(mega ? species(mega).types : [])]);
}

// The team limits, the same for both teams: one item may be held by two
// Pokemon and every other by one at most; one type may be shared by two
// Pokemon and no other type (a Mega's types count with its base form's).
export function checkTeamLimits(mons, problems) {
  const itemCounts = new Map();
  for (const m of mons) if (m.heldItem) itemCounts.set(m.heldItem, (itemCounts.get(m.heldItem) ?? 0) + 1);
  const heldTwice = [...itemCounts].filter(([, n]) => n >= 2);
  for (const [it, n] of itemCounts) if (n > 2) problems.push(`${n} Pokemon hold ${item(it).name}`);
  if (heldTwice.length > 1) problems.push(`more than one item held twice (${heldTwice.map(([it]) => item(it).name).join(', ')})`);
  const typeCounts = new Map();
  for (const m of mons) for (const t of typesOf(m)) typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
  const shared = [...typeCounts].filter(([, n]) => n >= 2);
  for (const [t, n] of typeCounts) if (n > 2) problems.push(`${n} ${t}-type Pokemon`);
  if (shared.length > 1) problems.push(`more than one shared type (${shared.map(([t]) => t).join(', ')})`);
}

const sameMoves = (a, b) => a.filter(Boolean).slice().sort().join() === b.filter(Boolean).slice().sort().join();

// Whether a Pokemon carries one of the sets of its list (moves, item, ability,
// EVs, nature, Tera type); pushes a problem if not.
export function matchesList(mon, list, problems, tag) {
  if (!list) {
    problems.push(`${tag}: no set list`);
    return;
  }
  const evs = [0, 1, 2, 4, 5, 3].map((i) => mon.evs[i]); // Showdown order HP/Atk/Def/SpA/SpD/Spe
  const ok = list.sets.some((s) => s.species === mon.species && s.item === mon.heldItem && s.ability === mon.ability
    && sameMoves(s.moves, mon.moves) && s.evs.join() === evs.join() && NATURES[s.nature] === mon.nature
    && (s.teraType === value('TYPE_NONE') ? mon.teraType === value('TYPE_MYSTERY') : mon.teraType === s.teraType));
  if (!ok) problems.push(`${tag}: isn't one of its ${list.kind} sets (${mon.moveNames.join(', ')} @ ${mon.heldItem ? item(mon.heldItem).name : 'no item'})`);
}

export { id };
