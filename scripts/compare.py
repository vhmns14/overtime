# Side-by-side: approved mockup vs. the real app (same height), for docs/compare-*.png
import sys
from PIL import Image, ImageDraw
def pair(a, bs, out, h):
    A = Image.open(a).convert('RGB')
    A = A.resize((round(A.width * h / A.height), h), Image.LANCZOS)
    Bs = [Image.open(b).convert('RGB') for b in (bs if isinstance(bs, list) else [bs])]
    Bs = [B.resize((round(B.width * h / B.height), h), Image.LANCZOS) for B in Bs]
    m = Image.new('RGB', (A.width + sum(B.width + 24 for B in Bs), h + 34), (243, 238, 228))
    m.paste(A, (0, 34))
    x = A.width + 24
    for B in Bs: m.paste(B, (x, 34)); x += B.width + 24
    d = ImageDraw.Draw(m)
    d.text((8, 10), 'MOCKUP', fill=(20, 18, 16)); d.text((A.width + 32, 10), 'APP (real screenshot)', fill=(20, 18, 16))
    m.save(out)
# Usage: python3 scripts/compare.py <mockup-desktop.png> <mockup-mobile.png> <app-desktop.png> <app-mobile.png>...
pair(sys.argv[1], sys.argv[3], 'docs/compare-desktop.png', 768)
pair(sys.argv[2], sys.argv[4:], 'docs/compare-mobile.png', 844)
