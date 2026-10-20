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

// The Mega forme a held stone turns a Pokemon into (from the species' form
// change table in the ROM), or null.
export function megaFormeFor(mon) {
  if (!isMegaStone(mon.heldItem)) return null;
  const change = species(mon.species).formChanges.find((f) => f.method === 'BATTLE_MEGA_EVOLUTION_ITEM' && f.param1 === mon.heldItem);
  return change ? change.target : null;
}

// A Pokemon's types, and its Mega forme's.
export function typesOf(mon) {
  const mega = megaFormeFor(mon);
  return new Set([...species(mon.species).types, ...(mega ? species(mega).types : [])]);
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
