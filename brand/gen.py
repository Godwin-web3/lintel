import os, cairosvg
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
C=dict(ink="#0E0F11",basalt="#17191D",slate="#2A2E35",ash="#8C929C",bone="#ECE6DA",amber="#F4B728")
os.makedirs("logo",exist_ok=True); os.makedirs("png",exist_ok=True)

# --- mark on a 96 grid: beam + two posts, 6u gap between beam and posts
def mark(beam,post,x0=0,y0=0,s=1.0):
    r=lambda x,y,w,h,c: f'<rect x="{x0+x*s:.2f}" y="{y0+y*s:.2f}" width="{w*s:.2f}" height="{h*s:.2f}" fill="{c}"/>'
    return (r(8,14,80,17,beam)+r(17,37,21,49,post)+r(58,37,21,49,post))
MW,MH=96,96  # bbox x8..88, y14..86

# --- wordmark: Geist SemiBold "l?ntel" with dotless i + amber tittle bar
F=TTFont("fonts/Geist-SemiBold.ttf"); GS=F.getGlyphSet(); CM=F.getBestCmap()
def word(color,accent,x0,y0,size,track=-0.02):
    sc=size/1000; x=0; parts=[]; tit=None
    for ch in "lintel":
        gn = "dotlessi" if ch=="i" and "dotlessi" in GS else CM[ord(ch)]
        if ch=="i" and gn!="dotlessi": gn=CM[0x131]
        p=SVGPathPen(GS); tp=TransformPen(p,(sc,0,0,-sc,x0+x*sc,y0)); GS[gn].draw(tp)
        parts.append(p.getCommands())
        if ch=="i": tit=(x0+(x+68)*sc, (201-68)*sc)
        x+=GS[gn].width+track*1000+(45 if ch=="l" and not parts[1:] else 0)
    w=x*sc
    d=" ".join(parts)
    # tittle as a short bar echoing the lintel beam, top at cap height
    tx,tw=tit; bar_h=0.10*size; ytop=y0-0.705*size
    s=f'<path d="{d}" fill="{color}"/>'
    s+=f'<rect x="{tx-0.02*size:.2f}" y="{ytop:.2f}" width="{tw+0.04*size:.2f}" height="{bar_h:.2f}" fill="{accent}"/>'
    return s,w

def svg(w,h,body,bg=None):
    b=f'<rect width="{w}" height="{h}" fill="{bg}"/>' if bg else ''
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">{b}{body}</svg>'
def save(name,s,png_w=None):
    open(f"logo/{name}.svg","w").write(s)
    cairosvg.svg2png(bytestring=s.encode(),write_to=f"png/{name}.png",output_width=png_w or 1200)

V={"dark":(C["amber"],C["bone"],C["ink"]),"light":(C["amber"],C["ink"],C["bone"]),"mono-bone":(C["bone"],C["bone"],None),"mono-ink":(C["ink"],C["ink"],None)}
for v,(acc,fg,bg) in V.items():
    # mark alone, cropped to 96
    save(f"lintel-mark-{v}",svg(96,96,mark(acc,fg)),512)
    # horizontal lockup: mark height 72 (scale .9 -> bbox 72 tall), wordmark cap = 0.66*mark
    s=0.9; mh=72*s
    wsize=88; wb,ww=word(fg,acc,0,0,wsize)
    W=int(8*s+80*s+40+ww+8); H=int(110)
    yb=19+ (86-14)*s  # baseline aligned with post feet
    body=mark(acc,fg,x0=-8*s+8,y0=19-14*s,s=s)+word(fg,acc,8+80*s+36,yb,wsize)[0]
    save(f"lintel-lockup-{v}",svg(W,H,body),1600)
    # wordmark only
    wb,ww=word(fg,acc,4,96,128)
    save(f"lintel-wordmark-{v}",svg(int(ww+10),120,wb),1600)
# app icon / favicon: amber beam + bone posts on ink square, rounded
def icon(sz,rad):
    s=sz/96*0.72; off=(sz-96*s)/2
    return svg(sz,sz,f'<rect width="{sz}" height="{sz}" rx="{rad}" fill="{C["ink"]}"/>'+mark(C["amber"],C["bone"],x0=off,y0=off,s=s))
save("lintel-appicon",icon(512,112),512)
save("favicon",icon(64,14),64)
print("ok")
