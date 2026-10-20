#!/usr/bin/env python3
"""Builds the Mt. Silver summit layout (map.bin + border.bin) for Daily Red.

  summit.py EXPANSION_ROOT OUT_DIR [--render out.png]

The layout follows Gold/Silver/Crystal's Silver Cave Room 3 (pret/pokecrystal
maps/SilverCaveRoom3.blk), RED's room: the cave mouth at the bottom, a long
narrow climb north, a landing, and stairs up onto the raised peak where RED
stands looking north. It is drawn with FireRed's icy cave tiles (Icefall Cave /
Seafoam Islands) and the map has snow weather, for HeartGold/SoulSilver's
snowy summit.
"""
import sys, os

W, H = 20, 36

# Metatiles (gTileset_General_Frlg + gTileset_SeafoamIslands)
FLOOR = 0x281
SNOW = 0x291          # impassable snow/rock mass
STAIRS = 0x284
BOULDER = 0x282
BOULDER2 = 0x283
SNOWPILE = 0x2CF

# plateau (raised floor) pieces
P_TL, P_T, P_TR = 0x2D0, 0x2D1, 0x2D2
P_L, P_M, P_R = 0x2D8, 0x2D9, 0x2DA
P_BL, P_B, P_BR = 0x2E0, 0x2E1, 0x2E2
CLIFF_L, CLIFF, CLIFF_R = 0x298, 0x299, 0x29A

# rock edges around ground floor
FACE = 0x299          # rock face, floor below it
FACE_L = 0x29B        # left end of a face
FACE_R = 0x29C        # right end of a face
SIDE_E = 0x292        # rock with floor to its right (east)
SIDE_W = 0x290        # rock with floor to its left (west)
TOP = 0x289           # rock with floor above it (north)
EXIT_L, EXIT, EXIT_R = 0x2C8, 0x2C9, 0x2CA

GROUND_ELEV = 3
PEAK_ELEV = 4

grid = [[None] * W for _ in range(H)]   # (metatile, collision, elevation)
kind = [['R'] * W for _ in range(H)]    # R rock, F floor, P plateau

def rect(x0, y0, x1, y1, k):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            kind[y][x] = k

# --- the shape (after SilverCaveRoom3) -----------------------------------------
# Peak: raised platform where RED stands, stairs at its bottom center.
PEAK = (6, 7, 13, 11)            # x0, y0, x1, y1 (inclusive)
STAIRS_POS = (9, 12)
RED_POS = (9, 8)
START_POS = (9, 33)
rect(*PEAK, 'P')
# Landing below the peak.
rect(5, 13, 14, 13, 'F')
rect(7, 14, 12, 15, 'F')
# Side alcoves off the landing (dead ends, as in GSC).
rect(5, 10, 5, 12, 'F')
rect(14, 10, 14, 12, 'F')
# The long climb.
rect(9, 16, 10, 30, 'F')
# Where the player comes out of the cave.
rect(7, 31, 12, 33, 'F')
kind[STAIRS_POS[1]][STAIRS_POS[0]] = 'S'

def is_open(x, y):
    return 0 <= x < W and 0 <= y < H and kind[y][x] in 'FS'

for y in range(H):
    for x in range(W):
        k = kind[y][x]
        if k == 'F':
            grid[y][x] = (FLOOR, 0, GROUND_ELEV)
        elif k == 'S':
            grid[y][x] = (STAIRS, 0, 0)
        elif k == 'P':
            x0, y0, x1, y1 = PEAK
            col = 0 if x == x0 else 2 if x == x1 else 1
            row = 0 if y == y0 else 2 if y == y1 else 1
            mt = [[P_TL, P_T, P_TR], [P_L, P_M, P_R], [P_BL, P_B, P_BR]][row][col]
            grid[y][x] = (mt, 0, PEAK_ELEV)
        else:
            n, s, e, w = is_open(x, y - 1), is_open(x, y + 1), is_open(x + 1, y), is_open(x - 1, y)
            # cliff under the peak
            if y == PEAK[3] + 1 and PEAK[0] <= x <= PEAK[2]:
                mt = CLIFF_L if x == PEAK[0] else CLIFF_R if x == PEAK[2] else CLIFF
            elif s and w and not e:
                mt = FACE_R
            elif s and e and not w:
                mt = FACE_L
            elif s:
                mt = FACE
            elif e:
                mt = SIDE_E
            elif w:
                mt = SIDE_W
            elif n:
                mt = TOP
            else:
                mt = SNOW
            grid[y][x] = (mt, 1, 0)

# The cave mouth under the start.
sx, sy = START_POS
for dx, mt in [(-1, EXIT_L), (0, EXIT), (1, EXIT_R)]:
    grid[sy + 1][sx + dx] = (mt, 1, 0)

def encode(mt, coll, elev):
    return (mt & 0x3FF) | (coll << 10) | (elev << 12)

def write(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, 'map.bin'), 'wb') as f:
        for row in grid:
            for cell in row:
                f.write(encode(*cell).to_bytes(2, 'little'))
    with open(os.path.join(out_dir, 'border.bin'), 'wb') as f:
        for _ in range(4):
            f.write(encode(SNOW, 1, 0).to_bytes(2, 'little'))

if __name__ == '__main__':
    root, out = sys.argv[1], sys.argv[2]
    write(out)
    if '--render' in sys.argv:
        png = sys.argv[sys.argv.index('--render') + 1]
        tools = os.path.dirname(os.path.abspath(__file__))
        sys.argv = ['frlgmap', root]
        ns = {}
        exec(open(os.path.join(tools, 'frlgmap.py')).read().split("if __name__ == '__main__':")[0], ns)
        blocks = [encode(*c) for row in grid for c in row]
        ns['render_blocks']('gTileset_General_Frlg', 'gTileset_SeafoamIslands', blocks, W, H, png, grid=True, coll=True,
                            marks=[(RED_POS[0], RED_POS[1], (255, 0, 0)), (START_POS[0], START_POS[1], (0, 200, 0))])
