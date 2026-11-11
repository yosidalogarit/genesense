"""Drawing for the 240x320 touch screen in the GeneSense app's look (light theme, Be Vietnam Pro).

Same design language as the web app: the soft blue glow behind every screen, white cards with a faint
gradient and shadow, a pale blue header, 12-16 px rounded corners, blue main buttons with a soft glow.
Everything is drawn at twice the size and scaled down, which smooths edges. Cards, buttons and the
background are made once and reused, so a frame stays cheap. Only Pillow 5.4 features are used (Debian 10).
"""
import math
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 240, 320
S = 2                                        # drawing scale
HERE = os.path.dirname(os.path.abspath(__file__))
FONT_FILES = {"medium": "BeVietnamPro-Medium.ttf", "semibold": "BeVietnamPro-SemiBold.ttf", "bold": "BeVietnamPro-Bold.ttf"}


def hexc(h):
    return (int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16))


# the GeneSense app's colours (frontend/assets/styles.css)
BG, SURF, LINE, LINE2 = hexc("#f5f9ff"), hexc("#ffffff"), hexc("#dbe5f1"), hexc("#b7c7dc")
SURF2 = hexc("#f6faff")                      # bottom of a card's gradient
GLOW, GLOW2 = hexc("#d9f3fb"), hexc("#e6efff")
HEAD_A, HEAD_B, HEAD_LINE = hexc("#edf6ff"), hexc("#e2f4fa"), hexc("#dce8f4")
INK, INK2, NAVY, LOGO, PULSE = hexc("#10264b"), hexc("#52627a"), hexc("#0d2c69"), hexc("#0d2c54"), hexc("#9cc3ef")
BLUE, BLUE_TOP, BLUE_SOFT, BLUE_LINE, CHART = (hexc("#0756ce"), hexc("#2a74ea"), hexc("#eaf3ff"), hexc("#cfe0f5"),
                                              hexc("#0b57a4"))
GREEN, GREEN_BG = hexc("#17663a"), hexc("#e5f2ea")
AMBER, AMBER_BG, AMBER_LINE = hexc("#7a4d00"), hexc("#fcf1d6"), hexc("#efd083")
RED, RED_BG, RED_SOLID = hexc("#a8201a"), hexc("#fbe9e8"), hexc("#b3261e")
ZONE = {"safe": hexc("#b5d9c2"), "attention": hexc("#efd083"), "alert": hexc("#eaa9a4")}
SKIN, NAIL = (240, 190, 150), (250, 220, 205)
BLACK, WHITE = (0, 0, 0), (255, 255, 255)

SAFE, ATTN, ALERT = "safe", "attention", "alert"
LEVEL_COLOR = {SAFE: GREEN, ATTN: AMBER, ALERT: RED}
LEVEL_BG = {SAFE: GREEN_BG, ATTN: AMBER_BG, ALERT: RED_BG}

# layout: header 0-40, content, two big buttons, the "test device" strip
TOP_H = 40
STRIP_H = 20
BTN_H = 46                                   # about 8 mm on the M10's screen: easy to hit
BTN_GAP = 12
BTN_Y = H - STRIP_H - 10 - BTN_H             # 244
CONTENT_Y = TOP_H + 8                        # 48
CONTENT_END = BTN_Y - 8                      # 236

_fonts = {}


def font(weight, size):
    key = (weight, size)
    if key not in _fonts:
        _fonts[key] = ImageFont.truetype(os.path.join(HERE, "fonts", FONT_FILES[weight]), size * S)
    return _fonts[key]


SMALL, BODY, BOLD, TITLE, BIG, NUM, HUGE = (("medium", 15), ("medium", 17), ("semibold", 17), ("semibold", 20),
                                            ("bold", 27), ("bold", 44), ("bold", 56))


def vn(v, digits=1):                         # Vietnamese decimal comma: 31,2
    return (("%." + str(digits) + "f") % v).replace(".", ",")


def ease(t):                                 # ease-out, like the app's --ease-out
    t = min(1.0, max(0.0, t))
    return 1 - (1 - t) ** 3


def mix(a, b, t):
    return tuple(int(round(x + (y - x) * t)) for x, y in zip(a, b))


_DOWN = getattr(Image, "BOX", Image.LANCZOS)   # exact 2x down: BOX is fast and sharp

# ---------- things made once ----------
_cache = {}


def _background():
    """The app's background: pale blue, with the soft cyan glow at the top right (body::before in the CSS)."""
    if "bg" not in _cache:
        sw, sh = 48, 64
        small = Image.new("RGB", (sw, sh))
        px = small.load()
        for y in range(sh):
            for x in range(sw):
                u, v = (x + 0.5) / sw, (y + 0.5) / sh
                d = math.hypot((u - 0.8) / 0.95, (v - 0.08) / 0.62)
                f = max(0.0, 1 - d / 0.95) ** 1.3
                d2 = math.hypot((u - 0.05) / 0.9, (v - 1.0) / 0.5)
                g = max(0.0, 1 - d2) ** 1.6 * 0.6
                px[x, y] = mix(mix(BG, GLOW2, g), GLOW, f)
        _cache["bg"] = small.resize((W * S, H * S), Image.BICUBIC)
    return _cache["bg"]


def _gradient(w, h, c0, c1, horizontal=False):
    key = ("grad", w, h, c0, c1, horizontal)
    if key not in _cache:
        n = w if horizontal else h
        strip = Image.new("RGB", (n, 1) if horizontal else (1, n))
        strip.putdata([mix(c0, c1, i / float(max(1, n - 1))) for i in range(n)])
        _cache[key] = strip.resize((w, h), Image.NEAREST)
    return _cache[key]


def _rr_mask(w, h, r):
    m = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(m)
    r = max(0, min(r, (w - 1) // 2, (h - 1) // 2))
    if r == 0:
        d.rectangle([0, 0, w - 1, h - 1], fill=255)
        return m
    d.rectangle([r, 0, w - 1 - r, h - 1], fill=255)
    d.rectangle([0, r, w - 1, h - 1 - r], fill=255)
    for cx, cy in ((0, 0), (w - 1 - 2 * r, 0), (0, h - 1 - 2 * r), (w - 1 - 2 * r, h - 1 - 2 * r)):
        d.ellipse([cx, cy, cx + 2 * r, cy + 2 * r], fill=255)
    return m


def _sprite(w, h, r, top, bottom, border, bw, shadow):
    """A rounded box with a vertical gradient, a border and a soft shadow, as RGBA at drawing scale.
    shadow = (colour, opacity 0-1, blur px, drop px) or None. Returns (image, margin)."""
    key = ("sprite", w, h, r, top, bottom, border, bw, shadow)
    if key in _cache:
        return _cache[key]
    w2, h2, r2 = int(w * S), int(h * S), int(r * S)
    pad = int((shadow[2] * 2 + shadow[3]) * S) if shadow else 0
    img = Image.new("RGBA", (w2 + 2 * pad, h2 + 2 * pad), (0, 0, 0, 0))
    if shadow:
        colour, alpha, blur, drop = shadow
        m = Image.new("L", img.size, 0)
        m.paste(_rr_mask(w2, h2, r2), (pad, pad + int(drop * S)))
        m = m.filter(ImageFilter.GaussianBlur(blur * S)).point(lambda v: int(v * alpha))
        img.paste(colour + (255,), (0, 0), m)
    b2 = int(bw * S) if (border and bw) else 0
    if b2:
        img.paste(border + (255,), (pad, pad), _rr_mask(w2, h2, r2))
    inner = _rr_mask(w2 - 2 * b2, h2 - 2 * b2, max(0, r2 - b2))
    img.paste(_gradient(w2 - 2 * b2, h2 - 2 * b2, top, bottom), (pad + b2, pad + b2), inner)
    _cache[key] = (img, pad)
    return img, pad


SHADOW_CARD = ((22, 52, 94), 0.10, 6, 3)     # .panel: 0 9px 24px #16345e0d, a little stronger on a small screen
SHADOW_SOFT = ((22, 52, 94), 0.07, 3, 1)
SHADOW_BLUE = ((20, 104, 232), 0.30, 5, 3)   # .btn.primary: 0 5px 12px #1468e825


def _trim_cache():
    """Changing texts (countdown, clock) would grow the cache without end: start over past a limit."""
    if len(_cache) > 1500:
        keep = {k: v for k, v in _cache.items() if k == "bg" or k[0] == "grad"}
        _cache.clear()
        _cache.update(keep)


class Canvas:
    """One frame. Coordinates are in screen pixels; `hits` collects the touch areas drawn on it."""

    def __init__(self, bg=None):
        _trim_cache()
        self.img = Image.new("RGB", (W * S, H * S), bg) if bg else _background().copy()
        self.d = ImageDraw.Draw(self.img)
        self.hits = []                       # (x0, y0, x1, y1, action)

    def frame(self):
        return self.img.resize((W, H), _DOWN)

    def tap(self, x, y, w, h, action):
        self.hits.append((x, y, x + w, y + h, action))

    # ---------- shapes ----------
    def rect(self, x, y, w, h, fill):
        self.d.rectangle([x * S, y * S, (x + w) * S - 1, (y + h) * S - 1], fill=fill)

    def rr(self, x, y, w, h, r, fill):        # a plain rounded rectangle (works on old Pillow)
        x0, y0, x1, y1 = int(x * S), int(y * S), int((x + w) * S) - 1, int((y + h) * S) - 1
        r = int(min(r * S, (x1 - x0) // 2, (y1 - y0) // 2))
        d = self.d
        if r <= 0:
            d.rectangle([x0, y0, x1, y1], fill=fill)
            return
        d.rectangle([x0 + r, y0, x1 - r, y1], fill=fill)
        d.rectangle([x0, y0 + r, x1, y1 - r], fill=fill)
        for cx, cy in ((x0, y0), (x1 - 2 * r, y0), (x0, y1 - 2 * r), (x1 - 2 * r, y1 - 2 * r)):
            d.ellipse([cx, cy, cx + 2 * r, cy + 2 * r], fill=fill)

    def box(self, x, y, w, h, r, top=SURF, bottom=None, border=LINE, bw=1, shadow=SHADOW_CARD):
        img, pad = _sprite(int(round(w)), int(round(h)), r, top, bottom or top, border, bw, shadow)
        self.img.paste(img, (int(round(x * S)) - pad, int(round(y * S)) - pad), img)

    def card(self, x, y, w, h, r=16, fill=SURF, border=LINE, bw=1, shadow=True):
        bottom = SURF2 if fill == SURF else fill
        self.box(x, y, w, h, r, fill, bottom, border, bw, SHADOW_CARD if shadow else None)

    def disc(self, cx, cy, r, fill):
        self.d.ellipse([(cx - r) * S, (cy - r) * S, (cx + r) * S, (cy + r) * S], fill=fill)

    def line(self, x0, y0, x1, y1, width, fill):   # with round ends
        self.d.line([x0 * S, y0 * S, x1 * S, y1 * S], fill=fill, width=int(width * S))
        for x, y in ((x0, y0), (x1, y1)):
            self.disc(x, y, width / 2.0, fill)

    def poly(self, pts, fill):
        self.d.polygon([(x * S, y * S) for x, y in pts], fill=fill)

    def arc(self, cx, cy, r, start, end, width, fill):
        self.d.arc([(cx - r) * S, (cy - r) * S, (cx + r) * S, (cy + r) * S], start, end, fill=fill, width=int(width * S))

    def ring(self, cx, cy, r0, r1, frac, fill):     # from 12 o'clock, clockwise, round ends
        if frac <= 0:
            return
        box = [(cx - r1) * S, (cy - r1) * S, (cx + r1) * S, (cy + r1) * S]
        width = int((r1 - r0) * S)
        if frac >= 1:
            self.d.ellipse(box, outline=fill, width=width)
            return
        self.d.arc(box, -90, -90 + 360 * frac, fill=fill, width=width)
        rm, rc = (r0 + r1) / 2.0, (r1 - r0) / 2.0
        end = frac * 2 * math.pi
        self.disc(cx, cy - rm, rc, fill)
        self.disc(cx + rm * math.sin(end), cy - rm * math.cos(end), rc, fill)

    # ---------- text ----------
    def text_w(self, s, f):
        key = ("w", s, f)
        if key in _cache:
            return _cache[key]
        _cache[key] = w = self._measure(s, f)
        return w

    def _measure(self, s, f):
        fo = font(*f)
        if hasattr(fo, "getlength"):
            return fo.getlength(s) / S
        return fo.getsize(s)[0] / float(S)

    def text(self, x, base, s, color, f):  # x = left edge, base = baseline
        """Each text is rendered once as a mask and reused: rendering is most of a frame's cost on the M10."""
        key = ("text", s, f)
        got = _cache.get(key)
        if got is None:
            fo = font(*f)
            asc, desc = fo.getmetrics()
            mask = Image.new("L", (int(math.ceil(self.text_w(s, f) * S)) + 8, asc + desc + 8), 0)
            ImageDraw.Draw(mask).text((4, 4), s, font=fo, fill=255)
            got = _cache[key] = (mask, asc)
        mask, asc = got
        self.img.paste(color, (int(round(x * S)) - 4, int(round(base * S)) - asc - 4), mask)
        return x + self.text_w(s, f)

    def text_c(self, cx, base, s, color, f):
        self.text(cx - self.text_w(s, f) / 2.0, base, s, color, f)

    def text_r(self, right, base, s, color, f):
        self.text(right - self.text_w(s, f), base, s, color, f)

    def fit(self, s, f, max_w):              # cut a long text short with "…"
        while len(s) > 2 and self.text_w(s, f) > max_w:
            s = s[:-2].rstrip() + "…"
        return s

    def split(self, s, f, max_w, max_lines=5):
        lines, line = [], ""
        for word in s.split():
            test = (line + " " + word).strip()
            if line and self.text_w(test, f) > max_w:
                lines.append(line)
                line = word
            else:
                line = test
        if line:
            lines.append(line)
        return lines[:max_lines]

    def wrap_c(self, base, s, color, f, max_w=W - 32):
        for ln in self.split(s, f, max_w):
            self.text_c(W / 2.0, base, ln, color, f)
            base += int(f[1] * 1.35)
        return base

    # ---------- pieces ----------
    def logo(self, x, y, s):
        k = s / 64.0
        self.rr(x, y, s, s, 14 * k, LOGO)
        self.line(x + 32 * k, y + 14 * k, x + 32 * k, y + 50 * k, 9 * k, SURF)
        self.line(x + 14 * k, y + 32 * k, x + 50 * k, y + 32 * k, 9 * k, SURF)
        pts = [(20, 38), (27, 38), (31, 26), (36, 43), (40, 34), (47, 34)]
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            self.line(x + ax * k, y + ay * k, x + bx * k, y + by * k, max(1.4, 3 * k), PULSE)

    def mark(self, x, y, level, s=14, color=None):   # circle = safe, triangle = attention, octagon = danger
        c = color or LEVEL_COLOR[level]
        if level == SAFE:
            self.disc(x + s / 2.0, y + s / 2.0, s / 2.0, c)
        elif level == ATTN:
            self.poly([(x + s / 2.0, y), (x + s, y + s), (x, y + s)], c)
        else:
            a, b = s * 0.3, s * 0.7
            self.poly([(x + a, y), (x + b, y), (x + s, y + a), (x + s, y + b), (x + b, y + s), (x + a, y + s), (x, y + b), (x, y + a)], c)

    def status_icon(self, cx, cy, level):
        if level == SAFE:
            self.disc(cx, cy, 22, GREEN)
            self.line(cx - 10, cy + 1, cx - 3, cy + 8, 4, SURF)
            self.line(cx - 3, cy + 8, cx + 10, cy - 7, 4, SURF)
            return
        if level == ATTN:
            self.poly([(cx, cy - 22), (cx + 24, cy + 19), (cx - 24, cy + 19)], AMBER)
        else:
            self.mark(cx - 22, cy - 22, ALERT, 44)
        top, bottom, dot = (-7, 5, 12) if level == ATTN else (-11, 3, 11)
        self.line(cx, cy + top, cx, cy + bottom, 4.5, SURF)
        self.disc(cx, cy + dot, 2.6, SURF)

    def heart(self, x, y, s, color):
        self.disc(x - s / 2.0, y - s / 6.0, s / 2.0 + 0.5, color)
        self.disc(x + s / 2.0, y - s / 6.0, s / 2.0 + 0.5, color)
        self.poly([(x - s - 0.3, y + s / 10.0), (x + s + 0.3, y + s / 10.0), (x, y + s)], color)

    def icon(self, name, cx, cy, color, s=1.0):
        """Simple line icons in the app's style (2 px strokes, round ends), about 20 px wide."""
        t = 2.0 * s
        ln = self.line
        if name == "chart":
            pts = [(-9, 4), (-4, -2), (0, 2), (5, -6), (9, -3)]
            for (ax, ay), (bx, by) in zip(pts, pts[1:]):
                ln(cx + ax * s, cy + ay * s, cx + bx * s, cy + by * s, t, color)
            ln(cx - 10 * s, cy + 8 * s, cx + 10 * s, cy + 8 * s, t, color)
        elif name == "clock":
            self.arc(cx, cy, 9 * s, 0, 360, t, color)
            ln(cx, cy, cx, cy - 5 * s, t, color)
            ln(cx, cy, cx + 4 * s, cy + 2 * s, t, color)
        elif name == "speaker":
            self.poly([(cx - 9 * s, cy - 3 * s), (cx - 5 * s, cy - 3 * s), (cx, cy - 8 * s), (cx, cy + 8 * s),
                       (cx - 5 * s, cy + 3 * s), (cx - 9 * s, cy + 3 * s)], color)
            self.arc(cx + 1 * s, cy, 5 * s, -50, 50, t, color)
            self.arc(cx + 1 * s, cy, 9.5 * s, -50, 50, t, color)
        elif name == "info":
            self.arc(cx, cy, 9 * s, 0, 360, t, color)
            ln(cx, cy - 1 * s, cx, cy + 4.5 * s, t, color)
            self.disc(cx, cy - 4.5 * s, 1.3 * s, color)
        elif name == "logout":
            ln(cx - 2 * s, cy - 8 * s, cx - 8 * s, cy - 8 * s, t, color)
            ln(cx - 8 * s, cy - 8 * s, cx - 8 * s, cy + 8 * s, t, color)
            ln(cx - 8 * s, cy + 8 * s, cx - 2 * s, cy + 8 * s, t, color)
            ln(cx - 3 * s, cy, cx + 9 * s, cy, t, color)
            ln(cx + 9 * s, cy, cx + 5 * s, cy - 4 * s, t, color)
            ln(cx + 9 * s, cy, cx + 5 * s, cy + 4 * s, t, color)
        elif name == "trash":
            ln(cx - 9 * s, cy - 5 * s, cx + 9 * s, cy - 5 * s, t, color)
            ln(cx - 3 * s, cy - 8 * s, cx + 3 * s, cy - 8 * s, t, color)
            ln(cx - 6 * s, cy - 5 * s, cx - 5 * s, cy + 8 * s, t, color)
            ln(cx - 5 * s, cy + 8 * s, cx + 5 * s, cy + 8 * s, t, color)
            ln(cx + 5 * s, cy + 8 * s, cx + 6 * s, cy - 5 * s, t, color)
        elif name == "back":
            ln(cx + 3 * s, cy - 7 * s, cx - 4 * s, cy, 2.4 * s, color)
            ln(cx - 4 * s, cy, cx + 3 * s, cy + 7 * s, 2.4 * s, color)
        elif name == "next":
            ln(cx - 3 * s, cy - 6 * s, cx + 3 * s, cy, 2 * s, color)
            ln(cx + 3 * s, cy, cx - 3 * s, cy + 6 * s, 2 * s, color)

    def wifi_icon(self, cx, cy, color):
        for r in (4.5, 9):
            self.arc(cx, cy, r, -135, -45, 1.8, color)
        self.disc(cx, cy, 1.6, color)

    def chip(self, right, on):               # the Wi-Fi chip in the header
        x, y = right - 26, 8
        if on:
            self.box(x, y, 26, 24, 8, BLUE_TOP, BLUE, None, 0, SHADOW_SOFT)
        else:
            self.box(x, y, 26, 24, 8, SURF, SURF2, LINE2, 1, None)
        c = SURF if on else INK2
        self.wifi_icon(x + 13, y + 18, c)
        if not on:
            self.line(x + 6, y + 19, x + 20, y + 5, 1.6, INK2)
        return x - 4

    def top_bar(self, clock, wifi_on, title=None, back=None):
        """The app's pale blue header. With a title it shows a back arrow (touch the left part to go back)."""
        self.img.paste(_gradient(W * S, TOP_H * S, HEAD_A, HEAD_B, True), (0, 0))
        self.rect(0, TOP_H, W, 1, HEAD_LINE)
        x = self.chip(W - 8, wifi_on)
        if clock:
            self.text_r(x - 2, 26, clock, INK2, SMALL)
            x -= 2 + self.text_w(clock, SMALL)
        if title:
            self.box(8, 6, 30, 28, 10, SURF, SURF2, BLUE_LINE, 1, None)
            self.icon("back", 23, 20, BLUE)
            self.text(46, 27, self.fit(title, BOLD, x - 54), INK, BOLD)
            if back:
                self.tap(0, 0, 130, TOP_H + 6, back)
        else:
            self.logo(8, 8, 24)
            self.text(40, 27, "GeneSense", NAVY, BOLD)

    def strip(self, mock):
        self.img.paste(_gradient(W * S, STRIP_H * S, hexc("#fdf5e1"), AMBER_BG), (0, (H - STRIP_H) * S))
        self.rect(0, H - STRIP_H, W, 1, AMBER_LINE)
        self.text_c(W / 2.0, H - 6, "THỬ NGHIỆM · SỐ LIỆU GIẢ LẬP" if mock else "THIẾT BỊ THỬ NGHIỆM", AMBER, ("semibold", 13))

    def button(self, slot, label, action, style="plain", key=None):
        """A big touch button at the bottom: slot "L", "R" or "C" (whole width). `key` = the board button that
        does the same (A on the left, B on the right)."""
        if not label:
            return
        if slot is True:
            slot = "L"
        elif slot is False:
            slot = "R"
        half = (W - 20 - BTN_GAP) // 2
        x, w = {"L": (10, half), "R": (W - 10 - half, half), "C": (10, W - 20)}[slot]
        y = BTN_Y
        if style == "main":
            self.box(x, y, w, BTN_H, 14, BLUE_TOP, BLUE, None, 0, SHADOW_BLUE)
            fg, badge, letter = SURF, SURF, BLUE
        elif style == "onred":
            self.box(x, y, w, BTN_H, 14, SURF, hexc("#fff4f3"), None, 0, ((60, 0, 0), 0.25, 4, 2))
            fg, badge, letter = RED_SOLID, RED_BG, RED_SOLID
        else:
            self.box(x, y, w, BTN_H, 14, SURF, SURF2, LINE2, 1, SHADOW_SOFT)
            fg, badge, letter = BLUE, BLUE_SOFT, BLUE
        key = key or ("B" if slot == "R" else "A")
        cy = y + BTN_H / 2.0
        self.disc(x + 18, cy, 10, badge)
        self.text_c(x + 18, cy + 5, key, letter, ("bold", 13))
        room = w - 38
        f = BOLD if self.text_w(label, BOLD) <= room else SMALL
        self.text_c(x + 31 + room / 2.0, cy + 6, self.fit(label, f, room), fg, f)
        self.tap(x - 4, y - 4, w + 8, BTN_H + 8, (key, action))

    def row(self, y, h, label, value, last, warn=False, x=10, w=W - 20):
        self.text(x + 14, y + h / 2.0 + 5, label, INK2, SMALL)
        room = w - 28 - self.text_w(label, SMALL) - 10 - (18 if warn else 0)
        f = BOLD if self.text_w(value, BOLD) <= room else SMALL
        value = self.fit(value, f, room)
        self.text_r(x + w - 14, y + h / 2.0 + 6, value, AMBER if warn else INK, f)
        if warn:
            self.mark(x + w - 14 - self.text_w(value, f) - 18, y + h / 2.0 - 6, ATTN, 12)
        if not last:
            self.rect(x + 12, y + h, w - 24, 1, LINE)

    def tile(self, x, y, w, h, icon, label, color, selected, action):
        """A menu tile: an icon in a soft square and its name, like the app's side menu."""
        if selected:
            self.box(x, y, w, h, 16, BLUE_SOFT, hexc("#dcebff"), BLUE, 2, SHADOW_SOFT)
        else:
            self.box(x, y, w, h, 16, SURF, SURF2, LINE, 1, SHADOW_SOFT)
        red = color == RED
        self.box(x + w / 2.0 - 16, y + 6, 32, 27, 9, hexc("#fff4f3") if red else hexc("#f4f8ff"),
                 RED_BG if red else hexc("#e5efff"), hexc("#f3d4d1") if red else hexc("#dceaff"), 1, None)
        self.icon(icon, x + w / 2.0, y + 19.5, color, 0.8)
        self.text_c(x + w / 2.0, y + h - 9, self.fit(label, BOLD, w - 12), RED if red else INK, BOLD)
        self.tap(x, y, w, h, action)

    def stepper(self, x, y, w, h, sign, action):
        self.box(x, y, w, h, 12, SURF, SURF2, BLUE_LINE, 1, SHADOW_SOFT)
        cx, cy = x + w / 2.0, y + h / 2.0
        self.line(cx - 8, cy, cx + 8, cy, 3, BLUE)
        if sign == "+":
            self.line(cx, cy - 8, cx, cy + 8, 3, BLUE)
        self.tap(x - 3, y - 3, w + 6, h + 6, action)

    def toast(self, text, level, top=False, appear=1.0):
        """A short message. `appear` 0..1 slides it in (eased)."""
        f = BOLD
        lines = self.split(text, f, W - 66, 2)
        if len(lines) > 1:
            f = BODY
            lines = self.split(text, f, W - 66, 2)
        h = 58 if len(lines) > 1 else 42
        y = (TOP_H + 6) if top else (BTN_Y - 10 - h)
        y = int(y + (1 - ease(appear)) * (-16 if top else 16))
        border = tuple((a * 165 + b * 90) // 255 for a, b in zip(LEVEL_BG[level], LEVEL_COLOR[level]))
        self.box(10, y, W - 20, h, 14, LEVEL_BG[level], LEVEL_BG[level], border, 1, SHADOW_CARD)
        self.mark(23, y + h / 2.0 - 7, level)
        for i, ln in enumerate(lines):
            self.text(46, y + 27 + i * 20 - (1 if len(lines) > 1 else 0), ln, LEVEL_COLOR[level], f)

    def qr(self, matrix, y, box):            # matrix: list of rows of booleans
        n = len(matrix)
        scale = max(1, box // (n + 4))
        full = (n + 4) * scale
        x0 = (W - full) // 2
        self.card(x0 - 4, y - 4, full + 8, full + 8, 14)
        for r, row in enumerate(matrix):
            for c, on in enumerate(row):
                if on:
                    self.rect(x0 + (c + 2) * scale, y + (r + 2) * scale, scale, scale, BLACK)


def slide(old, new, t, direction):
    """A screen change: the new screen slides in from the side (direction 1 = from the right, -1 = from the
    left, 0 = fade) and fades in over the old one, eased."""
    e = ease(t)
    if not direction:
        return Image.blend(old, new, e)
    shift = int(round((1 - e) * 40)) * direction
    moved = old.copy()
    moved.paste(new, (shift, 0))
    return Image.blend(old, moved, min(1.0, e * 1.2))


def flash(img, rect, strength):
    """Touch feedback: the pressed button darkens for a moment (strength 1 -> 0)."""
    if strength <= 0:
        return img
    x0, y0, x1, y1 = [int(v) for v in rect]
    x0, y0, x1, y1 = max(0, x0 + 4), max(0, y0 + 4), min(W, x1 - 4), min(H, y1 - 4)
    if x1 <= x0 or y1 <= y0:
        return img
    out = img.copy()
    part = out.crop((x0, y0, x1, y1))
    mask = _rr_mask(x1 - x0, y1 - y0, 12).point(lambda v: int(v * 0.18 * strength))
    part.paste((16, 38, 75), (0, 0, x1 - x0, y1 - y0), mask)
    out.paste(part, (x0, y0))
    return out
