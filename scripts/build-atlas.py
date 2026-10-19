# Slices the generated character sheets (chroma-keyed PNGs) into frames, downsamples them to the
# office scale with a box filter + hard alpha + per-sprite palette quantisation, normalises facing,
# and packs everything into src/assets/atlas.png + src/office/atlas.json. Run: npm run atlas
import json, sys
from PIL import Image
import numpy as np
from scipy import ndimage

SCALE = 0.25
ROLES = ['pm', 'research', 'coder', 'reviewer', 'ops']
# which component index (row-major) is which pose, per sheet
MAP = {
  'pm':       dict(idle=0, walkA=1, walkB=2, back=3, bwalkA=6, bwalkB=7, sitA=8, sitB=9),
  'research': dict(idle=0, walkA=1, walkB=2, back=3, bwalkA=5, bwalkB=6, sitA=7, sitB=8),
  'coder':    dict(idle=0, walkA=1, walkB=2, back=3, bwalkA=5, bwalkB=6, sitA=7, sitB=8),
  'reviewer': dict(idle=0, walkA=1, walkB=2, back=3, bwalkA=4, bwalkB=5, sitA=6, sitB=7),
  'ops':      dict(idle=0, walkA=1, walkB=2, back=3, bwalkA=4, bwalkB=5, sitA=6, sitB=7),
}
# poses whose source faces the opposite of the canonical direction get mirrored.
# canonical: front poses face down-right, back poses face up-left, sit poses face up-left.
FLIP = {'research': {'sitA': 1, 'sitB': 1}, 'reviewer': {'sitA': 1}}
# extra poses from the second sheet (art/raw/sit-<role>.png): coffee mug idle, front-facing desk typing
EXTRA = {
  'pm':       dict(mug=5),
  'research': dict(mug=3, fsitA=0, fsitB=1),
  'coder':    dict(mug=4, fsitA=1, fsitB=2),
  'reviewer': dict(mug=3, fsitA=0, fsitB=1),
  'ops':      dict(mug=3, fsitA=0, fsitB=2),
}
PORTRAIT_TILE = {'pm': 0, 'research': 1, 'coder': 2, 'ops': 3, 'reviewer': 5}

def components(a):
  al = a[:, :, 3] > 128
  lab, _ = ndimage.label(ndimage.binary_dilation(al, iterations=6))
  boxes = []
  for s in ndimage.find_objects(lab):
    b = (s[1].start, s[0].start, s[1].stop, s[0].stop)
    if (b[2]-b[0])*(b[3]-b[1]) > 4000: boxes.append(b)
  return sorted(boxes, key=lambda b: (b[1]//200, b[0]))

def shrink(im, scale):
  w, h = im.size
  nw, nh = max(1, round(w*scale)), max(1, round(h*scale))
  a = np.array(im).astype(np.float32)
  # premultiply so green fringe does not bleed in
  rgb = a[:, :, :3] * (a[:, :, 3:4]/255.0)
  pm = np.dstack([rgb, a[:, :, 3:4]]).astype(np.uint8)
  small = np.array(Image.fromarray(pm, 'RGBA').resize((nw, nh), Image.BOX)).astype(np.float32)
  al = small[:, :, 3]
  out = np.zeros_like(small)
  mask = al > 110
  out[mask, :3] = np.clip(small[mask, :3] / (al[mask, None]/255.0), 0, 255)
  out[mask, 3] = 255
  # de-fringe: edge pixels with a green cast (chroma-key spill) are neutralised to the outline colour
  o = out.astype(np.uint8)
  op = o[:, :, 3] > 0
  edge = op & ~ndimage.binary_erosion(op)
  r_, g_, b_ = o[:, :, 0].astype(int), o[:, :, 1].astype(int), o[:, :, 2].astype(int)
  spill = edge & (g_ > np.maximum(r_, b_) + 12)
  o[spill, 0:3] = np.minimum(o[spill, 0:3], 40)
  o[spill, 1] = np.minimum(o[spill, 0], 40)
  img = Image.fromarray(o, 'RGBA')
  # palette clean: quantise opaque colours to <= 40 colours
  rgbimg = img.convert('RGB').quantize(colors=40, method=Image.Quantize.MEDIANCUT).convert('RGB')
  q = np.dstack([np.array(rgbimg), np.array(img)[:, :, 3]])
  return Image.fromarray(q.astype(np.uint8), 'RGBA')

def load(path):
  a = np.array(Image.open(path).convert('RGBA'))
  g = (a[:, :, 1].astype(int) > 150) & (a[:, :, 0] < 120) & (a[:, :, 2] < 120)
  a[g, 3] = 0
  return a

frames = {}
for r in ROLES:
  b2 = load(f'art/raw/sit-{r}.png'); bx2 = components(b2)
  for pose, idx in EXTRA[r].items():
    frames[f'{r}_{pose}'] = shrink(Image.fromarray(b2).crop(bx2[idx]), SCALE)
  a = load(f'art/raw/char-{r}.png')
  boxes = components(a)
  for pose, idx in MAP[r].items():
    b = boxes[idx]
    crop = Image.fromarray(a).crop(b)
    if FLIP.get(r, {}).get(pose): crop = crop.transpose(Image.FLIP_LEFT_RIGHT)
    frames[f'{r}_{pose}'] = shrink(crop, SCALE)

# portraits: 5 busts, square-ish tiles
p = Image.open('art/raw/portraits.png').convert('RGBA'); pa = np.array(p)
green = (pa[:, :, 1].astype(int) > 180) & (pa[:, :, 0] < 110) & (pa[:, :, 2] < 110)
pa[green, 3] = 0
boxes = components(pa)
boxes = [b for b in boxes if (b[2]-b[0]) > 80]
for r in ROLES:
  b = boxes[PORTRAIT_TILE[r]]
  b = (b[0] + 6, b[1] + 6, b[2] - 6, b[3] - 6)  # inset: drop the keyed edge of the tile
  crop = Image.fromarray(pa).crop(b)
  frames[f'{r}_portrait'] = crop.resize((96, round(96*crop.size[1]/crop.size[0])), Image.BOX).convert('RGBA')

# office background: palette-clean 256-colour PNG (no dithering keeps pixel edges crisp)
Image.open('art/raw/office-empty.png').convert('RGB').quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save('src/assets/office.png', optimize=True)

# shelf pack
pad = 2; W = 1024; x = y = rowh = 0; out = {}
items = sorted(frames.items(), key=lambda kv: -kv[1].size[1])
for name, im in items:
  w, h = im.size
  if x + w + pad > W: x = 0; y += rowh + pad; rowh = 0
  out[name] = dict(x=x, y=y, w=w, h=h); x += w + pad; rowh = max(rowh, h)
H = y + rowh
atlas = Image.new('RGBA', (W, H), (0, 0, 0, 0))
for name, im in frames.items():
  f = out[name]; atlas.paste(im, (f['x'], f['y']))
atlas.save('src/assets/atlas.png', optimize=True)
json.dump(dict(size=[W, H], frames=out), open('src/office/atlas.json', 'w'), indent=0)
print('atlas', W, H, len(out))
