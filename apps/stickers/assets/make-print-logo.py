#!/usr/bin/env python3
"""Convert the color Pitt Stop logo (red/yellow script + white subtitle on blue)
into a crisp black-on-white print version for the QL-800 thermal label printer.

Rules (per pixel, on a 3x supersampled image, then downsampled for anti-aliasing):
  - background blue   -> white
  - red/orange/yellow lettering + navy outlines/shadows -> black
  - white subtitle fill -> stays white (so "Detail & Auto Sales" prints outlined)
Then auto-crop to the ink bounding box with a small margin.
"""
import sys
from PIL import Image, ImageFilter

SRC = sys.argv[1]
OUT = sys.argv[2]

img = Image.open(SRC).convert('RGB')
# Supersample for smooth edges after hard-ish classification.
SS = 3
big = img.resize((img.width * SS, img.height * SS), Image.LANCZOS)
px = big.load()

# Sample the background blue from the corners.
corners = [px[2, 2], px[big.width - 3, 2], px[2, big.height - 3], px[big.width - 3, big.height - 3]]
bg = tuple(sum(c[i] for c in corners) // 4 for i in range(3))

def dist(a, b):
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) ** 0.5

# Pass 1: find the subtitle region = bbox of white-ish fill pixels ("Detail & Auto Sales").
white_mask = Image.new('L', big.size, 0)
wp = white_mask.load()
for y in range(big.height):
    for x in range(big.width):
        r, g, b = px[x, y]
        if min(r, g, b) > 185 and (max(r, g, b) - min(r, g, b)) < 55:
            wp[x, y] = 255
sub_bbox = white_mask.getbbox()
GROW = 10 * SS
sub = (max(0, sub_bbox[0] - GROW), max(0, sub_bbox[1] - GROW),
       min(big.width, sub_bbox[2] + GROW), min(big.height, sub_bbox[3] + GROW)) if sub_bbox else (0, 0, 0, 0)

# Adaptive threshold for the subtitle: the tiny letters' inner strokes are faint
# navy/blue blends, invisible to global color rules, but always DARKER than their
# local neighborhood. local_mean - delta separates them; the uniform background
# never triggers it.
lum = big.convert('L')
local_mean = lum.filter(ImageFilter.BoxBlur(14))
lp, mp = lum.load(), local_mean.load()

out = Image.new('L', big.size, 255)
op = out.load()
for y in range(big.height):
    for x in range(big.width):
        r, g, b = px[x, y]
        c = (r, g, b)
        in_sub = sub[0] <= x < sub[2] and sub[1] <= y < sub[3]
        if in_sub and (lp[x, y] < mp[x, y] - 28 or lp[x, y] < 75):
            op[x, y] = 0
            continue
        # Color rules (everywhere — also catches the red script strokes that cross
        # the subtitle region, which the luminance test misses).
        d_bg = dist(c, bg)
        if d_bg < 60:
            continue  # background -> white
        mn, mx = min(r, g, b), max(r, g, b)
        if mn > 165 and (mx - mn) < 70:
            continue  # near-white -> white
        alpha = min(1.0, max(0.0, (d_bg - 60) / 60.0))
        w = min(1.0, max(0.0, (mn - 130) / 50.0)) if (mx - mn) < 80 else 0.0
        ink = alpha * (1.0 - w)
        v = int(255 - ink * 255)
        if v < op[x, y]:
            op[x, y] = v

# Gentle despeckle of JPEG noise (at supersampled scale, so edges stay smooth).
out = out.filter(ImageFilter.MedianFilter(3))

# Subtitle region: remove small isolated dark specks (JPEG pepper noise inside the
# white letter fills) by connected-component area. Keeps the big outline strokes.
if sub != (0, 0, 0, 0):
    region = out.crop(sub)
    rp = region.load()
    W, H = region.size
    MIN_AREA = 110
    seen = [[False] * W for _ in range(H)]
    for sy in range(H):
        for sx in range(W):
            if seen[sy][sx] or rp[sx, sy] >= 128:
                continue
            stack = [(sx, sy)]
            comp = []
            seen[sy][sx] = True
            while stack:
                cx, cy = stack.pop()
                comp.append((cx, cy))
                for nx, ny in ((cx+1, cy), (cx-1, cy), (cx, cy+1), (cx, cy-1)):
                    if 0 <= nx < W and 0 <= ny < H and not seen[ny][nx] and rp[nx, ny] < 128:
                        seen[ny][nx] = True
                        stack.append((nx, ny))
            if len(comp) < MIN_AREA:
                for cx, cy in comp:
                    rp[cx, cy] = 255
    out.paste(region, sub)

# Crop to ink bbox (anything darker than 250), pad 2% of width.
bbox = out.point(lambda v: 255 if v < 250 else 0).getbbox()
pad = big.width // 50
bbox = (max(0, bbox[0] - pad), max(0, bbox[1] - pad), min(big.width, bbox[2] + pad), min(big.height, bbox[3] + pad))
out = out.crop(bbox)

# Downsample to target width (keep plenty of resolution for 300dpi print).
TARGET_W = 1600
out = out.resize((TARGET_W, round(out.height * TARGET_W / out.width)), Image.LANCZOS)
out.save(OUT)
print('saved', OUT, out.size)
