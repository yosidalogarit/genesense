# Makes gs_fonts.h: Be Vietnam Pro glyphs as 4-bit anti-aliased bitmaps for the K10.
import sys, unicodedata
from PIL import Image, ImageDraw, ImageFont

FD, OUT = sys.argv[1], sys.argv[2]

def vietnamese():
    cs = set()
    for base in "aăâeêioôơuưyAĂÂEÊIOÔƠUƯY":
        cs.add(base)
        for tone in "̣̀́̉̃":
            c = unicodedata.normalize("NFC", base + tone)
            if len(c) == 1: cs.add(c)
    cs.update("đĐ")
    return cs

TEXT = set(chr(c) for c in range(32, 127)) | vietnamese() | set("·–…°")
DIGITS = set("0123456789%:.- ")
FONTS = [  # C name, weight file, pixel size, characters
    ("GS_SMALL", "Medium", 15, TEXT),
    ("GS_BODY", "Medium", 17, TEXT),
    ("GS_BOLD", "SemiBold", 17, TEXT),
    ("GS_TITLE", "SemiBold", 22, TEXT),
    ("GS_BIG", "Bold", 27, TEXT),
    ("GS_NUM", "Bold", 44, DIGITS),
    ("GS_HUGE", "Bold", 56, DIGITS),
]

out = ["// Made by genfonts.py from Be Vietnam Pro (SIL Open Font License 1.1, see OFL.txt).",
       "// 4-bit anti-aliased glyphs, two pixels per byte, rows one after another.",
       "#pragma once", "#include <stdint.h>", "",
       "struct GSGlyph { uint16_t cp; uint8_t w, h; int8_t x, y; uint16_t adv; uint32_t off; };   // adv in 1/16 px; y = top, from the baseline",
       "struct GSFont { const GSGlyph* g; uint16_t n; const uint8_t* bmp; uint8_t ascent, descent, lineH; };", ""]
total = 0
for name, weight, size, chars in FONTS:
    font = ImageFont.truetype(f"{FD}/BeVietnamPro-{weight}.ttf", size)
    glyphs, data = [], bytearray()
    for ch in sorted(chars, key=ord):
        adv = round(font.getlength(ch) * 16)
        box = font.getbbox(ch, anchor="ls")
        x0, y0, x1, y1 = box
        w, h = max(0, x1 - x0), max(0, y1 - y0)
        nib = []
        if w and h:
            im = Image.new("L", (w, h), 0)
            ImageDraw.Draw(im).text((-x0, -y0), ch, font=font, fill=255, anchor="ls")
            px = im.load()
            nib = [(px[x, y] * 15 + 127) // 255 for y in range(h) for x in range(w)]
        if nib and not any(nib): w = h = 0; nib = []
        if len(nib) % 2: nib.append(0)
        off = len(data)
        for i in range(0, len(nib), 2): data.append(nib[i] << 4 | nib[i + 1])
        glyphs.append((ord(ch), w, h, x0, y0, adv, off))
    asc, desc = font.getmetrics()
    lid = name.lower()
    out.append(f"static const uint8_t {lid}_bmp[] = {{")
    for i in range(0, len(data), 24): out.append("  " + ",".join(str(b) for b in data[i:i + 24]) + ",")
    out.append("};")
    out.append(f"static const GSGlyph {lid}_g[] = {{")
    for g in glyphs: out.append("  {%d,%d,%d,%d,%d,%d,%d}," % g)
    out.append("};")
    out.append(f"static const GSFont {name} = {{ {lid}_g, {len(glyphs)}, {lid}_bmp, {asc}, {desc}, {round(size * 1.3)} }};")
    out.append("")
    total += len(data) + len(glyphs) * 12
    print(name, len(glyphs), "glyphs", len(data), "bytes", "asc", asc, "desc", desc)
open(OUT, "w").write("\n".join(out))
print("total", total)
