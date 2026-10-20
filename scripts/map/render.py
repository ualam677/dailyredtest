#!/usr/bin/env python3
"""Render pokeemerald-expansion FRLG tilesets and layouts to PNG.

  frlgmap.py ROOT tileset gTileset_X out.png            # all metatiles, numbered
  frlgmap.py ROOT layout LAYOUT_ID out.png [--grid] [--coll] [--blocks map.bin W H]
"""
import json, re, sys, os
from PIL import Image, ImageDraw, ImageFont

ROOT = sys.argv[1]
NUM_TILES_PRIMARY = 640
NUM_METATILES_PRIMARY = 640
NUM_PALS_PRIMARY = 7

def read(p):
    return open(os.path.join(ROOT, p), encoding='utf8').read()

GRAPHICS = read('src/data/tilesets/graphics.h')
METATILES = read('src/data/tilesets/metatiles.h')
HEADERS = read('src/data/tilesets/headers.h')

def tileset_paths(name):
    block = re.search(r'const struct Tileset %s =\s*\{(.*?)\};' % re.escape(name), HEADERS, re.S).group(1)
    tiles_sym = re.search(r'\.tiles = (\w+)', block).group(1)
    pal_sym = re.search(r'\.palettes = (\w+)', block).group(1)
    meta_sym = re.search(r'\.metatiles = (\w+)', block).group(1)
    attr_sym = re.search(r'\.metatileAttributes = (\w+)', block).group(1)
    tiles = re.search(r'%s\[\] = INC\w+\("([^"]+)"' % tiles_sym, GRAPHICS).group(1)
    pals_block = re.search(r'%s\[\]\[16\] =\s*\{(.*?)\};' % pal_sym, GRAPHICS, re.S).group(1)
    pals = re.findall(r'"([^"]+\.pal)"', pals_block)
    meta = re.search(r'%s\[\] = INCBIN_U16\("([^"]+)"\)' % meta_sym, METATILES).group(1)
    attr = re.search(r'%s\[\] = INCBIN_U16\("([^"]+)"\)' % attr_sym, METATILES).group(1)
    return tiles, pals, meta, attr

def load_pal(path):
    lines = read(path).split('\n')
    cols = []
    for l in lines[3:19]:
        r, g, b = map(int, l.split()[:3])
        cols.append((r, g, b))
    return cols

class Tileset:
    def __init__(self, name):
        self.name = name
        tiles, pals, meta, attr = tileset_paths(name)
        im = Image.open(os.path.join(ROOT, tiles))
        self.tiles = []
        w, h = im.size
        px = im.load()
        for ty in range(h // 8):
            for tx in range(w // 8):
                self.tiles.append([[px[tx * 8 + x, ty * 8 + y] & 15 for x in range(8)] for y in range(8)])
        self.pals = [load_pal(p) for p in pals]
        data = open(os.path.join(ROOT, meta), 'rb').read()
        self.metatiles = [[int.from_bytes(data[i + j * 2:i + j * 2 + 2], 'little') for j in range(8)] for i in range(0, len(data), 16)]
        a = open(os.path.join(ROOT, attr), 'rb').read()
        self.attrs = [int.from_bytes(a[i:i + 4], 'little') for i in range(0, len(a), 4)]

class Pair:
    def __init__(self, primary, secondary):
        self.p = Tileset(primary)
        self.s = Tileset(secondary)
        self.pals = self.p.pals[:NUM_PALS_PRIMARY] + self.s.pals[NUM_PALS_PRIMARY:]
        self.cache = {}

    def tile(self, idx):
        if idx < NUM_TILES_PRIMARY:
            return self.p.tiles[idx] if idx < len(self.p.tiles) else None
        idx -= NUM_TILES_PRIMARY
        return self.s.tiles[idx] if idx < len(self.s.tiles) else None

    def metatile(self, mid):
        if mid < NUM_METATILES_PRIMARY:
            return self.p.metatiles[mid] if mid < len(self.p.metatiles) else None
        mid -= NUM_METATILES_PRIMARY
        return self.s.metatiles[mid] if mid < len(self.s.metatiles) else None

    def attr(self, mid):
        if mid < NUM_METATILES_PRIMARY:
            return self.p.attrs[mid] if mid < len(self.p.attrs) else 0
        mid -= NUM_METATILES_PRIMARY
        return self.s.attrs[mid] if mid < len(self.s.attrs) else 0

    def render_metatile(self, mid):
        if mid in self.cache:
            return self.cache[mid]
        img = Image.new('RGB', (16, 16), (255, 0, 255))
        px = img.load()
        mt = self.metatile(mid)
        if mt is None:
            self.cache[mid] = img
            return img
        for layer in range(2):
            for q in range(4):
                e = mt[layer * 4 + q]
                t = self.tile(e & 0x3FF)
                if t is None:
                    continue
                hf, vf, pal = (e >> 10) & 1, (e >> 11) & 1, (e >> 12) & 15
                colors = self.pals[pal] if pal < len(self.pals) else [(255, 0, 255)] * 16
                ox, oy = (q % 2) * 8, (q // 2) * 8
                for y in range(8):
                    for x in range(8):
                        c = t[7 - y if vf else y][7 - x if hf else x]
                        if layer == 1 and c == 0:
                            continue
                        if layer == 0 and c == 0:
                            px[ox + x, oy + y] = colors[0]
                        else:
                            px[ox + x, oy + y] = colors[c]
        self.cache[mid] = img
        return img

def font():
    try:
        return ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 9)
    except Exception:
        return ImageFont.load_default()

def render_tileset(primary, secondary, out, start, count, cols=16, scale=3):
    pair = Pair(primary, secondary)
    rows = (count + cols - 1) // cols
    img = Image.new('RGB', (cols * 16 * scale, rows * 16 * scale), (40, 40, 40))
    d = ImageDraw.Draw(img)
    f = font()
    for i in range(count):
        mid = start + i
        mt = pair.render_metatile(mid).resize((16 * scale, 16 * scale), Image.NEAREST)
        x, y = (i % cols) * 16 * scale, (i // cols) * 16 * scale
        img.paste(mt, (x, y))
        d.rectangle([x, y, x + 16 * scale - 1, y + 16 * scale - 1], outline=(90, 90, 90))
        label = '%X' % mid
        d.text((x + 2, y + 1), label, fill=(0, 0, 0), font=f)
        d.text((x + 1, y), label, fill=(255, 255, 0), font=f)
        beh = pair.attr(mid) & 0x1FF
        if beh:
            d.text((x + 2, y + 16 * scale - 11), '%X' % beh, fill=(0, 255, 255), font=f)
    img.save(out)

def layouts():
    return {l['id']: l for l in json.loads(read('data/layouts/layouts.json'))['layouts'] if 'id' in l}

def render_blocks(primary, secondary, blocks, w, h, out, grid=False, coll=False, marks=(), scale=2):
    pair = Pair(primary, secondary)
    img = Image.new('RGB', (w * 16, h * 16))
    for y in range(h):
        for x in range(w):
            b = blocks[y * w + x]
            img.paste(pair.render_metatile(b & 0x3FF), (x * 16, y * 16))
    img = img.resize((w * 16 * scale, h * 16 * scale), Image.NEAREST)
    d = ImageDraw.Draw(img)
    f = font()
    S = 16 * scale
    if grid:
        for x in range(w + 1):
            d.line([(x * S, 0), (x * S, h * S)], fill=(255, 0, 0) if x % 5 == 0 else (120, 0, 0))
        for y in range(h + 1):
            d.line([(0, y * S), (w * S, y * S)], fill=(255, 0, 0) if y % 5 == 0 else (120, 0, 0))
        for x in range(w):
            d.text((x * S + 2, 1), str(x), fill=(255, 255, 0), font=f)
        for y in range(h):
            d.text((1, y * S + 2), str(y), fill=(255, 255, 0), font=f)
    if coll:
        for y in range(h):
            for x in range(w):
                b = blocks[y * w + x]
                c, e = (b >> 10) & 3, b >> 12
                tx, ty = x * S + 3, y * S + S - 12
                if c:
                    d.rectangle([x * S + 1, y * S + 1, x * S + S - 2, y * S + S - 2], outline=(255, 0, 0))
                d.text((tx, ty), '%d' % e, fill=(0, 255, 0) if not c else (255, 80, 80), font=f)
    for (x, y, col) in marks:
        d.rectangle([x * S + 2, y * S + 2, x * S + S - 3, y * S + S - 3], outline=col, width=3)
    img.save(out)

if __name__ == '__main__':
    mode = sys.argv[2]
    if mode == 'tileset':
        prim = sys.argv[3]
        sec = sys.argv[4]
        out = sys.argv[5]
        which = sys.argv[6] if len(sys.argv) > 6 else 'secondary'
        if which == 'primary':
            render_tileset(prim, sec, out, 0, 640)
        else:
            n = len(Tileset(sec).metatiles)
            render_tileset(prim, sec, out, 640, n)
    elif mode == 'layout':
        L = layouts()[sys.argv[3]]
        out = sys.argv[4]
        data = open(os.path.join(ROOT, L['blockdata_filepath']), 'rb').read()
        blocks = [int.from_bytes(data[i:i + 2], 'little') for i in range(0, len(data), 2)]
        render_blocks(L['primary_tileset'], L['secondary_tileset'], blocks, L['width'], L['height'], out,
                      grid='--grid' in sys.argv, coll='--coll' in sys.argv)
    elif mode == 'blocks':
        prim, sec, path, w, h, out = sys.argv[3], sys.argv[4], sys.argv[5], int(sys.argv[6]), int(sys.argv[7]), sys.argv[8]
        data = open(path, 'rb').read()
        blocks = [int.from_bytes(data[i:i + 2], 'little') for i in range(0, len(data), 2)]
        render_blocks(prim, sec, blocks, w, h, out, grid='--grid' in sys.argv, coll='--coll' in sys.argv)
