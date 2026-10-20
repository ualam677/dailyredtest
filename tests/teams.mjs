// Prints and validates the team the ROM generates for each seed, by booting
// the real game and reading the party from RAM.
//
//   node teams.mjs 1 2 3          # specific seeds
//   node teams.mjs --random 20    # 20 random seeds
//
// Exits non-zero if any team breaks the rules (see validateTeam in party.mjs).
import { startServer, launchBrowser, bootGame, waitFor } from './lib.mjs';
import { readParty, formatMon, validateTeam, teamBaseStatTotal, MIN_TEAM_BST, isLegendary } from './party.mjs';
import { id, species as speciesInfo } from './game.mjs';

const args = process.argv.slice(2);
let seeds;
if (args[0] === '--random') {
  seeds = Array.from({ length: Number(args[1] || 10) }, () => 1 + Math.floor(Math.random() * 0xFFFFFFFE));
} else {
  seeds = args.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 0xFFFFFFFF);
}
if (!seeds.length) {
  console.log('Usage: node teams.mjs <seed> [seed...] | --random <count>');
  process.exit(1);
}

const server = await startServer();
const browser = await launchBrowser();
const results = new Map();

async function generate(seed) {
  const page = await browser.newPage();
  try {
    await bootGame(page, server.url, { seed });
    const { mem } = await waitFor(page, (s) => s.inOverworld, { what: `overworld for seed ${seed}`, timeoutMs: 30000 });
    results.set(seed, readParty(mem));
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
for (const seed of seeds) {
  const team = results.get(seed);
  const problems = validateTeam(team);
  if (problems.length) invalid++;
  team.party.forEach((m) => m && species.add(m.speciesName));
  console.log(`\nSeed ${seed}  team base stat total ${teamBaseStatTotal(team.party)}${problems.length ? '  INVALID: ' + problems.join('; ') : ''}`);
  for (const mon of team.party) console.log('  ' + formatMon(mon));
}

const unique = new Set(seeds.map((s) => results.get(s).party.map((m) => m?.species).join(','))).size;
console.log(`\n${seeds.length} seeds, ${unique} different teams, ${species.size} different species, ${invalid} invalid team(s).`);

const redTotal = ['PIKACHU', 'ESPEON', 'SNORLAX', 'VENUSAUR', 'CHARIZARD', 'BLASTOISE'].reduce((sum, n) => sum + speciesInfo(id('SPECIES', n)).bst, 0);
const totals = seeds.map((s) => teamBaseStatTotal(results.get(s).party));
console.log(`Team base stat totals: min ${Math.min(...totals)}, average ${Math.round(totals.reduce((a, b) => a + b, 0) / totals.length)}, max ${Math.max(...totals)} `
  + `(minimum ${MIN_TEAM_BST}; RED ${redTotal}; ${totals.filter((t) => t > redTotal).length} of ${totals.length} teams out-total RED).`);
const legendaryTeams = seeds.filter((s) => results.get(s).party.some((m) => m && isLegendary(m))).length;
console.log(`Teams with a legendary: ${legendaryTeams} of ${seeds.length}.`);
process.exit(invalid ? 1 : 0);
