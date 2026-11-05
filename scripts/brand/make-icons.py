"""Draws the tsc-laws mark and writes every icon size the stores and the repository need.

The mark is the word 'law' in a monospace face on TypeScript blue, with a yellow tick badge: code that is checked.
Everything is drawn with supersampling, so the edges are clean at any size. It needs a bold monospace font (Consolas,
Cascadia Code, DejaVu Sans Mono or Liberation Mono).

    python -I scripts/brand/make-icons.py

Writes:
  packages/vscode-tslaws/icon.png       256x256   the extension icon (the Marketplace needs at least 128x128)
  docs/media/brand/logo-128.png         128x128   the Marketplace publisher logo (the form asks for exactly 128x128)
  docs/media/brand/logo-512.png         512x512   the Open VSX namespace logo
  docs/media/brand/logo-1024.png        1024x1024 master raster
  docs/media/brand/social-1280x640.png  1280x640  the repository social preview
  docs/media/brand/logo.svg                       vector master
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
NAVY = (20, 26, 58)
BLUE = (44, 62, 163)
CREAM = (239, 231, 211)
YELLOW = (242, 194, 48)
WHITE = (255, 255, 255)
TS_TOP = (49, 120, 198)
TS_BOTTOM = (30, 90, 170)
SS = 4  # supersampling


def _font(size):
    for name in ('consolab.ttf', 'CascadiaCode.ttf', 'DejaVuSansMono-Bold.ttf', 'LiberationMono-Bold.ttf'):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    raise SystemExit('no bold monospace font found: install DejaVu Sans Mono or Liberation Mono')


def mark(size):
    """The square mark at `size` pixels: the word 'law' on TypeScript blue, with a yellow tick badge."""
    s = size * SS
    gradient = Image.new('RGBA', (s, s))
    gd = ImageDraw.Draw(gradient)
    for y in range(s):
        t = y / (s - 1)
        gd.line([(0, y), (s, y)], fill=tuple(int(TS_TOP[i] + (TS_BOTTOM[i] - TS_TOP[i]) * t) for i in range(3)) + (255,))
    mask = Image.new('L', (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=255)
    image = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    image.paste(gradient, (0, 0), mask)
    draw = ImageDraw.Draw(image)
    font = _font(int(s * 0.4))
    box = draw.textbbox((0, 0), 'law', font=font)
    draw.text((s * 0.5 - (box[2] - box[0]) / 2 - box[0], s * 0.44 - (box[3] - box[1]) / 2 - box[1]), 'law', font=font, fill=WHITE)
    # The badge: a yellow disc with a navy tick, bottom right.
    cx, cy, r = s * 0.76, s * 0.76, s * 0.15
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=YELLOW)
    points = [(cx - r * 0.575, cy + r * 0.02), (cx - r * 0.14, cy + r * 0.46), (cx + r * 0.63, cy - r * 0.44)]
    width = int(r * 0.34)
    draw.line(points, fill=NAVY, width=width, joint='curve')
    for x, y in (points[0], points[2]):
        draw.ellipse([x - width / 2, y - width / 2, x + width / 2, y + width / 2], fill=NAVY)
    return image.resize((size, size), Image.LANCZOS)


def social():
    """1280x640 repository preview: the mark, the name and the one-line promise."""
    w, h = 1280, 640
    image = Image.new('RGB', (w, h), NAVY)  # navy to blue, so the TypeScript-blue mark stands out
    draw = ImageDraw.Draw(image)
    for y in range(h):
        t = y / (h - 1)
        draw.line([(0, y), (w, y)], fill=tuple(int(NAVY[i] + (BLUE[i] - NAVY[i]) * t * 0.55) for i in range(3)))
    logo = mark(320)
    image.paste(logo, (110, 160), logo)

    def font(size, bold=False):
        for name in ('segoeuib.ttf' if bold else 'segoeui.ttf', 'arialbd.ttf' if bold else 'arial.ttf', 'DejaVuSans-Bold.ttf' if bold else 'DejaVuSans.ttf'):
            try:
                return ImageFont.truetype(name, size)
            except OSError:
                continue
        return ImageFont.load_default()

    draw.text((490, 190), 'tsc-laws', font=font(118, True), fill=CREAM)
    draw.text((494, 340), 'Laws for TypeScript.', font=font(48), fill=CREAM)
    draw.text((494, 405), 'Proved where it can be, tested where it cannot.', font=font(34), fill=(200, 205, 230))
    draw.rectangle([494, 480, 494 + 120, 488], fill=YELLOW)
    return image


SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="tsc-laws">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3178c6"/>
      <stop offset="1" stop-color="#1e5aaa"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="225" fill="url(#g)"/>
  <text x="512" y="520" text-anchor="middle" font-family="Consolas, 'Cascadia Code', 'DejaVu Sans Mono', monospace" font-weight="700" font-size="410" fill="#ffffff">law</text>
  <circle cx="778" cy="778" r="154" fill="#f2c230"/>
  <path d="M690 780 L735 826 L825 733" fill="none" stroke="#141a3a" stroke-width="52" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
"""

if __name__ == '__main__':
    brand = ROOT / 'docs' / 'media' / 'brand'
    brand.mkdir(parents=True, exist_ok=True)
    mark(256).save(ROOT / 'packages' / 'vscode-tslaws' / 'icon.png', optimize=True)
    mark(128).save(brand / 'logo-128.png', optimize=True)
    mark(512).save(brand / 'logo-512.png', optimize=True)
    mark(1024).save(brand / 'logo-1024.png', optimize=True)
    social().save(brand / 'social-1280x640.png', optimize=True)
    (brand / 'logo.svg').write_text(SVG, encoding='utf-8', newline='\n')
    print('icons written')
