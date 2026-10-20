#!/usr/bin/env python3
"""Turns Daily Red's source art (art/) into the game's graphics files.

    python3 scripts/graphics/make-graphics.py      (needs Pillow: pip install pillow)

- art/mt-silver-battle-bg.png (240x112, the HGSS-style Mt. Silver battle
  background by Gold-Ruki) -> expansion/graphics/battle_environment/
  dailyred_mt_silver/: tiles.png, map.bin and palette.pal in the layout of the
  game's own battle backgrounds, plus an empty entry layer (anim_*).
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
    src = Image.open(os.path.join(ART, 'mt-silver-battle-bg.png')).convert('RGB')
    assert src.size == (240, 112), src.size
    colours = sorted(set(to_gba(c) for c in src.get_flattened_data()))
    assert len(colours) <= 15, '%d colours: the background must fit one 16-colour palette' % len(colours)
    index = {c: i + 1 for i, c in enumerate(colours)}  # 0 stays transparent

    # Each pixel row's backdrop colour (the stripe the platforms sit on): its
    # most common colour.
    def stripe(y):
        row = [to_gba(src.getpixel((x, y))) for x in range(240)]
        return max(set(row), key=row.count)
    stripes = [stripe(y) for y in range(112)]

    # 256x512 like the game's own backgrounds: the scene at the top, with the
    # 16 columns past the screen edge (seen while the intro slides the halves
    # in) continuing each row's stripe; a copy without the platforms further
    # down for battle animations that shake the background; the rest empty.
    W, H = 256, 512
    canvas = [[0] * W for _ in range(H)]
    for y in range(112):
        for x in range(W):
            c = to_gba(src.getpixel((x, y))) if x < 240 else stripes[y]
            canvas[y][x] = index[c]
    plain = [[index[stripes[y]]] * W for y in range(112)]
    # Rows 30-45 (pixels 240-367): the top stripe for 2 tile rows, then the
    # gradient; rows 62-63: the top stripe (as in the game's own maps).
    for y in range(240, 256):
        canvas[y] = list(plain[0])
    for y in range(256, 368):
        canvas[y] = list(plain[min(y - 256 + 8, 111)] if y - 256 + 8 < 112 else plain[111])
    for y in range(496, 512):
        canvas[y] = list(plain[0])

    # Tiles, deduplicated with flips.
    tiles, lookup, entries = [], {}, []
    blank = tuple([0] * 64)
    tiles.append(blank)
    lookup[blank] = (0, 0, 0)

    def flips(t):
        rows = [t[i * 8:(i + 1) * 8] for i in range(8)]
        yield t, 0, 0
        yield tuple(v for r in rows for v in r[::-1]), 1, 0
        yield tuple(v for r in rows[::-1] for v in r), 0, 1
        yield tuple(v for r in rows[::-1] for v in r[::-1]), 1, 1

    for ty in range(H // 8):
        for tx in range(W // 8):
            t = tuple(canvas[ty * 8 + y][tx * 8 + x] for y in range(8) for x in range(8))
            if t == blank:
                entries.append(0)
                continue
            found = None
            for variant, hf, vf in flips(t):
                if variant in lookup:
                    n, h0, v0 = lookup[variant]
                    found = (n, hf ^ h0, vf ^ v0)
                    break
            if found is None:
                tiles.append(t)
                lookup[t] = (len(tiles) - 1, 0, 0)
                found = (len(tiles) - 1, 0, 0)
            n, hf, vf = found
            entries.append(n | (hf << 10) | (vf << 11) | (2 << 12))  # palette 2: where the game loads it
    assert len(tiles) <= 512, '%d tiles' % len(tiles)

    out = os.path.join(GAME, 'graphics', 'battle_environment', 'dailyred_mt_silver')
    os.makedirs(out, exist_ok=True)
    palette = [TRANSPARENT] + colours
    cols = 16
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new('P', (cols * 8, rows * 8), 0)
    sheet.putpalette([v for c in palette + [(0, 0, 0)] * (256 - len(palette)) for v in c])
    for i, t in enumerate(tiles):
        for p, v in enumerate(t):
            sheet.putpixel(((i % cols) * 8 + p % 8, (i // cols) * 8 + p // 8), v)
    sheet.save(os.path.join(out, 'tiles.png'))
    with open(os.path.join(out, 'map.bin'), 'wb') as f:
        f.write(b''.join(struct.pack('<H', e) for e in entries))
    write_jasc(os.path.join(out, 'palette.pal'), palette, 48)

    # The entry layer (the scenery that scrolls past during the intro): empty.
    empty = Image.new('P', (8, 8), 0)
    empty.putpalette([v for c in palette + [(0, 0, 0)] * (256 - len(palette)) for v in c])
    empty.save(os.path.join(out, 'anim_tiles.png'))
    with open(os.path.join(out, 'anim_map.bin'), 'wb') as f:
        f.write(b'\0\0' * 1024)
    print('battle background: %d colours, %d tiles -> %s' % (len(colours), len(tiles), os.path.relpath(out, ROOT)))


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
    # Bands: RED's jeans (thighs to shins) and LEAF's legs.
    trainer_pic('red', (44, 62), frames=2)
    # LEAF has 21 colours: her blouse keeps all three of its blues, and her
    # bag gives up its highlight (merged into its mid tone) first.
    trainer_pic('leaf', (46, 64),
                keep=[(120, 184, 216), (80, 136, 176), (48, 104, 136)],
                first=[((248, 192, 88), (216, 160, 120))])
