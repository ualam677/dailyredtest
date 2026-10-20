// Prints and validates the teams the ROM generates for each seed, the
// player's and RED's, by booting the real game and reading both parties from
// RAM.
//
//   node teams.mjs 1 2 3          # specific seeds
//   node teams.mjs --random 20    # 20 random seeds
//   node teams.mjs --red-cases    # a seed for each of RED's rolls (original
//                                 # team, every legendary for every starter)
//
// Exits non-zero if any team breaks the rules (validateTeam in party.mjs,
// validateRed in red.mjs).
import { startServer, launchBrowser, bootGame, waitFor } from './lib.mjs';
import { readParty, formatMon, validateTeam, teamBaseStatTotal, MIN_TEAM_BST, isLegendary, laterEvolutions } from './party.mjs';
import { readRedParty, validateRed, predictRolls, formatRedMon, legendaryKind } from './red.mjs';

const args = process.argv.slice(2);
let seeds;
if (args[0] === '--random') {
  seeds = Array.from({ length: Number(args[1] || 10) }, () => 1 + Math.floor(Math.random() * 0xFFFFFFFE));
} else if (args[0] === '--red-cases') {
  seeds = redCaseSeeds();
} else {
  seeds = args.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 0xFFFFFFFF);
}
if (!seeds.length) {
  console.log('Usage: node teams.mjs <seed> [seed...] | --random <count> | --red-cases');
  process.exit(1);
}

// The first seed from 1 up for each roll RED's team can have.
export function redCaseSeeds() {
  const kinds = new Set(Array.from({ length: 100 }, (_, r) => legendaryKind(r)));
  const wanted = new Set(['original']);
  for (const starter of ['VENUSAUR', 'CHARIZARD', 'BLASTOISE']) for (const kind of kinds) wanted.add(`${starter} ${kind}`);
  const found = [];
  for (let seed = 1; wanted.size && seed < 5_000_000; seed++) {
    const r = predictRolls(seed);
    const key = r.original ? 'original' : `${r.starter} ${r.legendary}`;
    if (wanted.delete(key)) found.push(seed);
  }
  return found;
}

const server = await startServer();
const browser = await launchBrowser();
const results = new Map();

async function generate(seed) {
  const page = await browser.newPage();
  try {
    await bootGame(page, server.url, { seed });
    const { mem } = await waitFor(page, (s) => s.inOverworld, { what: `overworld for seed ${seed}`, timeoutMs: 30000 });
    results.set(seed, { player: readParty(mem), red: readRedParty(mem) });
  } finally {
    await page.close();
  }
}

// A few emulators at a time keeps this quick without overloading the machine.
const queue = [...seeds];
await Promise.all(Array.from({ length: Math.min(4, seeds.length) }, async () => {
  while (queue.length) await generate(queue.shift());
}));
await browser.close();
server.close();

let invalid = 0;
const species = new Set();
const redKinds = new Map();
for (const seed of seeds) {
  const { player, red } = results.get(seed);
  const problems = validateTeam(player);
  const rolls = predictRolls(seed);
  const redCheck = validateRed(red, rolls);
  if (problems.length || redCheck.problems.length) invalid++;
  player.party.forEach((m) => m && species.add(m.speciesName));
  const label = rolls.original ? 'original team' : `${rolls.starter.toLowerCase()}, ${rolls.legendary}`;
  redKinds.set(label, (redKinds.get(label) ?? 0) + 1);
  console.log(`\nSeed ${seed}  team base stat total ${teamBaseStatTotal(player.party)}${problems.length ? '  INVALID: ' + problems.join('; ') : ''}`);
  for (const mon of player.party) console.log('  ' + formatMon(mon));
  console.log(`  RED (${label})${redCheck.problems.length ? '  INVALID: ' + redCheck.problems.join('; ') : ''}`);
  for (const mon of red) console.log('  ' + formatRedMon(mon));
}

const unique = new Set(seeds.map((s) => results.get(s).player.party.map((m) => m?.species).join(','))).size;
console.log(`\n${seeds.length} seeds, ${unique} different teams, ${species.size} different species, ${invalid} seed(s) with an invalid team.`);
const totals = seeds.map((s) => teamBaseStatTotal(results.get(s).player.party));
console.log(`Team base stat totals: min ${Math.min(...totals)}, average ${Math.round(totals.reduce((a, b) => a + b, 0) / totals.length)}, max ${Math.max(...totals)} `
  + `(minimum ${MIN_TEAM_BST}).`);
const legendaryTeams = seeds.filter((s) => results.get(s).player.party.some((m) => m && isLegendary(m))).length;
console.log(`Teams with a legendary: ${legendaryTeams} of ${seeds.length}.`);
const later = seeds.flatMap((s) => results.get(s).player.party).filter((m) => m && laterEvolutions().has(m.species));
console.log(`Later-generation evolutions drawn: ${later.length} (${[...new Set(later.map((m) => m.speciesName))].join(', ') || 'none'}).`);
console.log(`RED's teams: ${[...redKinds].map(([k, n]) => `${k} ${n}`).join(', ')}.`);
process.exit(invalid ? 1 : 0);
