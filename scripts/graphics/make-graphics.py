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
- art/mega-typhlosion/ (Mega Typhlosion's front, shiny front and back) ->
  expansion/graphics/pokemon/typhlosion/mega/,
  with its party icon and Typhlosionite's bag icon recoloured from the
  expansion's.

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


# --- Mt. Silver summit clouds ----------------------------------------------------

# The sea of clouds beyond the summit's edge, added to the summit tileset
# (data/tilesets/secondary/mt_silver_summit/, which otherwise comes as is):
# art/mt-silver-clouds.png is a seamless 96x112 strip (cut from an HGSS
# screenshot of the summit, its snowflakes filtered out, stretched so the
# texture's own period is exactly 96 px, contrast raised a little for the
# GBA's colours, and its top 32 px mirrored above it for height). It becomes
# 12x14 tiles after the tileset's own 96 (on palette 8), 6x7 metatiles after
# its 40 (0x2A8-0x2D1; the layout's rows 0-5 repeat them every 6 columns,
# their last row is behind the summit's edge, see summit_edge) and the
# animation's source frame, anim/clouds.png, which src/tileset_anims.c
# scrolls a pixel at a time. The functions below also write the rows of the
# summit layout they draw (data/layouts/DailyRed_Summit/map.bin, 20 wide):
# enough rows of clouds that the camera never shows past the map's top.
SUMMIT_TILES = 96          # the tileset's own tiles (6 rows of 16)
SUMMIT_METATILES = 40      # and metatiles (0x280-0x2A7)
CLOUD_PALETTE = 8
SUMMIT_LAYOUT = os.path.join(GAME, 'data', 'layouts', 'DailyRed_Summit', 'map.bin')
SUMMIT_WIDTH = 20
SUMMIT_EDGE_ROW = 6        # the summit's edge, under the clouds (RED stands on it)
SUMMIT_BLOCKED = (1 << 10) | (3 << 12)  # a layout block's collision and elevation bits


def set_summit_blocks(blocks):
    """Writes {(column, row): metatile} into the summit layout, keeping each
    block's collision and elevation."""
    with open(SUMMIT_LAYOUT, 'rb') as f:
        layout = bytearray(f.read())
    for (col, row), mid in blocks.items():
        at = (row * SUMMIT_WIDTH + col) * 2
        v = struct.unpack_from('<H', layout, at)[0]
        struct.pack_into('<H', layout, at, (v & ~0x3FF) | mid)
    with open(SUMMIT_LAYOUT, 'wb') as f:
        f.write(layout)


class SummitTiles:
    """The summit tileset's tiles.png, for the pieces drawn below: a tile
    that's already there (the same pixels) is reused, an empty one is the
    blank tile, and new ones go in the free columns beside the clouds (the
    strip is 12 tiles wide, the sheet 16). The secondary tileset's last
    tiles don't load on FireRed's maps, so nothing goes after the clouds."""

    def __init__(self, out):
        self.path = os.path.join(out, 'tiles.png')
        self.sheet = Image.open(self.path)
        self.known = {}
        for t in range((self.sheet.width // 8) * (self.sheet.height // 8)):
            pixels = self._get(t)
            if any(pixels):
                self.known.setdefault(pixels, t)
        first = SUMMIT_TILES // 16
        self.free = [r * 16 + c for r in range(first, self.sheet.height // 8) for c in range(12, 16)
                     if not any(self._get(r * 16 + c))]

    def _get(self, t):
        tx, ty = (t % 16) * 8, (t // 16) * 8
        return tuple(self.sheet.getpixel((tx + x, ty + y)) for y in range(8) for x in range(8))

    def entries(self, img, palette):
        """A 16x16 piece as the 4 tilemap entries of a metatile layer."""
        out = []
        for k in range(4):
            pixels = tuple(img[(k // 2) * 8 + y][(k % 2) * 8 + x] for y in range(8) for x in range(8))
            if not any(pixels):
                out.append(0)
                continue
            if pixels not in self.known:
                if not self.free:
                    raise SystemExit('summit tileset: no room for more tiles')
                t = self.free.pop(0)
                tx, ty = (t % 16) * 8, (t // 16) * 8
                for i, v in enumerate(pixels):
                    self.sheet.putpixel((tx + i % 8, ty + i // 8), v)
                self.known[pixels] = t
            out.append((640 + self.known[pixels]) | (palette << 12))
        return out

    def save(self):
        self.sheet.save(self.path)


def summit_clouds():
    out = os.path.join(GAME, 'data', 'tilesets', 'secondary', 'mt_silver_summit')
    strip = Image.open(os.path.join(ART, 'mt-silver-clouds.png')).convert('RGB')
    w, h = strip.size
    assert w % 16 == 0 and h % 16 == 0
    q = strip.quantize(colors=15, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    colours = [tuple(q.getpalette()[i * 3:i * 3 + 3]) for i in range(15)]
    pal = [TRANSPARENT] + colours
    write_jasc(os.path.join(out, 'palettes', '%02d.pal' % CLOUD_PALETTE), pal, 16)
    indices = Image.new('P', (w, h))
    indices.putdata([v + 1 for v in q.getdata()])
    indices.putpalette([v for c in pal for v in c])

    anim = os.path.join(out, 'anim')
    os.makedirs(anim, exist_ok=True)
    indices.save(os.path.join(anim, 'clouds.png'))

    sheet = Image.open(os.path.join(out, 'tiles.png'))
    rows = SUMMIT_TILES // 16
    tiles = Image.new('P', (128, rows * 8 + h))
    tiles.putpalette(sheet.getpalette())
    tiles.paste(sheet.crop((0, 0, 128, rows * 8)), (0, 0))
    tiles.paste(indices, (0, rows * 8))
    tiles.save(os.path.join(out, 'tiles.png'))

    with open(os.path.join(out, 'metatiles.bin'), 'rb') as f:
        metatiles = bytearray(f.read()[:SUMMIT_METATILES * 16])
    with open(os.path.join(out, 'metatile_attributes.bin'), 'rb') as f:
        attributes = bytearray(f.read()[:SUMMIT_METATILES * 4])
    top = metatiles[8:16]  # the snow metatile's (empty) top layer
    first = 640 + SUMMIT_TILES  # FireRed's primary tileset has 640 tiles
    for my in range(h // 16):
        for mx in range(w // 16):
            tile = first + my * 2 * 16 + mx * 2
            bottom = [tile, tile + 1, tile + 16, tile + 17]
            metatiles += struct.pack('<4H', *[t | (CLOUD_PALETTE << 12) for t in bottom]) + top
            attributes += struct.pack('<I', 0x20000000)  # MB_NORMAL, covered layers
    with open(os.path.join(out, 'metatiles.bin'), 'wb') as f:
        f.write(metatiles)
    with open(os.path.join(out, 'metatile_attributes.bin'), 'wb') as f:
        f.write(attributes)
    set_summit_blocks({(c, r): 0x280 + SUMMIT_METATILES + r * (w // 16) + c % (w // 16)
                       for r in range(SUMMIT_EDGE_ROW) for c in range(SUMMIT_WIDTH)})
    print('summit clouds: %dx%d px, %d colours, metatiles 0x%X-0x%X' % (
        w, h, len(colours), 0x280 + SUMMIT_METATILES, 0x280 + SUMMIT_METATILES + (w // 16) * (h // 16) - 1))


# The summit's top edge (row 4 of the layout, under the clouds' rows 0-3):
# the pale band above the ridges' snow caps and the flat-cut tops of the
# platform's rock walls give way to the drifting clouds. Each edge piece
# becomes a metatile with the clouds' fifth row as its bottom layer (so they
# move too) and the piece on top, its band see-through: on the ridge caps
# (0x283/0x284) the pale band connected to the top row, on the walls
# (0x285/0x286) everything above a rounded white cap on the rock column, and
# on the platform (0x280, and the walls' platform side) everything above a
# soft, slightly uneven snow edge, all about level with the caps' snow. One metatile per piece
# and cloud column (the clouds repeat every 6 columns), from 0x2C6; the
# script also writes the layout's edge row.
EDGE_ROW = [0x283] * 7 + [0x285] + [0x280] * 3 + [0x286] + [0x284] * 8  # the tileset sample layout's row 0
EDGE_LINE, EDGE_LIGHT = 8, 2           # palette 7 indices
EDGE_BAND = {2, 3, 4, EDGE_LINE}       # the caps' pale band (and its top line)
EDGE_BAND_ROWS = 8                     # the band never goes below row 7
EDGE_ROCK = 7                          # from this index a pixel counts as rock
EDGE_WALL_CAP_TOP = 5                  # the walls' snow caps start this far down
EDGE_PLATFORM_TOP = 5                  # and the platform's snow
EDGE_PLATFORM_BUMPS = [1, 0, 0, 1, 1, 2, 1, 0, 0, 1, 2, 2, 1, 0, 1, 1]  # rows lower, by column
EDGE_WALL_PATH_SIDE = {0x285: 'right', 0x286: 'left'}  # which side the platform is on


def summit_edge():
    out = os.path.join(GAME, 'data', 'tilesets', 'secondary', 'mt_silver_summit')
    sheet = Image.open(os.path.join(out, 'tiles.png'))
    with open(os.path.join(out, 'metatiles.bin'), 'rb') as f:
        metatiles = bytearray(f.read())
    with open(os.path.join(out, 'metatile_attributes.bin'), 'rb') as f:
        attributes = bytearray(f.read())
    clouds = Image.open(os.path.join(ART, 'mt-silver-clouds.png'))
    cloud_w = clouds.width // 16
    cloud_row = SUMMIT_METATILES + cloud_w * (clouds.height // 16 - 1)  # the clouds' last row of metatiles

    def piece_pixels(piece):
        entries = struct.unpack_from('<8H', metatiles, (piece - 0x280) * 16)
        img = [[0] * 16 for _ in range(16)]
        for k in range(4):
            v = entries[k]
            t = (v & 0x3FF) - 640
            tx, ty = (t % 16) * 8, (t // 16) * 8
            for y in range(8):
                for x in range(8):
                    sx = 7 - x if v & 0x400 else x
                    sy = 7 - y if v & 0x800 else y
                    img[(k // 2) * 8 + y][(k % 2) * 8 + x] = sheet.getpixel((tx + sx, ty + sy))
        return img

    def edge_pixels(piece):
        img = piece_pixels(piece)
        if piece == 0x280:  # the platform: clouds down to a soft, uneven snow edge
            for x in range(16):
                top = EDGE_PLATFORM_TOP + EDGE_PLATFORM_BUMPS[x]
                for y in range(top):
                    img[y][x] = 0
                img[top][x] = EDGE_LIGHT
        elif piece in EDGE_WALL_PATH_SIDE:
            row = img[0]
            start = next(x for x in range(16) if row[x] >= EDGE_ROCK)
            end = max(x for x in range(16) if row[x] >= EDGE_ROCK) + 1
            centre, half = (start + end - 1) / 2, (end - start) / 2
            path_right = EDGE_WALL_PATH_SIDE[piece] == 'right'
            for x in range(16):
                if start <= x < end:
                    # Clouds down to a rounded cap (its top at row 4 in the
                    # middle of the column, 6 at its sides, like the ridge
                    # caps' snow), then white snow and a shade onto the rock.
                    top = EDGE_WALL_CAP_TOP + round(2 * abs(x - centre) / (half + 1))
                    for y in range(top):
                        img[y][x] = 0
                    for y in range(top, top + 3):
                        img[y][x] = 1
                    img[top + 3][x] = 4
                elif (x >= end) == path_right:  # the platform's side
                    top = EDGE_PLATFORM_TOP + EDGE_PLATFORM_BUMPS[x]
                    for y in range(top):
                        img[y][x] = 0
                    img[top][x] = EDGE_LIGHT
                else:  # the far side
                    for y in range(EDGE_BAND_ROWS):
                        img[y][x] = 0
        else:  # a ridge cap: its pale band, from the top, is see-through
            todo = [(0, x) for x in range(16) if img[0][x] in EDGE_BAND]
            while todo:
                y, x = todo.pop()
                if not (0 <= y < EDGE_BAND_ROWS and 0 <= x < 16) or img[y][x] not in EDGE_BAND:
                    continue
                img[y][x] = 0
                todo += [(y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)]
        return img

    new_tiles = SummitTiles(out)
    piece_tiles = {piece: new_tiles.entries(edge_pixels(piece), 7) for piece in sorted(set(EDGE_ROW))}
    new_tiles.save()

    ids = {}
    row_ids = []
    for col, piece in enumerate(EDGE_ROW):
        top = piece_tiles[piece]
        phase = col % cloud_w
        key = (piece, phase)
        if key not in ids:
            ids[key] = 0x280 + len(metatiles) // 16
            behind = struct.unpack_from('<4H', metatiles, (cloud_row + phase) * 16)
            metatiles += struct.pack('<8H', *behind, *top)
            attributes += struct.pack('<I', 0x20000000)  # covered: both layers under the player
        row_ids.append(ids[key])
    with open(os.path.join(out, 'metatiles.bin'), 'wb') as f:
        f.write(metatiles)
    with open(os.path.join(out, 'metatile_attributes.bin'), 'wb') as f:
        f.write(attributes)

    set_summit_blocks({(col, SUMMIT_EDGE_ROW): mid for col, mid in enumerate(row_ids)})
    print('summit edge: metatiles 0x%X-0x%X, layout row %d' % (min(ids.values()), max(ids.values()), SUMMIT_EDGE_ROW))


# Beside the stairs the tileset's stair-side rocks (0x298/0x2A0, 0x29C/0x2A4)
# join neither the platform's walls above them, the terraces beside them nor
# the path's walls below (their rock columns are a different width and their
# ledge is at another height). So beside the stairs' top row the platform's
# wall carries on down (0x285/0x286), and beside the bottom row there's a
# corner made from the terrace end the tileset pairs with those rocks
# (0x28A/0x28C: the terrace's snow band turning down into the path's wall);
# both get the stairs' rail from the stair rocks, the bottom one its foot too.
STAIR_PIECES = [
    # (layout column, rows below the edge, base, rail from, rail columns, foot from or None, foot columns)
    (7, 2, 0x285, 0x298, range(13, 16), None, None),
    (7, 3, 0x28A, 0x298, range(13, 16), 0x2A0, range(12, 16)),
    (11, 2, 0x286, 0x29C, range(0, 3), None, None),
    (11, 3, 0x28C, 0x29C, range(0, 3), 0x2A4, range(0, 4)),
]
STAIR_RAIL_ROWS = (2, 11)    # the rail's plain stretch in the stair rocks
STAIR_FOOT_ROWS = range(13, 16)


def summit_stairs():
    out = os.path.join(GAME, 'data', 'tilesets', 'secondary', 'mt_silver_summit')
    sheet = Image.open(os.path.join(out, 'tiles.png'))
    with open(os.path.join(out, 'metatiles.bin'), 'rb') as f:
        metatiles = bytearray(f.read())
    with open(os.path.join(out, 'metatile_attributes.bin'), 'rb') as f:
        attributes = bytearray(f.read())

    def pixels(piece):
        entries = struct.unpack_from('<4H', metatiles, (piece - 0x280) * 16)
        img = [[0] * 16 for _ in range(16)]
        for k, v in enumerate(entries):
            t = (v & 0x3FF) - 640
            tx, ty = (t % 16) * 8, (t // 16) * 8
            for y in range(8):
                for x in range(8):
                    sx = 7 - x if v & 0x400 else x
                    sy = 7 - y if v & 0x800 else y
                    img[(k // 2) * 8 + y][(k % 2) * 8 + x] = sheet.getpixel((tx + sx, ty + sy))
        return img

    new_tiles = SummitTiles(out)
    blocks = {}
    for n, (col, row, base, rail_piece, rail_cols, foot_piece, foot_cols) in enumerate(STAIR_PIECES):
        img = pixels(base)
        rail = pixels(rail_piece)
        lo, hi = STAIR_RAIL_ROWS
        for y in range(16):
            for x in rail_cols:
                img[y][x] = rail[min(max(y, lo), hi)][x]
        if foot_piece:
            foot = pixels(foot_piece)
            for y in STAIR_FOOT_ROWS:
                for x in foot_cols:
                    img[y][x] = foot[y][x]
        mid = 0x280 + len(metatiles) // 16
        top = struct.unpack_from('<4H', metatiles, (base - 0x280) * 16 + 8)
        metatiles += struct.pack('<8H', *new_tiles.entries(img, 7), *top)
        attributes += attributes[(base - 0x280) * 4:(base - 0x280) * 4 + 4]
        blocks[(col, SUMMIT_EDGE_ROW + row)] = mid
    new_tiles.save()
    with open(os.path.join(out, 'metatiles.bin'), 'wb') as f:
        f.write(metatiles)
    with open(os.path.join(out, 'metatile_attributes.bin'), 'wb') as f:
        f.write(attributes)
    set_summit_blocks(blocks)
    print('summit stairs: metatiles 0x%X-0x%X' % (mid - len(STAIR_PIECES) + 1, mid))


# Where the cliffs meet the snowfield below the summit's entrance (the row
# under the path's end), the tileset's pieces (0x287/0x294 "cliff base", and
# 0x290/0x291 "ledge band" over the lower ridges at the sides) end the ridges
# out of line with the ridges above them. Each spot gets a piece drawn from
# the ridge above it instead: its rock columns end in rounded bottoms with a
# shadow, a soft ledge line runs across at one height, then snow; at the
# sides the lower ridge below starts again under a white cap.
BASE_ROW = SUMMIT_EDGE_ROW + 15
BASE_PIECES = (
    # (columns, piece above, piece below or None for snow)
    (range(0, 3), 0x281, 0x281),
    (range(3, 4), 0x281, 0x292),
    (range(4, 7), 0x281, None),
    (range(7, 8), 0x285, None),
    (range(11, 12), 0x286, None),
    (range(12, 16), 0x282, None),
    (range(16, 17), 0x282, 0x293),
    (range(17, 20), 0x282, 0x282),
)
BASE_END_ROW = 7      # the ridges above end here
SNOW, SNOW_LIGHT, SNOW_MID, SNOW_SOFT, SNOW_SHADE, ROCK_DARK = 1, 2, 3, 4, 5, 9  # palette 7 indices


def summit_base():
    out = os.path.join(GAME, 'data', 'tilesets', 'secondary', 'mt_silver_summit')
    sheet = Image.open(os.path.join(out, 'tiles.png'))
    with open(os.path.join(out, 'metatiles.bin'), 'rb') as f:
        metatiles = bytearray(f.read())
    with open(os.path.join(out, 'metatile_attributes.bin'), 'rb') as f:
        attributes = bytearray(f.read())

    def pixels(piece):
        entries = struct.unpack_from('<4H', metatiles, (piece - 0x280) * 16)
        img = [[0] * 16 for _ in range(16)]
        for k, v in enumerate(entries):
            t = (v & 0x3FF) - 640
            tx, ty = (t % 16) * 8, (t // 16) * 8
            for y in range(8):
                for x in range(8):
                    sx = 7 - x if v & 0x400 else x
                    sy = 7 - y if v & 0x800 else y
                    img[(k // 2) * 8 + y][(k % 2) * 8 + x] = sheet.getpixel((tx + sx, ty + sy))
        return img

    def rock_runs(row):
        runs, x = [], 0
        while x < 16:
            if row[x] >= EDGE_ROCK:
                start = x
                while x < 16 and row[x] >= EDGE_ROCK:
                    x += 1
                runs.append((start, x))
            else:
                x += 1
        return runs

    def base(above, below):
        src = pixels(above)
        img = [[SNOW] * 16 for _ in range(16)]
        r = BASE_END_ROW
        for y in range(r):
            img[y] = src[y][:]
        depth = {}
        for a, b in rock_runs(src[r - 1]):
            centre, half = (a + b - 1) / 2, (b - a) / 2
            for x in range(a, b):
                depth[x] = round(2 * (1 - abs(x - centre) / (half + 1)))
        for x in range(16):
            if x in depth:  # a rounded bottom, then its shadow
                k = depth[x]
                for y in range(r, r + k):
                    img[y][x] = src[y][x] if src[y][x] >= EDGE_ROCK else ROCK_DARK
                img[r + k][x] = SNOW_SHADE
                img[r + k + 1][x] = SNOW_MID
            else:
                img[r][x] = min(src[r - 1][x], SNOW_MID)
                img[r + 1][x] = SNOW_LIGHT
        for x in range(16):  # the ledge line
            if img[r + 3][x] < EDGE_ROCK:
                img[r + 3][x] = SNOW_SOFT
            if img[r + 4][x] < EDGE_ROCK:
                img[r + 4][x] = SNOW_LIGHT
        if below:  # the lower ridge starts again under a white cap
            low = pixels(below)
            for y in range(r + 5, 16):
                img[y] = [SNOW] * 16
            for y in range(14, 16):
                img[y] = low[y][:]
            for a, b in rock_runs(low[14]):
                centre, half = (a + b - 1) / 2, (b - a) / 2
                for x in range(a, b):
                    img[13][x] = SNOW_SOFT
                    if abs(x - centre) / (half + 1) > 0.5:
                        img[12][x] = SNOW
        return img

    new_tiles = SummitTiles(out)
    blocks = {}
    for n, (cols, above, below) in enumerate(BASE_PIECES):
        img = base(above, below)
        mid = 0x280 + len(metatiles) // 16
        top = struct.unpack_from('<4H', metatiles, (above - 0x280) * 16 + 8)
        metatiles += struct.pack('<8H', *new_tiles.entries(img, 7), *top)
        attributes += attributes[(above - 0x280) * 4:(above - 0x280) * 4 + 4]
        for col in cols:
            blocks[(col, BASE_ROW)] = mid
    new_tiles.save()
    with open(os.path.join(out, 'metatiles.bin'), 'wb') as f:
        f.write(metatiles)
    with open(os.path.join(out, 'metatile_attributes.bin'), 'wb') as f:
        f.write(attributes)
    set_summit_blocks(blocks)
    print('summit base: metatiles 0x%X-0x%X, layout row %d' % (mid - len(BASE_PIECES) + 1, mid, BASE_ROW))


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
# Rings from the box's edge inwards, as textbox palette indices: outline,
# frame light/mid/mid/dark, the inner stripe, then the fill (15, the text
# windows' background). The boxes fill their tiles to the edge, like
# FireRed's, so they hide the bottom of your Pokemon's sprite; only the
# rounded corners let the battle background through.
BOX_RINGS = [2, 3, 4, 4, 5, 8]
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
                # Ring 0 of a box one pixel bigger all round is outside the
                # rounded corners.
                ring = box_ring(tx + x + 1, ty + y + 1, size + 2) - 1
                colour = 0 if ring < 0 else BOX_RINGS[ring] if ring < len(BOX_RINGS) else BOX_FILL
                sheet.putpixel((sx + x, sy + y), colour)
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


# --- Mega Typhlosion ---------------------------------------------------------------

MEGA_TYPHLOSION_ART = os.path.join(ART, 'mega-typhlosion')
MEGA_TYPHLOSION_OUT = os.path.join(GAME, 'graphics', 'pokemon', 'typhlosion', 'mega')


def read_jasc(path):
    values = open(path).read().split()[3:]
    return [tuple(int(v) for v in values[i:i + 3]) for i in range(0, len(values), 3)]


def mega_typhlosion_icon():
    """Typhlosion's party icon with the Mega's charcoal fur, a flame on its
    lower back and smoke over its neck flames (both frames; the icon palette
    is the one Typhlosion uses, iconPalIndex 3)."""
    src = Image.open(os.path.join(GAME, 'graphics', 'pokemon', 'typhlosion', 'icon.png'))
    out = src.copy()
    px = out.load()
    # Palette 3 indices: 1/2/3 greys, 4/5 Typhlosion's blues, 8 red,
    # 10 yellow, 13 orange, 14 dark grey, 15 outline.
    for y in range(out.size[1]):
        for x in range(out.size[0]):
            if px[x, y] == 5:
                px[x, y] = 14
            elif px[x, y] == 4:
                px[x, y] = 15
    pen = {'f': 15, 'e': 14, '1': 1, '2': 2, '3': 3, '8': 8, 'a': 10, 'd': 13}
    flame = [(16, 23, 'f'), (17, 23, '8f.f'), (18, 23, '88f8f'), (19, 23, 'da88f'), (20, 24, 'da8f'),
             (21, 24, 'adf'), (22, 25, 'f')]
    smoke = [(2, 20, 'eee'), (3, 19, 'e233e'), (4, 18, 'e22322e'), (5, 18, 'e12221e'), (6, 19, 'e1ee')]
    # The second frame's body is a row lower (its flames flicker higher).
    for top, shift, spec in ((0, 0, flame), (32, 1, flame), (0, 0, smoke), (32, 0, smoke)):
        for y, x0, row in spec:
            for i, ch in enumerate(row):
                if ch in pen:
                    px[x0 + i, top + y + shift] = pen[ch]
    out.save(os.path.join(MEGA_TYPHLOSION_OUT, 'icon.png'))


def typhlosionite_icon():
    """Typhlosionite's bag icon: the expansion's Feraligite (the Z-A Johto
    starters' stone) in the Mega's colours, a charcoal stone with a flame and
    cream swirl."""
    items = os.path.join(GAME, 'graphics', 'items')
    shutil.copyfile(os.path.join(items, 'icons', 'feraligite.png'), os.path.join(items, 'icons', 'typhlosionite.png'))
    recolour = {
        (90, 180, 246): (77, 81, 106), (164, 213, 250): (120, 124, 156), (138, 196, 222): (98, 102, 132),
        (78, 99, 137): (45, 44, 58), (138, 149, 197): (140, 140, 160),
        (246, 82, 90): (238, 64, 0), (186, 63, 69): (176, 24, 0), (249, 146, 151): (255, 156, 0),
        (244, 233, 171): (251, 242, 147), (248, 241, 202): (255, 250, 200), (191, 182, 133): (208, 200, 115),
    }
    colours = [recolour.get(c, c) for c in read_jasc(os.path.join(items, 'icon_palettes', 'feraligite.pal'))]
    write_jasc(os.path.join(items, 'icon_palettes', 'typhlosionite.pal'), colours, 16)


# The back's colours (back.png, in the front's colours plus Insurgence's
# smoke and flame shades) -> the front's palette slots for the same parts.
MEGA_TYPHLOSION_BACK_COLOURS = {
    (16, 16, 16): 15,                                                     # outline
    (48, 48, 64): 13, (72, 80, 104): 11,                                  # fur, its light shade
    (216, 0, 0): 12, (222, 0, 0): 12, (248, 96, 0): 9, (255, 90, 0): 9,   # flames
    (255, 156, 0): 3, (248, 216, 0): 3, (255, 222, 0): 3,
    (65, 65, 65): 6, (136, 136, 136): 8, (139, 139, 139): 8,              # smoke, dark to light
    (184, 176, 176): 5, (189, 180, 180): 5, (232, 232, 224): 1, (238, 238, 230): 1,   # (and eye, teeth)
    (160, 136, 72): 7, (208, 192, 112): 4, (104, 80, 40): 10,             # tan neck, cream, brown
}
# Slot 6, freed on the front (see below): the smoke's dark grey, the back's
# (65, 65, 65), the same on the shiny so its smoke keeps its shading.
MEGA_TYPHLOSION_SMOKE_DARK = 6
MEGA_TYPHLOSION_SMOKE_DARK_COLOUR = (64, 64, 64)


def mega_typhlosion():
    """Mega Typhlosion (Pokémon Insurgence's design). art/mega-typhlosion/ has
    its front (front.png), shiny front (front_shiny.png) and back (back.png),
    64x64 GBA sprites supplied by the project's owner (the back is FYTYNo1's
    with smoke added).

    The GBA gives a Pokémon one 16-colour palette for front and back, and a
    shiny palette with the same slots, so:
    - the front's 17 colours become 16: its 3 pure black pixels join the
      outline, and its 7 light-orange flame pixels the yellow (both are cyan
      on the shiny), which frees slot 6 for the smoke's dark grey (the
      front's dark smoke is drawn in the fur's colour; it's told apart by
      staying grey on the shiny front);
    - the shiny palette is, for each slot, the colour the shiny front has at
      most of that slot's pixels (red fur, blue flames), except that the
      smoke's dark grey stays dark grey;
    - the back's colours take the front's slots for the same parts
      (MEGA_TYPHLOSION_BACK_COLOURS), so it turns shiny the same way.
    Then the party icon and Typhlosionite's icon are made from the
    expansion's."""
    from collections import Counter
    os.makedirs(MEGA_TYPHLOSION_OUT, exist_ok=True)
    art = lambda name: os.path.join(MEGA_TYPHLOSION_ART, name)
    front = Image.open(art('front.png'))
    shiny_front = Image.open(art('front_shiny.png'))
    assert front.mode == shiny_front.mode == 'P' and front.size == shiny_front.size == (64, 64)
    pal = front.getpalette()
    assert tuple(pal[45:51]) == (16, 16, 16, 0, 0, 0), 'front.png: slot 15 the outline, 16 pure black'
    spal = shiny_front.getpalette()
    shiny_rgb = [tuple(spal[3 * i:3 * i + 3]) for i in shiny_front.get_flattened_data()]
    pixels = []
    for i, s in zip(front.get_flattened_data(), shiny_rgb):
        if i == 16:
            i = 15
        elif i == 6:
            i = 3
        elif i == 13 and s in ((136, 136, 136), (232, 232, 224)):
            i = MEGA_TYPHLOSION_SMOKE_DARK
        pixels.append(i)
    normal = [tuple(pal[3 * i:3 * i + 3]) for i in range(16)]
    normal[MEGA_TYPHLOSION_SMOKE_DARK] = MEGA_TYPHLOSION_SMOKE_DARK_COLOUR
    votes = [Counter() for _ in range(16)]
    for i, s in zip(pixels, shiny_rgb):
        votes[i][s] += 1
    shiny = [normal[0]] + [votes[i].most_common(1)[0][0] for i in range(1, 16)]
    shiny[MEGA_TYPHLOSION_SMOKE_DARK] = MEGA_TYPHLOSION_SMOKE_DARK_COLOUR

    back_src = Image.open(art('back.png')).convert('RGB')
    assert back_src.size == (64, 64), 'back.png: not 64x64'
    background = normal[0]
    unknown = {c for c in back_src.get_flattened_data() if c != background and c not in MEGA_TYPHLOSION_BACK_COLOURS}
    assert not unknown, 'back.png: colours with no palette slot: %s' % sorted(unknown)
    back = [0 if c == background else MEGA_TYPHLOSION_BACK_COLOURS[c] for c in back_src.get_flattened_data()]

    for name, data in (('front.png', pixels), ('back.png', back)):
        im = Image.new('P', (64, 64))
        im.putpalette([v for c in normal for v in c])
        im.putdata(data)
        im.save(os.path.join(MEGA_TYPHLOSION_OUT, name), bits=4, transparency=0)
    write_jasc(os.path.join(MEGA_TYPHLOSION_OUT, 'normal.pal'), normal, 16)
    write_jasc(os.path.join(MEGA_TYPHLOSION_OUT, 'shiny.pal'), shiny, 16)
    mega_typhlosion_icon()
    typhlosionite_icon()
    print('mega typhlosion: front, back, normal and shiny palettes, icon -> %s; Typhlosionite icon'
          % os.path.relpath(MEGA_TYPHLOSION_OUT, ROOT))


if __name__ == '__main__':
    battle_background()
    battle_boxes()
    summit_clouds()
    summit_edge()  # after the clouds, which rebuild the tileset's extra tiles and metatiles
    summit_stairs()  # and after the edge
    summit_base()
    # Bands: RED's jeans (thighs to shins) and LEAF's legs.
    trainer_pic('red', (44, 62), frames=2)
    # LEAF has 21 colours: her blouse keeps all three of its blues, and her
    # bag gives up its highlight (merged into its mid tone) first.
    trainer_pic('leaf', (46, 64),
                keep=[(120, 184, 216), (80, 136, 176), (48, 104, 136)],
                first=[((248, 192, 88), (216, 160, 120))])
    mega_typhlosion()
