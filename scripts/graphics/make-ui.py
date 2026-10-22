#!/usr/bin/env python3
"""Builds the menus' graphics for the expansion from the art in art/: the
BW-style option menu, the start menu's shelf of icons, the BW-style summary
screen and the EV/IV screen (community FireRed hacks, see README.md), each
recoloured to Daily Red's red UI: their teal, cyan and blue tones become
reds of the same lightness, and their tinted greys the battle boxes'
neutral, slightly blue greys.

    python3 scripts/graphics/make-ui.py
"""
import colorsys
import os
import shutil

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..'))
ART = os.path.join(ROOT, 'art')
GAME = os.path.join(ROOT, 'expansion')
OUT = os.path.join(GAME, 'graphics', 'dailyred')

RED_HUE = 0.985          # the battle boxes' red (216, 40, 48)
GREY_SATURATION = 0.25   # below this a colour counts as a grey


def read_jasc(path):
    with open(path) as f:
        lines = f.read().split()
    assert lines[0] == 'JASC-PAL'
    count = int(lines[2])
    v = list(map(int, lines[3:3 + count * 3]))
    return [tuple(v[i:i + 3]) for i in range(0, count * 3, 3)]


def write_jasc(path, colours):
    with open(path, 'w', newline='\r\n') as f:
        f.write('JASC-PAL\n0100\n%d\n' % len(colours))
        for r, g, b in colours:
            f.write('%d %d %d\n' % (r, g, b))


def gba(c):
    return tuple(min(248, int(round(v / 8)) * 8) for v in c)


def redden(c):
    """One colour in the red scheme: greys become neutral greys with a touch
    of blue (like the battle boxes' 40, 40, 48), anything with colour becomes
    a red of the same brightness. Pure reds, oranges and yellows (types,
    status icons) are left alone."""
    r, g, b = (v / 255 for v in c)
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    if s < GREY_SATURATION:
        level = (r * 0.3 + g * 0.55 + b * 0.15) * 255
        return gba((level, level, level + 8 if level > 16 else level))
    if h < 0.15 or h > 0.9:  # already warm
        return c
    r, g, b = colorsys.hsv_to_rgb(RED_HUE, min(1.0, s * 1.1), v)
    return gba((r * 255, g * 255, b * 255))


def copy(src, dst):
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copyfile(src, dst)


# --- Window frame ------------------------------------------------------------------

# art/text-window/1.png is soulgold's HGSS window frame (frame type 1, the
# default: the start menu's box, the option menu's description, yes/no
# boxes), whose sides are three blues. They become the battle boxes' reds.
FRAME_SIDES = {
    2: (216, 40, 48),     # (96, 112, 192)
    4: (248, 112, 104),   # (144, 160, 216)
    7: (248, 200, 200),   # (200, 208, 232)
}


def window_frame():
    from PIL import Image
    img = Image.open(os.path.join(ART, 'text-window', '1.png'))
    pal = img.getpalette()
    for i, c in FRAME_SIDES.items():
        pal[i * 3:i * 3 + 3] = c
    img.putpalette(pal)
    img.save(os.path.join(GAME, 'graphics', 'text_window', '1.png'))
    print('window frame 1: red sides')


# --- Option menu -------------------------------------------------------------------

# art/bw-option-menu/ is FR-OptionMenu's (CompuMaxx's BW-style option menu):
# 21 tiles, a tilemap per selected row (map_0-5.bin) and 7 palettes loaded
# from BG palette 5 (the text's, replaced below, then the rows' 10 and 11).
OPTION_TEXT = [
    (0, 0, 0),         # 0 transparent
    (248, 248, 248),   # 1 white text
    (24, 24, 32),      # 2 its shadow
    (128, 128, 136),   # 3 an option not chosen
    (48, 48, 56),      # 4 its shadow
    (64, 64, 72),      # 5 the description (on the window frame)
    (208, 208, 216),   # 6 its shadow
]


def option_menu():
    src = os.path.join(ART, 'bw-option-menu')
    out = os.path.join(OUT, 'option_menu')
    os.makedirs(out, exist_ok=True)
    pal = read_jasc(os.path.join(src, 'palette.pal'))
    pal = [redden(c) for c in pal]
    pal[:16] = OPTION_TEXT + [(0, 0, 0)] * (16 - len(OPTION_TEXT))
    write_jasc(os.path.join(out, 'palette.pal'), pal)
    copy(os.path.join(src, 'tiles.png'), os.path.join(out, 'tiles.png'))
    for i in range(6):
        copy(os.path.join(src, 'map_%d.bin' % i), os.path.join(out, 'map_%d.bin' % i))
    print('option menu: %d colours -> %s' % (len(pal), os.path.relpath(out, ROOT)))


# --- Start menu --------------------------------------------------------------------

# art/start-menu/shelves.png holds the 25 pictures of the start menu patch
# (MENU_START_MI_PARCHE_REPUNTEADO, a FireRed hack: its graphics at
# 0x9920000, LZ-compressed, one 16-colour palette): a shelf of icons along
# the bottom of the screen, 17x7 tiles, one picture per set of icons and
# selected icon (it stands up off the shelf; the first of each set has none
# up). The sets, by first picture:
SHELF_SETS = {
    # first picture, the shelf's ends (left, right), its icons
    0: (27, 115, ['bag', 'card', 'save', 'option']),
    5: (15, 123, ['pokemon', 'bag', 'card', 'save', 'option']),
    11: (0, 135, ['pokedex', 'pokemon', 'bag', 'card', 'save', 'option']),
    18: (0, 135, ['retire', 'pokedex', 'pokemon', 'bag', 'card', 'option']),
}
# Daily Red's shelf: the team, the EV/IV screen (the Pokedex), the options
# and the U-turn arrow for leaving the menu; src/start_menu.c's order.
SHELF_ICONS = ['pokemon', 'pokedex', 'option', 'retire']
SHELF_ENDS = (21, 117)       # a shelf a little longer than the 4-icon one
SHELF_W, SHELF_H = 136, 56
SHELF_TOP, SHELF_FRONT, SHELF_BOTTOM = 40, 46, 48   # its rows
SHELF_TOP_COLOUR, SHELF_EDGE, SHELF_OUTLINE = 4, 12, 13
SHELF_RED, SHELF_DARK_RED = 14, 15                  # new palette entries
SHELF_REDS = {SHELF_RED: (216, 40, 48), SHELF_DARK_RED: (144, 16, 32)}


def shelf(left, right, front=(SHELF_EDGE, SHELF_EDGE)):
    """An empty shelf as the patch draws it: a top in perspective (its ends
    slope out a pixel a row), a 2-row front, an outline."""
    img = [[0] * SHELF_W for _ in range(SHELF_H)]
    for r in range(SHELF_TOP, SHELF_BOTTOM + 1):
        inset = max(0, SHELF_FRONT - r)
        a, b = left + inset, right - inset
        for x in range(a, b + 1):
            if x in (a, b) or r == SHELF_BOTTOM:
                img[r][x] = SHELF_OUTLINE
            elif r < SHELF_FRONT:
                img[r][x] = SHELF_TOP_COLOUR
            else:
                img[r][x] = front[r - SHELF_FRONT]
    return img


def start_menu():
    from PIL import Image
    sheet = Image.open(os.path.join(ART, 'start-menu', 'shelves.png'))
    frames = [[[sheet.getpixel((x, k * SHELF_H + r)) for x in range(SHELF_W)] for r in range(SHELF_H)]
              for k in range(sheet.height // SHELF_H)]

    # Each icon, down and up: what its pictures have that the empty shelf
    # hasn't, in its columns (the icons are separated by empty columns).
    icons = {}
    for first, (left, right, names) in SHELF_SETS.items():
        empty = shelf(left, right)
        down = frames[first]
        cols = [x for x in range(SHELF_W) if any(down[r][x] != empty[r][x] for r in range(SHELF_H))]
        groups = []
        for x in cols:
            if groups and x == groups[-1][1] + 1:
                groups[-1][1] = x
            else:
                groups.append([x, x])
        assert len(groups) == len(names), (first, groups)
        for i, (name, (a, b)) in enumerate(zip(names, groups)):
            if name in icons:
                continue
            up = frames[first + 1 + i]
            icons[name] = {}
            for state, f in (('down', down), ('up', up)):
                icons[name][state] = {(r, x - a): f[r][x] for r in range(SHELF_H) for x in range(a - 2, b + 3)
                                      if f[r][x] != empty[r][x]}
            icons[name]['width'] = b - a + 1

    # Daily Red's shelf, one picture per selected icon, the icons spread
    # evenly over it.
    left, right = SHELF_ENDS
    widths = [icons[n]['width'] for n in SHELF_ICONS]
    start, end = left + 6, right - 6
    gap = (end - start + 1 - sum(widths)) / (len(widths) - 1)
    xs, x = [], start
    for w in widths:
        xs.append(round(x))
        x += w + gap
    out = Image.new('P', (SHELF_W, SHELF_H * len(SHELF_ICONS)))
    pal = sheet.getpalette()[:48]
    colours = [tuple(pal[i:i + 3]) for i in range(0, 48, 3)]
    colours = [colours[0]] + [redden(c) for c in colours[1:]]
    for i, c in SHELF_REDS.items():
        colours[i] = c
    out.putpalette([v for c in colours for v in c])
    for sel in range(len(SHELF_ICONS)):
        img = shelf(left, right, front=(SHELF_RED, SHELF_DARK_RED))
        for i, name in enumerate(SHELF_ICONS):
            for (r, dx), v in icons[name]['up' if i == sel else 'down'].items():
                if 0 <= xs[i] + dx < SHELF_W:
                    img[r][xs[i] + dx] = v
        for r in range(SHELF_H):
            for x in range(SHELF_W):
                out.putpixel((x, sel * SHELF_H + r), img[r][x])
    dst = os.path.join(OUT, 'start_menu')
    os.makedirs(dst, exist_ok=True)
    out.save(os.path.join(dst, 'shelf.png'))
    print('start menu: %d pictures of %s at x %s' % (len(SHELF_ICONS), SHELF_ICONS, xs))


# --- EV/IV screen ------------------------------------------------------------------

# art/ev-iv/ is Gender-based-EV-IV-Display's (Acimut, Shiny Miner, Tio
# Terry): 140 tiles and a 32x20 tilemap, and the colours for a girl player
# (girl_palette.png's), which are already maroon. Daily Red's: the battle
# boxes' red for its lines and neutral dark greys for its panels.
EVIV_PALETTE = [
    (240, 240, 240),   # 0 the table
    (128, 128, 136),   # 1 its lines
    (168, 32, 40),     # 2 the panels' grid and edges (165, 33, 41)
    (96, 32, 40),      # 3 the grid behind the Pokemon (156, 33, 33)
    (48, 40, 48),      # 4 the panels (57, 24, 41)
    (112, 24, 32),     # 5 (82, 16, 16)
    (32, 32, 40),      # 6 behind the Pokemon (16, 41, 57)
    (40, 32, 40),      # 7 (49, 24, 33)
]


def ev_iv():
    from PIL import Image
    src = os.path.join(ART, 'ev-iv')
    out = os.path.join(OUT, 'ev_iv')
    os.makedirs(out, exist_ok=True)
    tiles = Image.open(os.path.join(src, 'tiles.png'))
    pal = EVIV_PALETTE + [(0, 0, 0)] * (16 - len(EVIV_PALETTE))
    tiles.putpalette([v for c in pal for v in c])
    tiles.save(os.path.join(out, 'tiles.png'))
    copy(os.path.join(src, 'map.bin'), os.path.join(out, 'map.bin'))
    print('EV/IV screen -> %s' % os.path.relpath(out, ROOT))


# --- Summary screen ----------------------------------------------------------------

# art/bw-summary/ is New-BW-summary-screen's (CompuMaxx's BW-style summary,
# ported by Zake): the page tiles and tilemaps (the scrolling grid, a panel
# per page, the move list's frames), the HP and EXP bars, status icons, the
# shiny star and the move cursor. The tiles' palette and the cursor's are
# recoloured (their teal grid and purple frames become red); the bars keep
# their green, yellow and red.
SUMMARY_RECOLOUR = ['tiles.png', 'cursor_left.png', 'cursor_right.png']
SUMMARY_COPY = ['bg.bin', 'bg_pokemon_info.bin', 'bg_pokemon_skills.bin', 'bg_known_moves.bin', 'bg_moves.bin',
                'bg_moves_info.bin', 'title.pal', 'hp_bar.png', 'exp_bar.png', 'hp_bar_0.pal', 'hp_bar_1.pal',
                'hp_bar_2.pal', 'icon_status.png', 'shiny_indicator_gfx.png']


def summary():
    from PIL import Image
    src = os.path.join(ART, 'bw-summary')
    out = os.path.join(OUT, 'summary')
    os.makedirs(out, exist_ok=True)
    for name in SUMMARY_RECOLOUR:
        img = Image.open(os.path.join(src, name))
        pal = img.getpalette()[:48]
        colours = [tuple(pal[i:i + 3]) for i in range(0, 48, 3)]
        colours = [colours[0]] + [redden(c) for c in colours[1:]]
        img.putpalette([v for c in colours for v in c])
        img.save(os.path.join(out, name))
    for name in SUMMARY_COPY:
        copy(os.path.join(src, name), os.path.join(out, name))
    print('summary screen -> %s' % os.path.relpath(out, ROOT))


# --- FireRed's font ----------------------------------------------------------------

# art/firered-font/ is FireRed's Latin text (pret/pokefirered's
# graphics/fonts/latin_normal.png and latin_small.png, and the glyph widths
# from its src/text.c): the expansion's FONT_NORMAL and FONT_SMALL draw it
# instead of Emerald's. The normal font's sheet is the same 16x16-cell
# format as the expansion's; FireRed's small font is half width (8x16 cells,
# 32 to a row), so its glyphs go in the left half of 16x16 cells. The widths
# replace the two tables in src/fonts.c.
def firered_font():
    import json
    import re
    from PIL import Image
    src = os.path.join(ART, 'firered-font')
    fonts = os.path.join(GAME, 'graphics', 'fonts')
    copy(os.path.join(src, 'latin_normal.png'), os.path.join(fonts, 'latin_normal.png'))
    half = Image.open(os.path.join(src, 'latin_small.png'))
    full = Image.new('P', (256, 512), 0)
    full.putpalette(half.getpalette())
    for glyph in range((half.width // 8) * (half.height // 16)):
        cell = half.crop(((glyph % 32) * 8, (glyph // 32) * 16, (glyph % 32) * 8 + 8, (glyph // 32) * 16 + 16))
        full.paste(cell, ((glyph % 16) * 16, (glyph // 16) * 16))
    full.save(os.path.join(fonts, 'latin_small.png'))

    widths = json.load(open(os.path.join(src, 'glyph_widths.json')))
    path = os.path.join(GAME, 'src', 'fonts.c')
    text = open(path).read()
    for name, key in (('gFontNormalLatinGlyphWidths', 'normal'), ('gFontSmallLatinGlyphWidths', 'small')):
        rows = ',\n'.join('    ' + ', '.join('%2d' % w for w in widths[key][i:i + 16]) for i in range(0, 512, 16))
        text, n = re.subn(r'(const u8 %s\[\] = \{\n).*?(\n\};)' % name, lambda m: m.group(1) + rows + ',' + m.group(2), text, flags=re.S)
        assert n == 1, name
    open(path, 'w').write(text)
    print('FireRed font: latin_normal, latin_small and their widths')


if __name__ == '__main__':
    window_frame()
    option_menu()
    firered_font()
    start_menu()
    ev_iv()
    summary()
