"""Renders the social card (1200x630) and the web app icons.

Text is outlined from the brand TTFs (like gen.py), so the output does not
depend on installed fonts. Needs cairosvg + fonttools and the TTFs:
Geist (SemiBold), Geist Mono (Regular), Instrument Serif (Regular, Italic).

    python3 og.py <ttf_dir> <out_dir>
writes og.png, apple-touch-icon.png (180), icon-192.png, icon-512.png.
"""
import os, sys, cairosvg
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

TTF, OUT = sys.argv[1], sys.argv[2]
C = dict(ink="#0E0F11", basalt="#17191D", slate="#2A2E35", ash="#8C929C",
         chalk="#BDB7AC", bone="#ECE6DA", amber="#F4B728")
_fonts = {}

def font(name):
    if name not in _fonts:
        f = TTFont(os.path.join(TTF, name))
        _fonts[name] = (f.getGlyphSet(), f.getBestCmap(), f["head"].unitsPerEm)
    return _fonts[name]

def text(s, name, x, y, size, color, track=0.0):
    """Outlined text with its baseline at y. Returns (svg, advance)."""
    gs, cmap, upm = font(name)
    sc = size / upm
    cx = 0.0
    out = []
    for ch in s:
        g = gs[cmap[ord(ch)]]
        p = SVGPathPen(gs)
        g.draw(TransformPen(p, (sc, 0, 0, -sc, x + cx, y)))
        out.append(p.getCommands())
        cx += g.width * sc + track * size
    return f'<path d="{" ".join(out)}" fill="{color}"/>', cx

def mark(x0, y0, s, beam=C["amber"], post=C["bone"]):
    r = lambda x, y, w, h, c: f'<rect x="{x0 + x * s:.2f}" y="{y0 + y * s:.2f}" width="{w * s:.2f}" height="{h * s:.2f}" fill="{c}"/>'
    return r(8, 14, 80, 17, beam) + r(17, 37, 21, 49, post) + r(58, 37, 21, 49, post)

def svg(w, h, body):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">{body}</svg>'

def og():
    W, H, M = 1200, 630, 72
    b = [f'<rect width="{W}" height="{H}" fill="{C["ink"]}"/>']
    # hairline frame + baseline rule, architectural and quiet
    b.append(f'<rect x="32.5" y="32.5" width="{W - 65}" height="{H - 65}" fill="none" stroke="{C["slate"]}" stroke-width="1"/>')
    # official lockup (logo/lintel-lockup-dark.svg, 339x110), scaled to 52 px tall
    lk = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "logo", "lintel-lockup-dark.svg")).read()
    inner = lk[lk.index(">") + 1: lk.rindex("</svg>")]
    k = 52 / 110
    b.append(f'<g transform="translate({M - 8 * k:.2f},{64}) scale({k:.4f})">{inner}</g>')
    # headline
    s1, _ = text("Pay to unlock.", "InstrumentSerif-Regular.ttf", M, 330, 112, C["bone"])
    s2, w2 = text("Proven", "InstrumentSerif-Italic.ttf", M, 440, 112, C["amber"])
    s3, _ = text(" before you pay.", "InstrumentSerif-Regular.ttf", M + w2, 440, 112, C["bone"])
    b += [s1, s2, s3]
    # footer rule + mono label
    b.append(f'<rect x="{M}" y="{H - 132}" width="{W - 2 * M}" height="1" fill="{C["slate"]}"/>')
    lab, _ = text("ZCASH TESTNET \u00b7 HALO 2 PROOFS \u00b7 ADAPTOR SIGNATURES", "GeistMono-Regular.ttf", M, H - 92, 17, C["ash"], track=0.12)
    b.append(lab)
    sub, sw = text("Sealed until settled.", "Geist-SemiBold.ttf", 0, 0, 20, C["chalk"])
    sub, _ = text("Sealed until settled.", "Geist-SemiBold.ttf", W - M - sw, H - 92, 20, C["chalk"])
    b.append(sub)
    return svg(W, H, "".join(b))

def icon(sz, rad):
    s = sz / 96 * 0.72
    off = (sz - 96 * s) / 2
    return svg(sz, sz, f'<rect width="{sz}" height="{sz}" rx="{rad}" fill="{C["ink"]}"/>' + mark(off, off, s))

def icon_square(sz):
    # iOS masks its own corners: full-bleed square
    s = sz / 96 * 0.72
    off = (sz - 96 * s) / 2
    return svg(sz, sz, f'<rect width="{sz}" height="{sz}" fill="{C["ink"]}"/>' + mark(off, off, s))

os.makedirs(OUT, exist_ok=True)
cairosvg.svg2png(bytestring=og().encode(), write_to=os.path.join(OUT, "og.png"), output_width=1200)
cairosvg.svg2png(bytestring=icon_square(180).encode(), write_to=os.path.join(OUT, "apple-touch-icon.png"), output_width=180)
cairosvg.svg2png(bytestring=icon(192, 42).encode(), write_to=os.path.join(OUT, "icon-192.png"), output_width=192)
cairosvg.svg2png(bytestring=icon(512, 112).encode(), write_to=os.path.join(OUT, "icon-512.png"), output_width=512)
print("ok")
