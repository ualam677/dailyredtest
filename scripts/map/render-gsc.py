import sys
from PIL import Image
pc, mapname, w, h, out = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
blk = open(f"{pc}/maps/{mapname}.blk", "rb").read()
meta = open(f"{pc}/data/tilesets/cave_metatiles.bin", "rb").read()
tiles = Image.open(f"{pc}/gfx/tilesets/cave.png").convert("L")
tw = tiles.width // 8
ntiles = tw * (tiles.height // 8)
print("tiles", ntiles, "size", tiles.size, "blk", len(blk))
img = Image.new("L", (w * 32, h * 32), 128)
for by in range(h):
    for bx in range(w):
        b = blk[by * w + bx]
        for ty in range(4):
            for tx in range(4):
                t = meta[b * 16 + ty * 4 + tx]
                t2 = t if t < 0x80 else t - 0x20  # crystal bank 1 tiles follow the first 0x60
                if t2 >= ntiles: t2 = 0
                tile = tiles.crop(((t2 % tw) * 8, (t2 // tw) * 8, (t2 % tw) * 8 + 8, (t2 // tw) * 8 + 8))
                img.paste(tile, (bx * 32 + tx * 8, by * 32 + ty * 8))
img = img.convert("RGB")
# grid of 16px steps and coordinates every 2 steps
from PIL import ImageDraw
d = ImageDraw.Draw(img)
for x in range(0, w * 32, 16):
    d.line([(x, 0), (x, h * 32)], fill=(255, 0, 0) if x % 32 == 0 else (255, 160, 160))
for y in range(0, h * 32, 16):
    d.line([(0, y), (w * 32, y)], fill=(255, 0, 0) if y % 32 == 0 else (255, 160, 160))
for (x, y, c) in [(9, 10, (0, 0, 255)), (9, 33, (0, 200, 0))]:
    d.rectangle([x * 16 + 3, y * 16 + 3, x * 16 + 12, y * 16 + 12], outline=c, width=2)
img = img.resize((img.width * 2, img.height * 2), Image.NEAREST)
img.save(out)
print(b" ".join(f"{b:02x}".encode() for b in blk).decode())
