#!/usr/bin/env python3
"""Turns Daily Red's source art (art/) into the game's graphics files.

    python3 scripts/graphics/make-graphics.py      (needs Pillow: pip install pillow)

- art/mt-silver-battle-bg/ (Mt. Silver's HGSS-style battle background, with
  day, evening and night palettes, already in the game's format) ->
  expansion/graphics/battle_environment/dailyred_mt_silver/.
- art/red-hgss.png (RED's HeartGold/SoulSilver battle sprite: two 37x69
  frames side by side, holding his cap up and tipping it down) and art/leaf-hgss.png (an
  HGSS-style LEAF, 33x70) -> 64x64 trainer front pics in
  expansion/graphics/trainers/front_pics/dailyred_*.png (the first frame),
  plus dailyred_red_anim.png with both of RED's frames (64x128, the same
  palette) for his animation in battle.

GBA trainer pics are at most 64x64 and 15 colours (plus transparency), so a
sprite that's too tall loses its most repetitive rows inside a band of the
sprite (the trousers or legs, where rows repeat), keeping the cap and shoes
whole, and colours that are too many are merged pairwise, closest first. The
output is deterministic; run it again after changing the art.
"""
import os
import shutil
import struct
from PIL import Image

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', '..'))
ART = os.path.join(ROOT, 'art')
GAME = os.path.join(ROOT, 'expansion')

TRANSPARENT = (255, 0, 255)  # palette index 0 (never drawn)


def write_jasc(path, colours, count):
    colours = list(colours) + [(0, 0, 0)] * (count - len(colours))
    with open(path, 'w', newline='\r\n') as f:
        f.write('JASC-PAL\n0100\n%d\n' % count)
        for r, g, b in colours:
            f.write('%d %d %d\n' % (r, g, b))


def to_gba(c):
    """The colour as the GBA shows it (5 bits per channel)."""
    return tuple((v >> 3) << 3 for v in c[:3])


# --- Battle background -------------------------------------------------------------

def battle_background():
    """Mt. Silver's battle background, already in the game's format: its
    tiles, tilemap (the scene, and a copy without the platforms further down
    for animations that shake the background), entry layer (the peaks that
    scroll past during the intro) and a palette per time of day."""
    src = os.path.join(ART, 'mt-silver-battle-bg')
    out = os.path.join(GAME, 'graphics', 'battle_environment', 'dailyred_mt_silver')
    os.makedirs(out, exist_ok=True)
    for name in os.listdir(out):
        os.remove(os.path.join(out, name))
    copies = {
        'terrain.png': 'tiles.png',
        'terrain.bin': 'map.bin',
        'terrain.pal': 'palette.pal',
        'terrain_evening.pal': 'palette_evening.pal',
        'terrain_night.pal': 'palette_night.pal',
        'anim.png': 'anim_tiles.png',
    }
    for a, b in copies.items():
        shutil.copyfile(os.path.join(src, a), os.path.join(out, b))
    # The entry layer's map covers the top 14 rows; the game loads a whole
    # 32x32 screen, so the rest is padded with empty tiles.
    with open(os.path.join(src, 'anim.bin'), 'rb') as f:
        anim = f.read()
    assert len(anim) <= 2048 and len(anim) % 64 == 0
    with open(os.path.join(out, 'anim_map.bin'), 'wb') as f:
        f.write(anim + b'\0' * (2048 - len(anim)))
    tiles = Image.open(os.path.join(out, 'tiles.png'))
    print('battle background: %s tiles, palettes for day, evening and night -> %s'
          % (tiles.size, os.path.relpath(out, ROOT)))


# --- Battle text boxes -------------------------------------------------------------

# The boxes at the bottom of the battle screen (messages, "What will X do?",
# the action menu, the move list and PP/type) all share one HGSS-style frame,
# drawn here as 9 tiles (corners, edges, fill) and laid out on the battle
# textbox tilemap. Each box's frame is one tile wide, so the game's text
# windows (graphics-independent, see sStandardBattleWindowTemplates) sit
# inside. Colours are in RED_UI below.
# Tiles 3-11: the HGSS sheet's own message box was there. (In battle, 18-26
# and 34-42 of the textbox's VRAM get the player's window frames.)
BOX_FIRST_TILE = 3
# Rings from the box's edge inwards, as textbox palette indices: a margin the
# battle background shows through, outline, frame light/mid/mid/dark, an
# accent line, then the white fill (15, the text windows' background).
BOX_RINGS = [0, 2, 3, 4, 4, 5, 8]
BOX_FILL = 15
BOX_RADIUS = 7
# Textbox palette 0, after RED's cap: a red frame with a thin white stripe
# inside, around dark grey with white text. 1, 6 and 15 are the "What will X
# do?" text (it prints with a copy of this palette); 2-5 and 8 are the frame
# (BOX_RINGS). The text, its shadow and the fill match DAILYRED_BATTLE_TEXT,
# _TEXT_SHADOW and _BOX_FILL in dailyred.h.
RED_UI = {
    1: (248, 248, 248),  # text
    2: (40, 24, 32),     # outline
    3: (248, 112, 104),  # frame light
    4: (216, 40, 48),    # frame
    5: (144, 16, 32),    # frame dark
    6: (88, 88, 96),     # text shadow
    8: (248, 248, 248),  # inner stripe
    15: (40, 40, 48),    # fill
}
# The battle cursor (tiles 1 and 2) in the text's colours.
CURSOR_TILES = (1, 2)
CURSOR_RECOLOUR = {10: 1, 8: 6}
# Boxes on the textbox tilemap (32 tiles wide): (top row, height, [(left
# column, width), ...]). Rows 14-19: messages; 34-39: the prompt and the
# action menu (whose cursor the game draws in columns 16 and 23); 54-59: the
# move list and PP/type.
BOXES = [
    (14, 6, [(0, 30)]),
    (34, 6, [(0, 15), (15, 15)]),
    (54, 6, [(0, 20), (20, 10)]),
]


def box_ring(x, y, size):
    """Which ring (0 = outermost) a pixel of a box size x size pixels is on:
    its distance from the edge, rounded at the corners."""
    def corner(cx, cy):
        dx, dy = max(0, BOX_RADIUS - cx - 0.5), max(0, BOX_RADIUS - cy - 0.5)
        return max(0, int(BOX_RADIUS - (dx * dx + dy * dy) ** 0.5 + 0.5)) if dx and dy else None
    d = min(x, y, size - 1 - x, size - 1 - y)
    cx, cy = min(x, size - 1 - x), min(y, size - 1 - y)
    rounded = corner(cx, cy)
    return min(d, rounded) if rounded is not None else d


def battle_boxes():
    path = os.path.join(GAME, 'graphics', 'battle_interface')
    sheet = Image.open(os.path.join(path, 'textbox.png'))
    # The 9 tiles, cut from a 3x3-tile box.
    size = 24
    for i in range(9):
        tx, ty = (i % 3) * 8, (i // 3) * 8
        tile = BOX_FIRST_TILE + i
        sx, sy = (tile % 16) * 8, (tile // 16) * 8
        for y in range(8):
            for x in range(8):
                ring = box_ring(tx + x, ty + y, size)
                sheet.putpixel((sx + x, sy + y), BOX_RINGS[ring] if ring < len(BOX_RINGS) else BOX_FILL)
    for tile in CURSOR_TILES:
        sx, sy = (tile % 16) * 8, (tile // 16) * 8
        for y in range(8):
            for x in range(8):
                v = sheet.getpixel((sx + x, sy + y))
                sheet.putpixel((sx + x, sy + y), CURSOR_RECOLOUR.get(v, v))
    pal = [(0, 0, 0)] * 16
    with open(os.path.join(path, 'textbox_0.pal')) as f:
        for i, line in enumerate(f.read().split('\n')[3:19]):
            pal[i] = tuple(int(v) for v in line.split())
    for i, c in RED_UI.items():
        pal[i] = c
    sheet.putpalette([v for c in pal for v in c] + [0] * (768 - 48))
    sheet.save(os.path.join(path, 'textbox.png'))
    write_jasc(os.path.join(path, 'textbox_0.pal'), pal, 16)

    with open(os.path.join(path, 'textbox_map.bin'), 'rb') as f:
        tilemap = bytearray(f.read())
    for top, height, boxes in BOXES:
        for left, width in boxes:
            for r in range(height):
                for c in range(width):
                    col = 0 if c == 0 else 2 if c == width - 1 else 1
                    row = 0 if r == 0 else 2 if r == height - 1 else 1
                    entry = BOX_FIRST_TILE + row * 3 + col  # palette 0, no flips
                    struct.pack_into('<H', tilemap, ((top + r) * 32 + left + c) * 2, entry)
    with open(os.path.join(path, 'textbox_map.bin'), 'wb') as f:
        f.write(tilemap)
    print('battle boxes: tiles %d-%d, %d boxes' % (BOX_FIRST_TILE, BOX_FIRST_TILE + 8, sum(len(b[2]) for b in BOXES)))


# --- Trainer front pics --------------------------------------------------------------

def drop_rows(img, count, band):
    """Removes `count` rows inside band (top, bottom), the ones most like the
    row above them, never two neighbours."""
    px = img.load()
    w, h = img.size
    diff = lambda y: sum(px[x, y] != px[x, y - 1] for x in range(w))
    candidates = sorted(range(max(band[0], 1), band[1]), key=lambda y: (diff(y), y))
    dropped = []
    for y in candidates:
        if len(dropped) == count:
            break
        if all(abs(y - d) > 1 for d in dropped):
            dropped.append(y)
    assert len(dropped) == count, 'not enough rows to drop in %s' % (band,)
    keep = [y for y in range(h) if y not in dropped]
    out = Image.new('RGBA', (w, len(keep)))
    for ny, y in enumerate(keep):
        for x in range(w):
            out.putpixel((x, ny), px[x, y])
    return out, sorted(dropped)


def lab(c):
    """sRGB -> CIE L*a*b* (D65), for distances that match how colours look."""
    def lin(v):
        v /= 255
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (lin(v) for v in c)
    x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
    f = lambda t: t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116
    return 116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))


def lab_distance(a, b):
    return sum((p - q) ** 2 for p, q in zip(lab(a), lab(b))) ** 0.5


def reduce_colours(img, limit, keep=(), first=()):
    """Merges pairs of colours (the rarer into the commoner) until at most
    `limit` remain, cheapest first: colour distance times the pixels that
    change, so a rare but distinct highlight survives a common near-twin.
    `first` are merges (from, to) to make before anything else; colours in
    `keep` are never merged away."""
    px = img.load()
    w, h = img.size
    merges = []
    for rare, common in first:
        for y in range(h):
            for x in range(w):
                if px[x, y][3] and to_gba(px[x, y]) == to_gba(rare):
                    px[x, y] = to_gba(common) + (255,)
        merges.append((rare, common))
    keep = {to_gba(c) for c in keep}
    while True:
        counts = {}
        for y in range(h):
            for x in range(w):
                if px[x, y][3]:
                    c = to_gba(px[x, y])
                    counts[c] = counts.get(c, 0) + 1
        if len(counts) <= limit:
            break
        cs = list(counts)
        best = None
        for i in range(len(cs)):
            for j in range(i + 1, len(cs)):
                a, b = cs[i], cs[j]
                rare, common = (a, b) if counts[a] < counts[b] else (b, a)
                if rare in keep:
                    if common in keep:
                        continue
                    rare, common = common, rare
                d = lab_distance(a, b) * counts[rare]
                if best is None or d < best[0]:
                    best = (d, rare, common)
        _, rare, common = best
        merges.append((rare, common))
        for y in range(h):
            for x in range(w):
                if px[x, y][3] and to_gba(px[x, y]) == rare:
                    px[x, y] = common + (255,)
    return merges


def trainer_pic(name, band, keep=(), first=(), frames=1):
    """frames: how many frames art/<name>-hgss.png has, side by side (the same
    rows are dropped from each, and they share one palette)."""
    strip = Image.open(os.path.join(ART, '%s-hgss.png' % name)).convert('RGBA')
    width = strip.size[0] // frames
    images = [strip.crop((i * width, 0, (i + 1) * width, strip.size[1])) for i in range(frames)]
    box = images[0].getbbox()
    for im in images[1:]:
        b = im.getbbox()
        box = (min(box[0], b[0]), min(box[1], b[1]), max(box[2], b[2]), max(box[3], b[3]))
    images = [im.crop(box) for im in images]
    w, h = images[0].size
    # One image with every frame stacked, so rows and colours are decided once.
    stack = Image.new('RGBA', (w, h * frames))
    for i, im in enumerate(images):
        stack.paste(im, (0, i * h))
    dropped = []
    if h > 64:
        img, dropped = drop_rows(images[0], h - 64, band)
        keep_rows = [y for y in range(h) if y not in dropped]
        trimmed = Image.new('RGBA', (w, 64 * frames))
        for i in range(frames):
            for ny, y in enumerate(keep_rows):
                for x in range(w):
                    trimmed.putpixel((x, i * 64 + ny), stack.getpixel((x, i * h + y)))
        stack, h = trimmed, 64
    assert w <= 64
    merges = reduce_colours(stack, 15, keep, first)
    colours = sorted(set(to_gba(c) for c in stack.get_flattened_data() if c[3]))
    palette = [TRANSPARENT] + colours
    index = {c: i + 1 for i, c in enumerate(colours)}

    def frame_image(count):
        out = Image.new('P', (64, 64 * count), 0)
        out.putpalette([v for c in palette + [(0, 0, 0)] * (256 - len(palette)) for v in c])
        x0, y0 = (64 - w) // 2, 64 - h  # centred, standing on the bottom edge
        for i in range(count):
            for y in range(h):
                for x in range(w):
                    p = stack.getpixel((x, i * h + y))
                    if p[3]:
                        out.putpixel((x0 + x, i * 64 + y0 + y), index[to_gba(p)])
        return out

    pics = os.path.join(GAME, 'graphics', 'trainers', 'front_pics')
    frame_image(1).save(os.path.join(pics, 'dailyred_%s.png' % name))
    if frames > 1:
        frame_image(frames).save(os.path.join(pics, 'dailyred_%s_anim.png' % name))
    print('%s: %d frame(s), dropped rows %s, merged %d colour(s) %s' % (name, frames, dropped, len(merges), merges))


if __name__ == '__main__':
    battle_background()
    battle_boxes()
    # Bands: RED's jeans (thighs to shins) and LEAF's legs.
    trainer_pic('red', (44, 62), frames=2)
    # LEAF has 21 colours: her blouse keeps all three of its blues, and her
    # bag gives up its highlight (merged into its mid tone) first.
    trainer_pic('leaf', (46, 64),
                keep=[(120, 184, 216), (80, 136, 176), (48, 104, 136)],
                first=[((248, 192, 88), (216, 160, 120))])
