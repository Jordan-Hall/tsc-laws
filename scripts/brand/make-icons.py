"""Draws the tsc-laws mark and writes every icon size the stores and the repository need.

The mark is a universal quantifier (an upside-down A) on a navy rounded square, with a yellow dot at its apex: a law holds
for every input. Everything is drawn with supersampling, so the edges are clean at any size.

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
SS = 4  # supersampling


def mark(size):
    """The square mark at `size` pixels."""
    s = size * SS
    image = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    radius = int(s * 0.22)
    # A vertical gradient from navy to blue, clipped to the rounded square.
    gradient = Image.new('RGBA', (s, s))
    gd = ImageDraw.Draw(gradient)
    for y in range(s):
        t = y / (s - 1)
        gd.line([(0, y), (s, y)], fill=tuple(int(NAVY[i] + (BLUE[i] - NAVY[i]) * t * 0.9) for i in range(3)) + (255,))
    mask = Image.new('L', (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=255)
    image.paste(gradient, (0, 0), mask)

    # The quantifier: two cream legs meeting at the bottom and a yellow crossbar, with round caps.
    stroke = int(s * 0.092)
    apex = (s * 0.5, s * 0.8)
    left = (s * 0.23, s * 0.2)
    right = (s * 0.77, s * 0.2)
    draw.line([left, apex], fill=CREAM, width=stroke, joint='curve')
    draw.line([right, apex], fill=CREAM, width=stroke, joint='curve')
    for x, y in (left, right, apex):
        draw.ellipse([x - stroke / 2, y - stroke / 2, x + stroke / 2, y + stroke / 2], fill=CREAM)
    bar_y = s * 0.42
    t = (bar_y - left[1]) / (apex[1] - left[1])
    bl = (left[0] + (apex[0] - left[0]) * t, bar_y)
    br = (right[0] + (apex[0] - right[0]) * t, bar_y)
    draw.line([bl, br], fill=YELLOW, width=int(stroke * 0.7))
    return image.resize((size, size), Image.LANCZOS)


def social():
    """1280x640 repository preview: the mark, the name and the one-line promise."""
    w, h = 1280, 640
    image = Image.new('RGB', (w, h), NAVY)
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
      <stop offset="0" stop-color="#141a3a"/>
      <stop offset="1" stop-color="#2c3ea3" stop-opacity="0.9"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="1024" rx="225" fill="url(#g)"/>
  <g stroke-linecap="round" stroke-linejoin="round" fill="none">
    <path d="M236 205 L512 819 L788 205" stroke="#efe7d3" stroke-width="94"/>
    <path d="M395 430 H629" stroke="#f2c230" stroke-width="66"/>
  </g>
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
