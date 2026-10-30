# Mega Typhlosion

Mega Typhlosion is from [Pokémon Insurgence](https://p-insurgence.com), a free
fan game by the Pokémon Insurgence team (lead developer 1ofthe4rocketbros,
previous lead developer TheSuzerain, programmer Deukhoofd, lead artist
EchoTheThird, and its other artists). Its design, types, base stats, ability
(Hubris) and Mega Stone (Typhlosionite) are theirs, from the
[Pokémon Insurgence wiki](https://wiki.p-insurgence.com/Typhlosion_(Pok%C3%A9mon)).

The sprites and the party icon were supplied by the project's owner:

| File | What |
|---|---|
| `front.png` | front |
| `front_shiny.png` | shiny front (red fur, blue flames) |
| `icon.png` | party icon: its two 32x32 frames side by side, full colour (`mega_typhlosion_icon()` stacks them and puts them on icon palette 3) |
| `back.png` | back: FYTYNo1's [Mega Typhlosion GBA sprite](https://www.deviantart.com/fytyno1/art/Mega-Typhlosion-GBA-sprite-687447672) (2017, after fan art by Tomycase) with its smoke extended up and out. Its old smoke's darkest shade was set to the new smoke's dark grey (65, 65, 65), so that grey is the only smoke colour that shares nothing with the fur |

`mega_typhlosion()` in `scripts/graphics/make-graphics.py` makes the game's
sprites from these: one 16-colour palette for front and back, the shiny
palette read from `front_shiny.png`, and the back's colours given the front's
palette slots so it turns shiny the same way. See "Mega Typhlosion (Pokémon
Insurgence)" in the README. Used with credit; Daily Red isn't affiliated with
or endorsed by the Insurgence team or the artists.
