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
