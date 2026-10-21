# Daily Red

A daily Pokémon battle in the browser, like Wordle: once a day you press
**Play**, get the day's six random level 100 Pokémon from Generations 1–3
(everyone gets the same team that day), and climb to RED at the top of the
mountain. You get one battle per day. Your wins, losses, win streak and daily
play streak are kept in your browser.

Every battle runs on a real Game Boy Advance game: the FireRed build of
[pokeemerald-expansion](https://github.com/rh-hideout/pokeemerald-expansion)
(the pret decompilations with an up-to-date battle engine: Fairy type,
physical/special split, abilities, items and moves up to Generation 9) with a
small set of source changes, built into a GBA ROM and played in the browser
through the mGBA emulator compiled to WebAssembly. Nothing about battles is
reimplemented in JavaScript.

- [Quick start (macOS)](#quick-start-macos)
- [How it works](#how-it-works)
- [Your team](#your-team)
- [RED's team](#reds-team)
  - [Graphics](#graphics)
  - [Sets](#sets)
- [Development workflow](#development-workflow)
- [Testing and debugging](#testing-and-debugging)
- [Running it locally](#running-it-locally)
- [Copyright and licenses](#copyright-and-licenses)
- [Known limitations](#known-limitations)

## Quick start (macOS)

You need the Xcode Command Line Tools (`xcode-select --install`), Node.js 18+
and git. No Homebrew, no `sudo`, and **no ROM**: the decompilation builds the
whole game from source.

```sh
scripts/setup-macos.sh      # ARM cross-compiler + libpng into .toolchain/ (~1 GB, one time)
scripts/get-expansion.sh    # pokeemerald-expansion at a pinned release + patches/
scripts/fetch-vendor.sh     # emulator, emulator core and font into web/vendor/
scripts/build-rom.sh        # builds the ROM, writes web/game/dailyred.gba.gz
node scripts/serve.mjs      # open http://localhost:8080
```

`setup-macos.sh` picks the right compiler for Intel or Apple Silicon Macs. The
first ROM build takes a few minutes (the expansion builds its own tools and
all of its graphics); later builds only redo what changed.

## How it works

```
pokeemerald-expansion 1.17.1 + patches/  ──make firered──▶  pokefirered.gba
                                                                │ gzip (32 MB → 17.5 MB)
web/ (static files)                                             ▼
  index.html + app.js ── fetch ──▶ game/dailyred.gba.gz, vendor/mgba_libretro.wasm
        │  writes the day's seed + your record into the ROM bytes (rom-config.js)
        ▼
  Nostalgist.js ──▶ RetroArch + mGBA core (WebAssembly) ──▶ <canvas>
        ▲
        └─ game-link.js reads the battle's status from the game's RAM
           → daily.js updates your stats in localStorage
```

**Why an emulator instead of compiling the C to WebAssembly:** the decomp is
written for GBA hardware (video, DMA, interrupts, the m4a sound engine,
ARM/Thumb assembly). Running the real ROM in mGBA keeps the battle engine,
animations and sound exactly as shipped, with no porting work. mGBA has a
built-in BIOS replacement, so no BIOS file is needed either.

**Why Nostalgist + RetroArch's mGBA core:** it accepts the ROM as raw bytes
(needed for the config below), exposes button presses and the emulator's
memory to JavaScript, and doesn't need `SharedArrayBuffer`, so a plain static
file server works without special headers. Everything loads from `web/vendor/`.

### The daily game

- **The day's team:** the seed is a hash of today's date in the player's own
  time zone (`dailySeed` in `web/daily.js`), so everyone gets the same team
  on the same calendar day, like Wordle.
- **Site → game:** the ROM contains a small struct, `gDailyRedRomConfig`: the
  magic bytes `DAILYRED-CONF-V2`, then the seed, the player's wins and battles
  so far, and a "daily" flag. Before booting, `web/rom-config.js` finds the
  magic bytes in the downloaded ROM and fills them in; no addresses are
  hard-coded on either side. The game uses the record for its "Record: x
  win(s) in x battle(s)" message.
- **Game → site:** the game keeps a status block in RAM (`sStatus` in
  `src/dailyred.c`): the magic `DAILYRED-STATUS1`, the seed, a phase (exploring
  / battle / result / finished) and a result (won / lost). `web/game-link.js`
  finds it in the emulator's WebAssembly memory (the magic followed by the
  seed it injected) and reads it twice a second.
- **One battle a day:** the day counts as played as soon as RED's battle
  starts; closing or reloading the page mid-battle counts as a loss. The
  result is saved the moment it's known. After the closing messages the game
  fades to black and holds; the site then closes it and shows today's result
  and a countdown to the next battle. Before the battle you can reload freely:
  it's the same team all day.
- **Stats** (`web/daily.js`, localStorage key `dailyred-stats`): wins, losses,
  win streak (daily wins in a row) and day streak (days played in a row).
  Missing a day resets both streaks.
- **Without the website** (seed 0, e.g. the ROM in a desktop emulator): the
  normal intro and title screen appear, pressing Start seeds the game the way
  vanilla FireRed does, and after each battle a new team arrives.
- **`?seed=1234`** in the URL starts a practice run for testing: that seed's
  team, no daily limit, nothing saved, and a new team after each battle. It
  isn't shown anywhere in the UI.

### Game flow and the files involved

| Step | Code |
|---|---|
| Copyright screen → straight in (seed set) | `src/intro_frlg.c` → `CB2_DailyRed_StartFromCopyright` (`src/dailyred.c`) |
| Title screen → straight in (no seed) | `src/title_screen_frlg.c` → `CB2_DailyRed_StartFromTitle` |
| New game data: the player is named Blue (on FireRed's female player, LEAF's sprites) and RED is named Red, fast text | `StartNewGame` in `src/dailyred.c`, then vanilla `CB2_NewGame` |
| Team + warp to the summit instead of the bedroom | `src/new_game.c` → `DailyRed_InitNewGame` |
| The summit: an open peak with no exits; stairs up to RED, who faces the drop | `data/maps/DailyRed_Summit/`, `data/layouts/DailyRed_Summit/` |
| Snow on the summit, as scenery only: it doesn't start Snow in RED's battle | `data/maps/DailyRed_Summit/map.json`; the battle check in `src/battle_util.c` |
| Talking to RED → "…" → battle (he says "…!" if he loses, "…" if he wins) → "You defeated RED!" / "Your team was wiped out…" → record → "Play again tomorrow!" / "Try again tomorrow." → fade out | `data/maps/DailyRed_Summit/scripts.inc`; the `DailyRed_On*` specials in `src/dailyred.c` |
| RED's battle theme | `MUS_DAILYRED_VS_RED`, picked by his trainer class in `GetBattleBGM` (`src/pokemon.c`); see [RED's battle theme](#reds-battle-theme) |
| The summit's howling wind instead of music | `MUS_DAILYRED_MT_SILVER_WIND`, the summit map's music; see [The summit's wind](#the-summits-wind) |
| Mt. Silver's HGSS-style battle background on the summit | `BattleSetup_GetEnvironmentId` in `src/battle_setup.c` picks `BATTLE_ENVIRONMENT_SNOW`, whose graphics are in `src/data/battle_environment.h`; see [Graphics](#graphics) |
| RED's animated HGSS battle sprite, and LEAF's HGSS-style sprite in the VS transition | `TRAINER_PIC_DAILYRED_RED` / `_LEAF`; `DailyRed_AnimateTrainerSprite` (`src/dailyred_red.c`, called from `src/battle_controllers.c`); `src/battle_transition.c` |
| No free switch when RED's Pokémon faints: Battle Style starts on SET and is locked in Options | `StartNewGame` in `src/dailyred.c`, `src/option_menu.c` |
| RED as a trainer, with his AI | `TRAINER_DAILYRED_RED` in `include/constants/opponents_frlg.h` and `src/data/trainers_frlg.party` |
| RED's team, built each run | `src/dailyred_red.c` from the sets in `src/dailyred_sets.c` (see [RED's team](#reds-team)); used by `CreateNPCTrainerParty` in `src/battle_setup.c` |
| Win / battle counters | `VAR_DAILYRED_WINS` and `VAR_DAILYRED_BATTLES` in `include/constants/vars_frlg.h` |
| Menus: POKéMON / OPTION / EXIT; party: SUMMARY / SWITCH / CANCEL | `src/start_menu.c`, `src/party_menu.c` |
| No debug menus | `include/config/debug.h` |

The battle itself is a standard trainer battle. The map script starts it as an
"early rival" battle with `RIVAL_BATTLE_HEAL_AFTER`, the mode FireRed uses for
the rival fight in Oak's lab, so losing doesn't white out, and skips the
trainer flag check, so RED can be fought again after a win. The script then
reads `VAR_RESULT`, updates a win/battle counter, calls the
`DailyRed_StartNextRun` special (new team) and warps back to the start tile,
which also resets RED.

### Battle rules

The battle engine is the expansion's (Gen 9 mechanics by default), with these
changes:

- **No affection or friendship boosts** (`B_AFFECTION_MECHANICS` off in
  `include/config/battle.h`; `B_FRIENDSHIP_BOOST` was already off): a
  Pokémon's friendship never lets it hang on to a knockout blow, dodge,
  land extra critical hits or shake off a status. The smoke test checks this
  with a max-friendship team (see Testing).
- **Mega Evolution and Z-Moves:** the player starts with a Mega Ring and a
  Z-Power Ring (`DailyRed_InitNewGame`), so a Pokémon holding its Mega Stone or
  a Z-Crystal can use them. Each side can Mega Evolve once and use one Z-Move
  per battle; the engine enforces that for every trainer, RED included (he
  needs no ring).
- **Terastallization and Dynamax:** the player has neither a Tera Orb nor a
  Dynamax Band. RED never Dynamaxes, and only Terastallizes on original-team
  days (see [RED's team](#reds-team)).

Every vanilla file that was changed has a `Daily Red:` comment at the change:

```sh
grep -rn "Daily Red" expansion/src expansion/include expansion/data
```

The summit is HeartGold/SoulSilver's Mt. Silver summit: a 20×24 layout on an
HGSS-derived secondary tileset (`data/tilesets/secondary/mt_silver_summit/`,
`gTileset_MtSilverSummit`, with FireRed's General tileset as primary; 40
metatiles on one palette, supplied by the project's owner). You start on the
path at (9, 15), just inside the summit's entrance; the snowfield below it is
scenery. Climb between the terraced cliffs and up the stairs, and RED stands
on the summit's edge at (9, 4), facing north over a sea of clouds (rows 0–3),
turning around when you talk to him.

`scripts/graphics/make-graphics.py` adds two things to the tileset:
- the clouds (`summit_clouds`): `art/mt-silver-clouds.png`, a seamless
  96×64 strip cut from an HGSS screenshot of the summit (its snowflakes
  filtered out), on palette 8 as metatiles 0x2A8–0x2BF that the map repeats
  every 6 columns. They drift left a pixel every 16 frames
  (`InitTilesetAnim_MtSilverSummit` in `src/tileset_anims.c` turns the strip's
  tiles in EWRAM and copies them to VRAM);
- the edge (`summit_edge`): versions of the platform's rock walls and snow
  for the top row (0x2C0–0x2C2) with a rim line and rounded snow caps, so
  the summit doesn't end in a flat cut against the clouds.

The snow is a swirling snowstorm (`src/field_weather_effect.c`): 44 flakes
instead of 16, all there from the start, falling two to three times as fast,
blown left and circling as they fall (the summit is the only snowy map).

On 1 run in 100 (`EXIT_ODDS`, rolled per run from the seed, see
`DailyRed_IsExitOpen`) the entrance is open: walking south off the path's last
row (9, 18), like leaving a cave, warps you straight to the start of FireRed,
your bedroom in Pallet Town, team and all, and the only way back up is to
become Champion. Otherwise the entrance is just a wall. Arriving in the
bedroom that way, the player says the second half of FireRed's NES line,
"…Okay! It's time to go!" (`DailyRed_ArrivedFromSummit`, from the bedroom's
own map scripts). The Hall of Fame sends you straight back
to the summit start with your team healed instead of rolling the credits
(`DailyRed_ReturnFromHallOfFame`, called from `Task_Hof_HandleExit` in
`src/hall_of_fame.c`). RED and
the player (named Blue) use FireRed's own player sprites, RED's and LEAF's.

The status block in RAM is `volatile`: nothing in the game reads it, and the
expansion builds with link-time optimization, which would otherwise drop every
write to it. The win and battle counters use script variables 0x409B and
0x409D, which neither FireRed nor the shared Emerald code touches (the
expansion's step counter code writes to some of FireRed's "unused" ones).

## Your team

`expansion/src/dailyred_team.c` builds your team at the start of each run,
right after RED's (his starter decides yours), from the seed:

- **A starter that counters RED's**, level 100:

  | RED's starter | Yours (one at random) |
  |---|---|
  | Venusaur | Charizard, Typhlosion, Blaziken |
  | Charizard | Blastoise, Feraligatr, Swampert |
  | Blastoise | Venusaur, Meganium, Sceptile |

  It holds its Mega Stone (Charizard: X or Y at random; Meganium and
  Feraligatr have the Megas from Pokémon Legends: Z-A, with Mega Sol and
  Dragonize) and gets one of that Mega's sets. Typhlosion has no Mega, so it
  holds a Firium Z. On RED's original-team days (he has all three Kanto
  starters) it's any of the nine.
- **Five fully evolved Pokémon** from Daily Red's species scope (below), never
  holding a Mega Stone or a Z-Crystal. **Legendaries are a 1-in-8 roll**
  (`LEGENDARY_TEAM_ODDS`): 1 team in 8 has exactly one, the rest none.
- **5% of days mirror RED's team** (`MIRROR_RED_ODDS`): the starter, a
  **shiny Pikachu** (level 100, Light Ball and Volt Tackle, like his), a
  legendary for sure, and three more.
- **At most one starter and one Eeveelution:** the counter-starter is the
  only one of the nine final Gen 1–3 starters, and the five can't add a
  second (or a second Eeveelution).
- **No species twice, no type on more than two** of the six (a Mega's types
  count with its base form's), and the six's **base stats add up to at least
  2700** (`MIN_TEAM_BASE_STAT_TOTAL`; RED's original team totals 2974). The
  rest of the team is redrawn until it meets the minimum, so every qualifying
  team is equally likely.
- **Sets and stats:** every Pokémon gets one of its Showdown Random Battle
  sets from the same table as RED's (see [Sets](#sets)), with perfect stats
  (every IV maxed by hyper training) and the set's competitive nature and
  EVs (see [Sets](#sets)).
- **Levels by Showdown tier**, so strong Pokémon are a little lower: 95 for OU
  and up (Ubers, OU), 96 UU, 97 RU, 98 NU and below. A "BL" tier (banned to
  the tier above) counts as the tier above (UUBL 95, RUBL 96, NUBL 97). The
  tier is Gen 7's, or Gen 8's / Gen 9's for Pokémon Gen 7 doesn't have
  (Kleavor, Ursaluna, Annihilape…). The starter and the mirror Pikachu are
  level 100.
- **The party order is random**; reorder it from the party menu.
- You're the original trainer, so everything obeys, and Pokémon are marked as
  event Pokémon so Mew and Deoxys obey too. Natural shinies happen at the
  usual odds.

**Species scope ("Generations 1–3"):** the 386 Pokémon of Generations 1–3,
their evolutions from later games (`sLaterEvolutions`: Magnezone, Leafeon,
Glaceon, Sylveon, Gallade, Togekiss, Kleavor, Annihilape and the rest, 29 in
all), and the Mega Evolutions of any of those (`DailyRed_IsSpeciesInScope`).
Teams are drawn from the regular forms; a Mega only appears in battle, from a
held Mega Stone. Regional forms (Alolan Raichu, Galarian Ponyta…) count as
later-generation Pokémon, so they and their evolutions (Sirfetch'd,
Obstagoon, Sneasler, Clodsire…) are out. The tests rebuild the
later-evolution list from the ROM's own evolution tables and check it
against `sLaterEvolutions`.

The generator uses its own RNG state, separate from the game's `Random()`, so
teams depend only on the seed. The odds, levels and minimum are `#define`s at
the top of `dailyred_team.c`.

## RED's team

RED gets a new team at the start of every run, built from the seed (so
everyone faces the same RED on the same day) by **`expansion/src/dailyred_red.c`**
into `gDailyRedRedParty`; `CreateNPCTrainerParty` (`src/battle_setup.c`) uses
it instead of his entry in `src/data/trainers_frlg.party`. Every Pokémon gets
one of its [Pokémon Showdown](https://pokemonshowdown.com) Random Battle sets
(moves, item, ability, EVs, nature; see [Sets](#sets)) and perfect stats: all
IVs maxed by hyper training (the real IVs keep Hidden Power's type).

**Most days:**

| Slot | Pokémon | Level |
|---|---|---|
| Kanto starter | Venusaur, Charizard or Blastoise, holding its Mega Stone (Charizard: X or Y) | 99 |
| Pikachu | always; Light Ball and Volt Tackle in every set | 100 |
| Legendary | picked by the starter, see below | 99 (Mewtwo 100) |
| Two from his pool | Poliwrath, Gyarados, Aerodactyl, Lapras, Snorlax, Vaporeon, Jolteon, Flareon, Espeon, Umbreon, Leafeon, Glaceon, Sylveon, Hitmonlee, Kabutops, Victreebel, Machamp, Arcanine, Gengar | 96 |
| One from Gens 1–3 | any fully evolved Pokémon of the Gen 1–3 Pokédex (no later-generation evolutions or regional forms; "fully evolved" by today's evolutions, so no Magneton or Scyther) except starters, Pikachu's family, legendaries and mythicals (159 species) | 96 |

| Legendary roll | Odds | Venusaur | Charizard | Blastoise |
|---|---|---|---|---|
| His bird | 43% | Moltres | Articuno | Zapdos |
| Johto dog | 20% | Entei | Suicune | Raikou |
| Galarian bird | 15% | Galarian Moltres | Galarian Articuno | Galarian Zapdos |
| Mewtwo (level 100) | 10% | | | |
| Deoxys (any forme) | 5% | | | |
| Mew (1% of days a shiny one) | 5% | | | |
| Mega Mewtwo X or Y (level 100) | 2% | | | |

- On a Mega Mewtwo day Mewtwo holds the Mega Stone and the starter holds a
  Z-Crystal instead (its set's, or the one for its strongest STAB move).
  Otherwise the legendary may hold a Z-Crystal when its set has one (not the
  Galarian birds: their sets are from Gen 8, which has no Z-Moves). So RED has
  at most one Mega Evolution and one Z-Move.
- The pool picks and the Gen 1–3 pick never hold a Mega Stone or a
  Z-Crystal. No two of those three share a type, no type is on more than two
  of RED's six (a Mega's types count with its base form's), and he has at most
  one Eeveelution.
- He leads with Pikachu or one of the three picks: one that sets entry
  hazards (Stealth Rock, Spikes, Toxic Spikes, Sticky Web, Stone Axe,
  Ceaseless Edge) if any does, otherwise at random. The starter and the
  legendary never lead.

**5% of days, his original team** from HeartGold/SoulSilver, all level 100:
Pikachu, Espeon or Lapras (50/50), Snorlax, Venusaur, Charizard and
Blastoise. The three starters share out Mega Evolution, a Z-Move and
Terastallization at random, each with that gimmick's sets (Gen 7 for Mega and
Z, Gen 9 for Tera, including its Tera type). He leads with Pikachu, Espeon or
Lapras, or Snorlax. Nothing on his team ever Dynamaxes, and only that Tera
starter can Terastallize.

All of RED's Pokémon are male, except the Eeveelutions, Lapras and Gyarados
(female) and species with a fixed gender (or none).

The odds and levels are `#define`s at the top of `dailyred_red.c`
(`ORIGINAL_TEAM_ODDS`, `JOHTO_DOG_ODDS`, `LEVEL_PICK`...), the pool is
`sRedPool`, and the tests read them from there.

**His AI** is the expansion's strongest: `AI: Smart Trainer / Prediction` in
his entry in `trainers_frlg.party` (omniscient, smart switching and switch-in
choices, PP-stall prevention, Smart Tera, and predicting your switches and
moves). That entry's party, his HeartGold/SoulSilver team, only stands in for
the real one where the game reads it outside the battle (prize money). His
class, `TRAINER_CLASS_DAILYRED`, is his alone: it shows as "PKMN TRAINER" and
gives him his own battle theme. `Mugshot: Red` in the same entry gives his
battle the Elite Four/Champion VS encounter transition (the mugshot bands with
RED and LEAF) instead of a regular one: RED on a red band
(`MUGSHOT_COLOR_RED`, a palette made for him), LEAF on the blue one the game
gives a male player (`Mugshot_SetGfx` in `src/battle_transition.c`).

### Graphics

RED's battle looks like HeartGold/SoulSilver's on Mt. Silver, and so does the
summit itself (its tileset is in the patch, see above). The source art is in `art/`, and
`scripts/graphics/make-graphics.py` (Python 3 with Pillow) turns it into the
game's files; run it again after changing the art:

- `art/mt-silver-battle-bg/`: Mt. Silver's HGSS-style battle background by
  REKKA, already in the game's format (tiles, tilemap, the peaks that scroll
  past in the intro) with a palette for each time of day. It's copied to
  `graphics/battle_environment/dailyred_mt_silver/` for
  `BATTLE_ENVIRONMENT_SNOW`, which also makes Nature Power, Secret Power and
  Camouflage icy on the summit. The palette follows the player's clock
  (`DailyRed_GetMtSilverBattlePalette`): day until 5 pm (and the morning),
  evening 5–8 pm, night 8 pm–6 am (the evening hours in
  `include/constants/rtc.h` are Daily Red's; they were 7–8 pm).
- `art/red-hgss.png`: RED's HGSS battle sprite (ripped by ChrisX698), two
  frames: holding his cap up, looking at you, then tipping it down. GBA trainer
  pictures are 64×64 and 15 colours, and he's 69 pixels tall, so the script
  drops 5 near-identical rows from his jeans (keeping his cap and shoes
  whole). The first frame is his trainer picture (the VS transition); in
  battle his sprite uses both frames, uncompressed in the ROM: he slides in
  with his cap down, then lifts it to look at you and tips it back down
  (`DailyRed_AnimateTrainerSprite`).
- The battle interface (healthboxes, HP/EXP bars, textbox, status icons,
  gimmick buttons, text colours) and the window frames and message box in
  `graphics/text_window/` are the HGSS-style ones from
  [Eemeliri/soulgold](https://github.com/Eemeliri/soulgold), copied over
  FireRed's files of the same names and sizes. Like soulgold, the message
  window and the "What will X do?" prompt get their own palettes, and the HP
  bars use soulgold's bar palette (`src/battle_bg.c`, `src/graphics.c`).
  The ability/item pop-up prints in soulgold's dark text colour.
- The boxes at the bottom of the screen (messages, "What will X do?", the
  action menu, the moves and PP/type) share one rounded frame after RED's
  cap: red with a charcoal outline and a thin white stripe inside, around
  white text on dark grey (PP numbers too, yellow to red as they run low).
  `battle_boxes()` in the script draws the frame's 9 tiles into the textbox
  sheet and lays the boxes out on its tilemap, one tile of frame around the
  game's text windows. The action menu and move list print on their own copy
  of the text palette in those colours, and the cursor is erased
  with the box's inside (`DAILYRED_BATTLE_*` in `include/dailyred.h`).
- `art/leaf-hgss.png`: an HGSS-style LEAF for the VS transition (her battle
  back sprite is still FireRed's). She's 70 pixels tall and 21 colours, so 6
  rows go from her legs and 6 colours are merged: her bag's highlight first,
  then the closest pairs by eye, keeping her blouse's three blues.

### Sets

`expansion/src/dailyred_sets.c` is generated by `scripts/sets/generate.mjs`
from Pokémon Showdown's own Random Battle generators (pinned in
`scripts/sets/package.json`):

```sh
cd scripts/sets && npm install && node generate.mjs
```

It calls Showdown's `randomSet()` 400 times per species and keeps up to 10 of
the sets it produced (those that came up at least 2% of the time), with
Showdown's odds. Sets come from Gen 7 Random Battles (the last generation with
Mega Evolution and Z-Moves); species Gen 7 doesn't have (Galarian forms, Gen
8–9 species) come from Gen 8, then Gen 9, and Mega Meganium and Mega
Feraligatr from Showdown's Pokémon Champions Random Battles. Random Battle
sets have a neutral nature and the same EVs in every stat, so every set gets a
competitive spread instead (`competitiveSpread`): from Showdown's role for the
set, its attacks and its base stats, a fast attacker gets +Speed and 252
attack / 252 Speed (Jolly, Timid), a bulky one +attack and 252 HP / 252
attack (Adamant, Modest), a mixed one boosts its main attack or Speed at a
defence's expense (Naive, Lonely…), a defensive one +the defence it needs and
252 HP / 252 in it (Bold, Impish, Calm, Careful), and Trick Room or Gyro Ball
sets give up Speed (Brave, Quiet, Relaxed, Sassy). Each list also has your level
for the species, from its Showdown tier (see [Your team](#your-team)). Each species has a list per kind:
`NORMAL` (no Mega Stone or Z-Crystal: Showdown's sets for a team that already
has its Z-Move user), `MEGA` (a Mega Evolution's sets), `ZMOVE` (Z-Crystals
allowed, for RED's legendaries; for his starters on Mega Mewtwo days and your
Typhlosion it's always the crystal for their strongest STAB type) and
`TERA` (Gen 9 sets with their Tera type, for the starters). Gimmick sets are
left out: status Z-Moves (a Normalium Z for Hold Hands, Celebrate, Happy Hour
or Conversion), Splash, Gen 8 sets built for Dynamax (unless a Gen 8 species
has nothing else) and Tera Blast outside the Tera sets; the remaining sets
keep Showdown's odds among themselves. The script checks
every species, move, item and ability against the expansion's constants and
every ability against what the species can have, and fails on anything
missing. Your team uses the same table.

### The summit's wind

Like HGSS, the summit has no music, only the wind howling, until RED's battle
theme starts. `music/mt-silver-wind.ogg`, a loop of HGSS's summit wind
supplied by the project's owner, becomes a looping GBA sample and a one-note
song (`MUS_DAILYRED_MT_SILVER_WIND`, entry 611 in `sound/song_table.inc`):

```sh
python3 scripts/audio/make-wind.py      # needs ffmpeg
```

writes `sound/direct_sound_samples/dailyred_mt_silver_wind.wav` (13379 Hz
mono, its end crossfaded into its start so the loop doesn't click, made about
8 dB louder with soft clipping, and a `smpl` loop chunk for wav2agb) and
`sound/songs/midi/mus_dailyred_mt_silver_wind.mid` (one note held forever,
before the song's loop, on the voice in `sound/voicegroups/dailyred_mt_silver_wind.inc`).
In the game it averages about −20 dBFS, about as loud as RED's battle theme.
It's map music outside `START_MUS`–`END_MUS`, so `GetNightMusicFromTrack`
(`src/overworld.c`) now checks the range instead of reading past its table.

### RED's battle theme

RED's battle plays a "vs Red" track (`MUS_DAILYRED_VS_RED`) instead of
FireRed's Champion theme. It's built from a MIDI, `music/vs-red.mid`, a Sappy
dump of a GBA song supplied for the project, through the expansion's own
`mid2agb`, like every other song in the game:

1. `node scripts/prepare-midi.mjs music/vs-red.mid expansion/sound/songs/midi/mus_dailyred_vs_red.mid`
   makes the dump readable by mid2agb: Sappy stores each track's pitch-bend
   range (12 semitones here) as an RPN and puts the loop markers in the first
   instrument track, while mid2agb only reads a bend range from CC 20 and loop
   markers from the first track, so without this the bends are a sixth of
   their size and the song plays once and stops. Expression (CC 11), which
   mid2agb ignores, is folded into volume. Notes, instruments, bends and tempo
   are untouched.
2. `sound/songs/midi/midi.cfg` converts it with `-E -R50 -G_dailyred_vs_red -V110`:
   FireRed's battle theme settings, with the master volume raised from 90 to
   110 so it's as loud as the Champion theme it replaces (both average about
   −18 to −19 dBFS in RED's battle, peaking under −2.5 dBFS).
3. Its voicegroup, `sound/voicegroups/dailyred_vs_red.inc`, is FireRed's
   Champion battle voicegroup. The song was arranged for that layout (the same
   instruments at the same program numbers: guitars, strings, horns, timpani,
   drum kit, square and wave leads, noise hi-hat), with the few slots it uses
   that the Champion's leaves empty, or that would make two parts fight over a
   GBA sound channel, filled with FireRed's usual voice for that program. Each
   synth part gets a channel of its own: square 1, square 2, the wave channel
   and noise.
4. The song is entry 610 in `sound/song_table.inc`, after the last existing
   one, so no other song ID moves.

To use another track, replace `music/vs-red.mid`, rerun step 1 and rebuild;
if it was arranged for a different voicegroup, adjust
`dailyred_vs_red.inc` (the comments list what each used slot plays). The battle
starts without the trainer "eyes meet" jingle, so the theme is the first thing
you hear. `npm run music` (in `tests/`) records the battle's audio to
`tests/output/vs-red.wav` to listen to.

## Development workflow

1. Edit files in `expansion/` (a git checkout of pokeemerald-expansion).
2. `scripts/build-rom.sh` (incremental builds take a minute or so: the
   expansion links with link-time optimization).
3. Reload the page. `scripts/serve.mjs` sends `Cache-Control: no-cache`.
4. When you're happy, run `scripts/save-patch.sh` and commit
   `patches/expansion-dailyred.patch`.

`expansion/`, `.toolchain/`, `web/vendor/` and `web/game/` are not tracked
(see `.gitignore`); a clean checkout recreates them with the scripts above.
`git -C expansion diff` shows all game changes against upstream.

To play the ROM outside the browser, open `expansion/pokefirered.gba` in mGBA
or any GBA emulator. Without an injected seed it boots to the title screen;
press Start.

The website has no build step: plain HTML, CSS and ES modules in `web/`.

## Testing and debugging

The tests boot the real ROM in headless Chrome through the same emulator the
website uses, press buttons, and read game RAM out of emulator save states
(mGBA's state contains a raw copy of RAM). They get everything else from the
build itself (`tests/game.mjs`): constants and struct layouts by compiling a
small generated C file against `expansion/include` with the project
toolchain, and species, move and item data (base stats, learnsets, names) from
the ROM's own tables, so nothing about the game is copied into the tests.

```sh
cd tests
npm install        # playwright-core only; it drives your installed Google Chrome
npm run smoke      # the game loop (~3 min)
npm run site       # the website on desktop and phone (~1 min)
npm run teams -- 1 2 3            # print + validate the teams (yours and RED's) for these seeds
npm run teams -- --random 40      # 40 random seeds
npm run teams -- --red-cases      # a seed for each of RED's rolls, and mirror days (28 seeds)
npm run gimmicks   # RED Mega Evolves, uses Z-Moves and Terastallizes in battle (~3 min)
npm run music      # record RED's battle music to tests/output/vs-red.wav (~2 min)
```

`npm run smoke` checks that:
- your team follows its rules (`validateTeam` in `tests/party.mjs`, written
  independently of the C code) for each seed and after each run: a starter
  that counters RED's (read from his party) with its Mega Stone, or Typhlosion
  with a Firium Z; the others fully evolved, in scope, holding no Mega Stone
  or Z-Crystal, at their tier's level (95–98); at most one legendary; one of
  each Pokémon's Showdown sets; perfect stats; no type on more than two and
  no species twice; a base stat total of at least 2700; and mirror-RED days
  exactly when the seed's roll (predicted in JavaScript) says so, checked on a
  mirror-day seed too (shiny Pikachu, a legendary).
- the same seed gives the same team, and different seeds give different ones.
- the player starts at the foot of the stairs, RED faces away from them (and
  again after every run), and talking to RED starts a trainer battle on
  Mt. Silver's background (the snow environment, whose graphics are checked
  in the ROM too).
- battle style is SET from the start, the Options menu can't change it, and
  when one of RED's Pokémon is knocked out he sends the next one with no
  "Will Blue change POKéMON?" prompt.
- RED's AI flags in the ROM are Smart Trainer and Prediction, his battle
  opens with the VS mugshot transition on his red band and uses his HGSS sprite;
  every entry of his Gen 1–3 pick is in the Gen 1–3 Pokédex, fully evolved
  and not a starter, legendary or mythical; all of Pikachu's sets have a Light Ball and
  Volt Tackle; no `NORMAL` set holds a Mega Stone or Z-Crystal; and there are
  no gimmick sets (every Z-Crystal powers up one of its set's attacks).
- RED's team follows his rules (`validateRed` in `tests/red.mjs`, written
  independently of the C code) for each seed and after each run: the right
  starter, legendary and original-team day for the seed's rolls (predicted in
  JavaScript from his RNG), levels, Mega Stone / Z-Crystal / Tera rules, one of
  each Pokémon's Showdown sets (from the table in the ROM), perfect stats,
  genders, the type and Eeveelution limits and the lead; the same seed gives
  the same RED; he battles with that team; and the summit's snow doesn't
  start any battle weather.
- the player starts with a Mega Ring and a Z-Power Ring; affection and
  friendship boosts are off in the build, and a team at max friendship (five
  hearts in battle) never hangs on to a knockout blow: 20 tries at 1 HP with
  nothing else that could save it, each from a different RNG state, all faint
  (with affection on, about 4 would survive).
- the later-evolution list in `dailyred_team.c` matches what the ROM's
  evolution tables lead to from Generations 1–3, and every team is in scope.
- RED's lines are "…", "…" and "…!", the record and come-back-tomorrow
  messages are still there, and his battle plays the vs Red theme: the song
  playing in RAM, its song table entry and voicegroup, and a loop on every
  track.
- a win and a loss are each handled: no white-out, counters updated, and a new
  valid team afterwards.
- the daily game starts from the website's record, reports the battle start,
  the result and the end, counts the battle in its record message, and
  ignores input once it's over (no second battle).
- without a seed, the title screen appears and Start leads into the game.

The win and loss are forced by editing HP values in a save state, which makes
them quick and deterministic. Screenshots of every step are saved in
`tests/output/`.

`npm run teams -- --red-cases` finds the first seed for each of RED's rolls
(the original team, and every legendary for every starter) and validates
those teams. `npm run gimmicks` moves the Pokémon carrying each gimmick to the
front of RED's team and plays turns against a Splash-only Pokémon until he
uses it: Mega Evolution (a starter, and Mega Mewtwo), Z-Moves (the starter on
a Mega Mewtwo day, and on an original-team day) and Terastallization (with
Smart Tera turned off for that one, since the AI only Terastallizes when its
damage calculations say it pays), and checks that he never Dynamaxes.

`npm run music` starts RED's battle and records the emulator's audio output
(the sound the website plays) for 75 seconds, past the song's loop point, to
`tests/output/vs-red.wav`. It checks that the theme is the song playing, that
there's music the whole time (no silent second), that nothing clips, and that
it's still the theme after the loop.

`npm run site` plays the daily game over five faked days (Playwright's clock):
a fresh visitor, a win (stats, locked until tomorrow, countdown, survives a
reload), the same team in a second browser that day, a loss the next day,
leaving mid-battle (counts as a loss), a missed day (streaks reset), and a
practice run (`?seed=`, not recorded). It also checks the 3× (720×480)
screen, RED's sprite, the phone layout and touch d-pad, and the download-error
screen with "Try again".

**Checking by hand:** open `http://localhost:8080/?seed=42` for a practice run
(nothing saved, no daily limit). To reset your daily stats, run
`localStorage.removeItem('dailyred-stats')` in the browser console.

**In the browser console:** `dailyRed.emulator` is the running Nostalgist
instance and `dailyRed.stats` shows your saved stats.

## Running it locally

Daily Red is meant to be played on your own computer. After the quick start,
`web/` holds the whole site (about 9 MB), and `node scripts/serve.mjs` serves
it at http://localhost:8080:

```
web/index.html  app.js  daily.js  game-link.js  game-files.js  rom-config.js  style.css  favicon.svg  licenses.txt
web/vendor/     emulator (3.4 MB) + font
web/game/       dailyred.gba.gz (17.5 MB), built on your machine
```

To use another port, pass it: `node scripts/serve.mjs 3000`. Your stats are
saved in the browser for that address, so keep using the same port to keep
your streaks. After rebuilding the ROM (`scripts/build-rom.sh`), reload the
page.

## Copyright and licenses

Daily Red is a free, unofficial fan project. It isn't affiliated with or
endorsed by Nintendo, Creatures Inc., GAME FREAK inc. or The Pokémon Company.
Pokémon and all related names, characters and game content are © Nintendo,
Creatures Inc. and GAME FREAK inc.

This repository contains Daily Red's own work: the changes in `patches/`, the
website and the tests. It doesn't include pokeemerald-expansion or a built ROM;
the scripts fetch the expansion from its repository and build locally. The
exceptions are RED's battle theme, `music/vs-red.mid` (and its prepared copy
in the patch), a MIDI of a GBA song supplied by the project's owner, the
summit's wind, `music/mt-silver-wind.ogg` (HGSS's, supplied by the project's
owner, and the sample made from it in the patch), and the
art in `art/` (and the graphics made from it in the patch): Mt. Silver's
battle background is REKKA's, RED's battle sprite is HeartGold/SoulSilver's
(ripped by ChrisX698), and LEAF's HGSS-style sprite, the Mt. Silver
summit tileset (HGSS-derived) and the HGSS screenshot the summit's clouds
are cut from were supplied by the project's owner.

The emulator core is GPL-3.0 (RetroArch) and MPL-2.0 (mGBA). `web/licenses.txt`
lists all third-party components with links to their source, and the page
footer links to it.

## Known limitations

- **Movement:** running shoes and the bike are off on the summit; it's only
  a few steps to the top.
- **Stats live in the browser:** clearing site data resets them, they don't
  follow you to another device or browser, and anyone can edit their own
  localStorage. That's fine for a casual daily game; there's no server.
- **Time zones:** the day changes at local midnight, so players in different
  time zones get each team at different times (as with Wordle).
- **Soft reset** (A+B+Start+Select) is turned off in the daily game, so a
  losing battle can't be restarted. (If the game ever restarts mid-battle
  anyway, the site counts it as a loss.)
- **Audio:** the tests can record and measure it (`npm run music`) but not
  judge how it sounds. Browsers start audio suspended unless it begins during
  a click, so the game resumes it on the next key press or tap.
- **Tested environment:** headless Chrome/Chromium (desktop and phone
  emulation). Not yet tried on Safari, Firefox or real phones.
- **Download size:** the expansion's ROM carries every Pokémon up to Gen 9, so
  the gzipped game is about 17.5 MB (V1's was 5.5 MB).

## Project layout

```
patches/expansion-dailyred.patch     all changes to pokeemerald-expansion
scripts/setup-macos.sh               toolchain (xPack arm-none-eabi-gcc 14.2.1 + libpng)
scripts/get-expansion.sh             pinned upstream checkout (1.17.1) + patch
scripts/save-patch.sh                expansion/ changes → patches/
scripts/build-rom.sh                 make firered → web/game/dailyred.gba.gz
scripts/fetch-vendor.sh              Nostalgist, mGBA core, font (pinned, checksummed)
scripts/serve.mjs                    local static server
scripts/prepare-midi.mjs             Sappy MIDI dump → MIDI that mid2agb reads
scripts/sets/generate.mjs            Showdown Random Battle sets → expansion/src/dailyred_sets.c
scripts/graphics/make-graphics.py    art/ → Mt. Silver's battle background and the HGSS-style sprites
art/                                 source art (see Graphics)
music/vs-red.mid                     RED's battle theme (source MIDI)
music/mt-silver-wind.ogg             the summit's wind (source loop)
scripts/audio/make-wind.py           the wind → a looping GBA sample and its song
web/                                 the website
tests/                               headless browser tests, the teams tool and the music recorder
```

Inside `expansion/`, the Daily Red code is `include/dailyred.h`,
`include/constants/dailyred.h`, `src/dailyred.c` (game flow and seed),
`src/dailyred_team.c` (your team), `src/dailyred_red.c` (RED's team),
`src/dailyred_mon.c` (helpers both use),
`src/dailyred_sets.c` (the generated sets), RED's entry at the end of
`src/data/trainers_frlg.party`, `data/maps/DailyRed_Summit/` plus
`data/layouts/DailyRed_Summit/` (the map), and his battle theme:
`sound/songs/midi/mus_dailyred_vs_red.mid` (with its line in `midi.cfg`, which
can't hold comments) and `sound/voicegroups/dailyred_vs_red.inc`.
