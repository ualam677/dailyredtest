// Hand-written lead and utility sets, after Smogon's analyses: entry hazard
// leads (Stealth Rock, Spikes, Toxic Spikes, Sticky Web), Focus Sash and
// suicide leads (Destiny Bond, Memento, Explosion), sleep leads, screens and
// weather setters. Showdown's Random Battle generators hardly make these (a
// lead Aerodactyl gets a Focus Sash about 5% of the time), so generate.mjs adds
// them to each species' NORMAL list: together they get LEAD_SHARE of the
// list's odds, split evenly; Showdown's sets share the rest.
//
// The generator checks every species, item, ability and move against the
// expansion, every ability against the species and every move against its
// learnset (any generation, its pre-evolutions included).
//
// EVs are HP/Atk/Def/SpA/SpD/Spe. IVs are always 31 (the ROM maxes them all
// anyway; Hidden Power isn't used here).

export const LEAD_SHARE = 0.25;

const FAST_PHYSICAL = { hp: 0, atk: 252, def: 4, spa: 0, spd: 0, spe: 252 };
const FAST_SPECIAL = { hp: 0, atk: 0, def: 0, spa: 252, spd: 4, spe: 252 };
const FAST_MIXED = { hp: 0, atk: 4, def: 0, spa: 252, spd: 0, spe: 252 };
const FAST_SUPPORT = { hp: 252, atk: 0, def: 4, spa: 0, spd: 0, spe: 252 };
const BULKY_PHYSICAL = { hp: 252, atk: 252, def: 4, spa: 0, spd: 0, spe: 0 };
const BULKY_SPECIAL = { hp: 252, atk: 0, def: 0, spa: 252, spd: 4, spe: 0 };
const PHYSICALLY_DEFENSIVE = { hp: 252, atk: 0, def: 252, spa: 0, spd: 4, spe: 0 };
const SPECIALLY_DEFENSIVE = { hp: 252, atk: 0, def: 4, spa: 0, spd: 252, spe: 0 };

const set = (species, item, ability, moves, nature, evs, role = 'Lead') => ({ species, item, ability, moves, nature, evs, role });

export const LEAD_SETS = [
  // --- Entry hazard leads -------------------------------------------------------
  set('Aerodactyl', 'Focus Sash', 'Unnerve', ['Stealth Rock', 'Taunt', 'Stone Edge', 'Earthquake'], 'Jolly', FAST_PHYSICAL),
  set('Smeargle', 'Focus Sash', 'Own Tempo', ['Sticky Web', 'Stealth Rock', 'Spore', 'Taunt'], 'Jolly', FAST_SUPPORT),
  set('Smeargle', 'Focus Sash', 'Own Tempo', ['Spikes', 'Stealth Rock', 'Spore', 'Whirlwind'], 'Jolly', FAST_SUPPORT),
  set('Shuckle', 'Mental Herb', 'Sturdy', ['Sticky Web', 'Stealth Rock', 'Encore', 'Toxic'], 'Careful', SPECIALLY_DEFENSIVE),
  set('Ariados', 'Focus Sash', 'Insomnia', ['Sticky Web', 'Toxic Spikes', 'Sucker Punch', 'Megahorn'], 'Jolly', FAST_PHYSICAL),
  set('Masquerain', 'Focus Sash', 'Intimidate', ['Sticky Web', 'Stun Spore', 'Hydro Pump', 'Bug Buzz'], 'Timid', FAST_SPECIAL),
  set('Omastar', 'Focus Sash', 'Swift Swim', ['Stealth Rock', 'Spikes', 'Hydro Pump', 'Ice Beam'], 'Modest', FAST_SPECIAL),
  set('Cloyster', 'Focus Sash', 'Skill Link', ['Spikes', 'Rapid Spin', 'Icicle Spear', 'Rock Blast'], 'Jolly', FAST_PHYSICAL),
  set('Kabutops', 'Focus Sash', 'Weak Armor', ['Stealth Rock', 'Rapid Spin', 'Stone Edge', 'Waterfall'], 'Jolly', FAST_PHYSICAL),
  set('Pinsir', 'Focus Sash', 'Mold Breaker', ['Stealth Rock', 'X-Scissor', 'Earthquake', 'Stone Edge'], 'Jolly', FAST_PHYSICAL),
  set('Mamoswine', 'Focus Sash', 'Thick Fat', ['Stealth Rock', 'Earthquake', 'Icicle Crash', 'Ice Shard'], 'Jolly', FAST_PHYSICAL),
  set('Golem', 'Custap Berry', 'Sturdy', ['Stealth Rock', 'Earthquake', 'Stone Edge', 'Explosion'], 'Adamant', BULKY_PHYSICAL),
  set('Metagross', 'Lum Berry', 'Clear Body', ['Stealth Rock', 'Meteor Mash', 'Earthquake', 'Explosion'], 'Adamant', BULKY_PHYSICAL),
  set('Nidoqueen', 'Black Sludge', 'Sheer Force', ['Stealth Rock', 'Toxic Spikes', 'Earth Power', 'Sludge Wave'], 'Modest', BULKY_SPECIAL),
  set('Weezing', 'Black Sludge', 'Levitate', ['Toxic Spikes', 'Will-O-Wisp', 'Pain Split', 'Sludge Bomb'], 'Bold', PHYSICALLY_DEFENSIVE),
  set('Roserade', 'Focus Sash', 'Natural Cure', ['Toxic Spikes', 'Sleep Powder', 'Leaf Storm', 'Sludge Bomb'], 'Timid', FAST_SPECIAL),
  set('Qwilfish', 'Focus Sash', 'Intimidate', ['Spikes', 'Toxic Spikes', 'Waterfall', 'Destiny Bond'], 'Jolly', FAST_PHYSICAL),
  set('Cacturne', 'Focus Sash', 'Water Absorb', ['Spikes', 'Sucker Punch', 'Seed Bomb', 'Destiny Bond'], 'Jolly', FAST_PHYSICAL),
  set('Glalie', 'Focus Sash', 'Inner Focus', ['Spikes', 'Taunt', 'Ice Shard', 'Explosion'], 'Jolly', FAST_PHYSICAL),
  set('Froslass', 'Focus Sash', 'Cursed Body', ['Spikes', 'Taunt', 'Icy Wind', 'Destiny Bond'], 'Timid', FAST_SPECIAL),
  set('Delibird', 'Focus Sash', 'Hustle', ['Spikes', 'Rapid Spin', 'Ice Shard', 'Destiny Bond'], 'Jolly', FAST_PHYSICAL),

  // --- Suicide leads -------------------------------------------------------------
  set('Dugtrio', 'Focus Sash', 'Arena Trap', ['Stealth Rock', 'Earthquake', 'Stone Edge', 'Memento'], 'Jolly', FAST_PHYSICAL),
  set('Electrode', 'Focus Sash', 'Aftermath', ['Taunt', 'Thunderbolt', 'Volt Switch', 'Explosion'], 'Hasty', FAST_MIXED),
  set('Gengar', 'Focus Sash', 'Cursed Body', ['Taunt', 'Shadow Ball', 'Sludge Wave', 'Destiny Bond'], 'Timid', FAST_SPECIAL),
  set('Mismagius', 'Focus Sash', 'Levitate', ['Taunt', 'Will-O-Wisp', 'Shadow Ball', 'Destiny Bond'], 'Timid', FAST_SPECIAL),

  // --- Sleep, Fake Out and other fast leads ----------------------------------------
  set('Breloom', 'Focus Sash', 'Technician', ['Spore', 'Mach Punch', 'Bullet Seed', 'Rock Tomb'], 'Jolly', FAST_PHYSICAL),
  set('Jynx', 'Focus Sash', 'Dry Skin', ['Lovely Kiss', 'Ice Beam', 'Psychic', 'Focus Blast'], 'Timid', FAST_SPECIAL),
  set('Alakazam', 'Focus Sash', 'Magic Guard', ['Psychic', 'Focus Blast', 'Shadow Ball', 'Encore'], 'Timid', FAST_SPECIAL),
  set('Ambipom', 'Silk Scarf', 'Technician', ['Fake Out', 'Double Hit', 'U-turn', 'Low Kick'], 'Jolly', FAST_PHYSICAL),
  set('Hitmonlee', 'Focus Sash', 'Unburden', ['Fake Out', 'High Jump Kick', 'Knock Off', 'Mach Punch'], 'Jolly', FAST_PHYSICAL),

  // --- Screens and weather -------------------------------------------------------------
  set('Espeon', 'Light Clay', 'Magic Bounce', ['Reflect', 'Light Screen', 'Psychic', 'Baton Pass'], 'Timid', FAST_SUPPORT),
  set('Mr. Mime', 'Light Clay', 'Filter', ['Reflect', 'Light Screen', 'Psychic', 'Taunt'], 'Timid', FAST_SUPPORT),
  set('Politoed', 'Damp Rock', 'Drizzle', ['Scald', 'Ice Beam', 'Encore', 'Toxic'], 'Bold', PHYSICALLY_DEFENSIVE),
  set('Ninetales', 'Heat Rock', 'Drought', ['Nasty Plot', 'Fire Blast', 'Solar Beam', 'Will-O-Wisp'], 'Timid', FAST_SPECIAL),
];
