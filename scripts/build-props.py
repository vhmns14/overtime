# Office props and the building view: slices the generated pixel art in art/raw/office2/ (chroma-keyed
# on green), downsamples it to office scale with the same premultiplied box filter + hard alpha as
# build-atlas.py, snaps every prop that lives inside the room to the office background's own 256-colour
# palette (so new furniture can't drift from the room), and shelf-packs it all into
# src/assets/props.png + src/office/props-atlas.json. Also writes art/props-preview.png: the room with
# the props in place, to eyeball the fit. Run: npm run atlas (or python3 scripts/build-props.py)
import json
from PIL import Image
import numpy as np
from scipy import ndimage

RAW = 'art/raw/office2/'
P = json.load(open('art/props.json'))
BG = Image.open('src/assets/office.png')
BG_PAL = BG if BG.mode == 'P' else BG.convert('RGB').quantize(colors=256, dither=Image.Dither.NONE)


def key(path, lenient=False):
  a = np.array(Image.open(path).convert('RGBA')).astype(int)
  r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
  m = (g > 150) & (r < 120) & (b < 120)
  if lenient:  # semi-transparent green ghosts the generator sometimes leaves behind an object
    m |= (g > r + 25) & (g > b + 25)
  a[m, 3] = 0
  return a.astype(np.uint8)


def bbox(a, pad=0):
  ys, xs = np.nonzero(a[:, :, 3] > 128)
  return (max(0, xs.min() - pad), max(0, ys.min() - pad), xs.max() + 1 + pad, ys.max() + 1 + pad)


def shrink(a, w, h, palette=None, colors=48):
  """premultiplied box downsample, hard alpha, green de-fringe, then palette snap"""
  rgb = a[:, :, :3].astype(np.float32) * (a[:, :, 3:4] / 255.0)
  pm = np.dstack([rgb, a[:, :, 3:4]]).astype(np.uint8)
  small = np.array(Image.fromarray(pm, 'RGBA').resize((w, h), Image.BOX)).astype(np.float32)
  al = small[:, :, 3]
  out = np.zeros_like(small)
  mask = al > 110
  out[mask, :3] = np.clip(small[mask, :3] / (al[mask, None] / 255.0), 0, 255)
  out[mask, 3] = 255
  o = out.astype(np.uint8)
  op = o[:, :, 3] > 0
  edge = op & ~ndimage.binary_erosion(op)
  r_, g_, b_ = o[:, :, 0].astype(int), o[:, :, 1].astype(int), o[:, :, 2].astype(int)
  spill = edge & (g_ > np.maximum(r_, b_) + 12)
  o[spill, 0:3] = np.minimum(o[spill, 0:3], 40)
  img = Image.fromarray(o, 'RGBA')
  if palette is not None:
    q = img.convert('RGB').quantize(palette=palette, dither=Image.Dither.NONE).convert('RGB')
  else:
    q = img.convert('RGB').quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert('RGB')
  return np.dstack([np.array(q), o[:, :, 3]]).astype(np.uint8)


frames = {}

# --- bookcase (empty shelves; books are drawn live, one per Hermes skill) ---
a = key(RAW + 'ot-bookcase-empty.png', lenient=True)
a = a[430:1300, 80:570]
x0, y0, x1, y1 = bbox(a)
bc = P['bookcase']
frames['bookcase'] = shrink(a[y0:y1, x0:x1], bc['w'], bc['h'], BG_PAL)

# --- the plant that stands in front of the bookcase: lifted out of the background so it stays in front ---
po = P['plantOccluder']
reg = np.array(BG.convert('RGBA'))[po['y']:po['y'] + po['h'], po['x']:po['x'] + po['w']].copy()
rr, gg, bb = reg[:, :, 0].astype(int), reg[:, :, 1].astype(int), reg[:, :, 2].astype(int)
leaf = (gg > rr + 4) & (gg >= bb)
leaf = ndimage.binary_closing(leaf, iterations=1)
dark = (rr + gg + bb) < 150
leaf |= ndimage.binary_dilation(leaf, iterations=1) & dark
px0, py0, px1, py1 = po['pot']
leaf[py0 - po['y']:py1 - po['y'], px0 - po['x']:px1 - po['x']] = True
reg[~leaf, 3] = 0
frames['plant_front'] = reg

# --- filing cabinet (glows when Hermes writes or recalls memory) ---
a = key(RAW + 'ot-filing-cabinet.png')
x0, y0, x1, y1 = bbox(a)
a = a[y0:y1, x0:x1]
cab = P['cabinet']
w = round(cab['h'] * a.shape[1] / a.shape[0])
c = shrink(a, w, cab['h'], BG_PAL)
if cab.get('flip'): c = c[:, ::-1].copy()
frames['cabinet'] = c

# --- scoreboard (front view; sheared onto the wall at draw time, digits drawn live) ---
a = key(RAW + 'ot-scoreboard.png')
x0, y0, x1, y1 = bbox(a)
sb = P['scoreboard']
frames['scoreboard'] = shrink(a[y0:y1, x0:x1], sb['w'], sb['h'], BG_PAL)

# --- book spines ---
a = key(RAW + 'ot-book-spines.png')
lab, n = ndimage.label(a[:, :, 3] > 128)
objs = [s for s in ndimage.find_objects(lab) if (s[0].stop - s[0].start) > 200]
objs.sort(key=lambda s: ((s[0].start + s[0].stop) // 2 // 400, s[1].start))
maxh = max(s[0].stop - s[0].start for s in objs)
scale = P['spineHeight'] / maxh
for i, s in enumerate(objs):
  crop = a[s[0], s[1]]
  h = max(8, round(crop.shape[0] * scale))
  w = max(4, round(crop.shape[1] * scale * P.get('spineWiden', 1)))  # chunkier than true scale, so one book reads at office zoom
  frames[f'spine{i}'] = shrink(crop, w, h, BG_PAL)

# --- building cross-section: roof (with the top floor), repeatable floors, lobby ---
a = key(RAW + 'ot-building.png')
x0, y0, x1, y1 = bbox(a)
a = a[y0:y1, x0:x1]
s = P['buildingScale']
W, H = round(a.shape[1] * s), round(a.shape[0] * s)
full = shrink(a, W, H, None, colors=96)
# slab rows: long runs of grey concrete across the body
rgb = full[:, :, :3].astype(int)
grey = (np.abs(rgb[:, :, 0] - rgb[:, :, 1]) < 22) & (np.abs(rgb[:, :, 1] - rgb[:, :, 2]) < 22) & (rgb[:, :, 0] > 70) & (rgb[:, :, 0] < 175)
frac = grey[:, int(W * 0.05):int(W * 0.95)].mean(axis=1)
rows = [y for y in range(H) if frac[y] > 0.72]
slabs = []
for y in rows:
  if slabs and y - slabs[-1][1] <= 2: slabs[-1][1] = y
  else: slabs.append([y, y])
slabs = [sl for sl in slabs if H * 0.2 < sl[0] < H * 0.93]  # the roof cap and the ground line are not floor slabs
print('building', W, H, 'slabs', slabs)
tops = [sl[0] for sl in slabs]
# tops[0..3]: under floor 4, 3, 2, 1 (the last is the lobby ceiling)
frames['b_roof'] = full[0:tops[0]]
for i in range(len(tops) - 1):
  frames[f'b_floor{i}'] = full[tops[i]:tops[i + 1]]
frames['b_lobby'] = full[tops[-1]:]

# --- elevator car ---
a = key(RAW + 'ot-elevator.png')
lab, n = ndimage.label(a[:, :, 3] > 128)
sizes = ndimage.sum(np.ones_like(lab), lab, range(1, n + 1))
big = int(np.argmax(sizes)) + 1
ys, xs = np.nonzero(lab == big)
crop = a[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
# drop the cable: keep from the first row that is wider than a third of the car
wide = [y for y in range(crop.shape[0]) if (crop[y, :, 3] > 128).sum() > crop.shape[1] * 0.2]
crop = crop[wide[0]:]
ew = round(W * 0.155)
frames['elevator'] = shrink(crop, ew, round(ew * crop.shape[0] / crop.shape[1]), None, colors=40)

# --- pack ---
pad = 2; AW = 1024; x = y = rowh = 0; out = {}
for name, im in sorted(frames.items(), key=lambda kv: -kv[1].shape[0]):
  h, w = im.shape[:2]
  if x + w + pad > AW: x = 0; y += rowh + pad; rowh = 0
  out[name] = dict(x=x, y=y, w=int(w), h=int(h)); x += w + pad; rowh = max(rowh, h)
AH = y + rowh
atlas = Image.new('RGBA', (AW, AH), (0, 0, 0, 0))
for name, im in frames.items():
  atlas.paste(Image.fromarray(im, 'RGBA'), (out[name]['x'], out[name]['y']))
atlas.save('src/assets/props.png', optimize=True)
meta = dict(size=[AW, AH], frames=out, spines=len(objs), building=dict(floors=len(tops) - 1, width=int(W)), place={k: v for k, v in P.items() if k != 'note'})
json.dump(meta, open('src/office/props-atlas.json', 'w'), indent=0)
print('props', AW, AH, len(out), 'spines', len(objs))

# --- preview: the room with the props in place ---
pv = BG.convert('RGBA')
pv.alpha_composite(Image.fromarray(frames['bookcase'], 'RGBA'), (bc['x'], bc['y']))
pv.alpha_composite(Image.fromarray(frames['plant_front'], 'RGBA'), (po['x'], po['y']))
pv.alpha_composite(Image.fromarray(frames['cabinet'], 'RGBA'), (cab['x'], cab['y']))
sbim = Image.fromarray(frames['scoreboard'], 'RGBA')
sh = sb['shear']
# y' = y + shear * x  →  inverse map for PIL affine: (x, y) ← (x', y' - shear * x')
sheared = sbim.transform((sb['w'], sb['h'] + int(abs(sh) * sb['w']) + 2), Image.AFFINE, (1, 0, 0, -sh, 1, sh * sb["w"] if sh < 0 else 0), Image.NEAREST)
pv.alpha_composite(sheared, (sb['x'], sb['y'] + int(sh * sb['w'])))
pv.save('art/props-preview.png')
