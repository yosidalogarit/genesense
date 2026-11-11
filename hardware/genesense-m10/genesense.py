#!/usr/bin/env python3
"""GeneSense on the UNIHIKER M10: heart rate and SpO2 with the DFRobot SEN0518, synced to the GeneSense profile.

Run on the M10:  python3 genesense.py   (or pick it in the M10's menu: Run Programs)
Try on a PC:      python3 genesense.py   (no sensor: mock values, clearly labelled; needs tkinter)
Screenshots:      python3 tools/preview.py

Not a medical device. Same limits and words as the GeneSense app: SpO2 < 90 % or heart rate < 40 / > 150 = danger.
"""
import os
import time

# ======================= settings =======================
GEMINI_KEY = ""                              # free Gemini key, only to make the voice clips once. Saved on the device,
                                             # so you can delete it from here after the first run
GENESENSE_URL = os.environ.get("GENESENSE_URL", "https://genesense-five.vercel.app")
DEVICE_NAME = "GeneSense-M10"                # the name shown in the app's device list
MEASURE_SECONDS = 30                         # one measurement with the real sensor (a new value every 4 s)
SETTLE_SECONDS = 8                           # ignore the first readings while the finger settles
MOCK_SECONDS = 15                            # one measurement with mock values
MOVE_LIMIT = 0.15                            # how much moving the M10 restarts the count, in g. Bigger = less strict
VOICE_VOLUME = 0.8                           # 0.1 quiet .. 1.0 loud
TIMEZONE = "Asia/Ho_Chi_Minh"
# ========================================================

os.environ["TZ"] = TIMEZONE
try:
    time.tzset()
except AttributeError:                       # Windows
    pass

import subprocess  # noqa: E402
import threading  # noqa: E402

import ui  # noqa: E402
from ui import W, H, SAFE, ATTN, ALERT  # noqa: E402
from cloud import Cloud  # noqa: E402
from device import Backlight, Board, MockOximeter, Oximeter  # noqa: E402
from store import Config, History, log_csv, sd_folder  # noqa: E402
from voice import CLIPS, Voice, usb_card  # noqa: E402

REMIND_NAMES = ["Buổi sáng", "Buổi trưa", "Buổi tối"]
MENU = [("history", "Lịch sử đo"), ("reminders", "Nhắc đo"), ("brightness", "Độ sáng"), ("info", "Thông tin máy"),
        ("logout", "Đăng xuất"), ("clear", "Xóa lịch sử"), ("idle", "Quay lại")]


def level_hr(n):
    if n < 40 or n > 150:
        return ALERT
    if n < 50 or n > 110:
        return ATTN
    return SAFE


def level_spo2(n):
    if n < 90:
        return ALERT
    if n < 95:
        return ATTN
    return SAFE


def word_hr(level):
    return {ALERT: "Nguy hiểm", ATTN: "Cần chú ý", SAFE: "An toàn"}[level]


def word_spo2(level):
    return {ALERT: "Nguy hiểm", ATTN: "Thấp, cần chú ý", SAFE: "An toàn"}[level]


def median(v):
    s = sorted(v)
    n = len(s)
    return (s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2.0) if n else 0


def keep_near(v, tolerance):                 # only the readings close to the middle one
    m = median(v)
    return [x for x in v if abs(x - m) <= tolerance]


def clock_ok():                              # the M10 has no clock battery: the time is right only after Wi-Fi
    return time.time() > 1700000000


def hhmm(minutes):
    return "%02d:%02d" % (minutes // 60, minutes % 60)


class Network:
    """The Wi-Fi name, checked in the background so the screen never waits for it."""

    def __init__(self):
        self.ssid = ""
        self.ip = ""
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        while True:
            self.ssid = (self._run(["iwgetid", "-r"]) or self._run(["wpa_cli", "-i", "wlan0", "status"], pick="ssid=") or
                         self._run(["nmcli", "-t", "-f", "active,ssid", "dev", "wifi"], pick="yes:"))
            ip = self._run(["hostname", "-I"])
            self.ip = next((a for a in ip.split() if not a.startswith(("10.1.2.", "127."))), "") if ip else ""
            time.sleep(5)

    @staticmethod
    def _run(cmd, pick=None):
        try:
            out = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True,
                                 timeout=4).stdout
        except (OSError, subprocess.SubprocessError):
            return ""
        if pick:
            for line in out.splitlines():
                if line.startswith(pick):
                    return line[len(pick):].strip()
            return ""
        return out.strip()


class App:
    def __init__(self, board, config, history, cloud, voice, net):
        self.board, self.config, self.history, self.cloud, self.voice, self.net = board, config, history, cloud, voice, net
        self.oxi = Oximeter(board)
        self.mock_oxi = MockOximeter()
        self.sensor_ok = self.oxi.start()
        print("SEN0518 found" if self.sensor_ok else "SEN0518 NOT found: using mock values")
        self.screen = "idle"
        self.since = time.monotonic()
        self.toast_text, self.toast_level, self.toast_until = "", SAFE, 0.0
        self.toast_at = 0.0
        self.flash = None                    # (rect, time) of the last pressed button, for the touch feedback
        self.hits = []
        self.hits_screen = ""
        self.dirty = True
        self.menu_sel = 0
        self.clear_confirm_until = 0.0
        # measuring
        self.live_hr = self.live_spo2 = 0
        self.good_streak = self.bad_streak = 0
        self.hr_samples, self.sp_samples = [], []
        self.measure_start = self.hold_until = self.baseline_at = 0.0
        self.baseline = None
        self.restarts = 0
        self.last_poll = self.last_sample = self.last_accel = self.last_scan = self.last_light = 0.0
        self.last_tick_second = -1
        self.wave = []
        # result
        self.result = None                   # the history item of the last measurement
        # reminders: minutes after midnight, -1 = off
        self.reminders = list(self.config.get("reminders", [-1, -1, -1]))[:3]
        self.remind_done = list(self.config.get("remind_done", [-1, -1, -1]))[:3]
        self.remind_label = ""
        self.remind_said = 0
        self.last_remind_voice = 0.0
        self.snooze_until = 0.0
        self.edit_slot = 0
        self.edit_minutes = 7 * 60
        # screen brightness (the menu's "Độ sáng"), kept between runs
        self.backlight = Backlight()
        self.brightness = int(self.config.get("brightness", 0) or (self.backlight.get() or 80))
        if self.config.get("brightness"):
            self.backlight.set(self.brightness)
        self.go("idle" if cloud.signed_in else "pair")
        if cloud.signed_in:
            voice.say("welcome")
        else:
            voice.say("login")

    # ---------- small helpers ----------
    @property
    def mock(self):
        return not self.sensor_ok

    def measure_seconds(self):
        return MEASURE_SECONDS if self.sensor_ok else MOCK_SECONDS

    def go(self, screen):
        self.screen = screen
        self.since = time.monotonic()
        self.cloud.want_pairing = screen == "pair"
        self.dirty = True

    def toast(self, text, level=SAFE, seconds=3.5):
        if text != self.toast_text or time.monotonic() > self.toast_until:
            self.toast_at = time.monotonic()
        self.toast_text, self.toast_level, self.toast_until = text, level, time.monotonic() + seconds
        self.dirty = True

    def calm(self):                          # nothing going on: a reminder may show
        return self.screen in ("idle", "history", "info", "result")

    # ---------- input ----------
    def tap(self, x, y):
        if self.hits_screen != self.screen:  # the screen changed and is not drawn yet: these areas are old
            return
        for x0, y0, x1, y1, action in reversed(self.hits):
            if x0 <= x < x1 and y0 <= y < y1:
                self.flash = ((x0, y0, x1, y1), time.monotonic())
                self.voice.say("tick")
                self.action(action)
                return

    def button(self, which):                 # "A" or "B" on the M10's side
        if self.hits_screen != self.screen:
            return
        if self.screen == "menu":            # B moves through the tiles (and "Về"), A opens
            if which == "B":
                self.action("down")
            else:
                self.action("menu:" + MENU[self.menu_sel][0])
            return
        for x0, y0, x1, y1, action in self.hits:   # the bottom buttons say which board button does the same
            if isinstance(action, tuple) and action[0] == which:
                self.flash = ((x0, y0, x1, y1), time.monotonic())
                self.voice.say("tick")
                self.action(action[1])
                return

    def action(self, name):
        if isinstance(name, tuple):
            name = name[1]
        s = self.screen
        if name == "start":
            self.start_measuring()
        elif name in ("idle", "back"):
            self.go("idle")
        elif name == "menu":
            self.menu_sel = 0
            self.clear_confirm_until = 0
            self.go("menu")
        elif name == "down":
            self.menu_sel = (self.menu_sel + 1) % len(MENU)
            self.clear_confirm_until = 0
            self.dirty = True
        elif name == "cancel":
            self.voice.say("beep", cut=True)
            self.go("idle")
        elif name == "newcode":
            self.cloud.new_code()
            self.toast("Đang lấy mã mới", SAFE, 2)
        elif name == "later" and s == "remind":
            self.snooze_until = time.monotonic() + 10 * 60
            self.go("idle")
        elif name.startswith("menu:"):
            self.menu_open(name[5:])
        elif name.startswith("slot:"):
            self.edit_slot = int(name[5:])
            m = self.reminders[self.edit_slot]
            self.edit_minutes = m if m >= 0 else [7 * 60, 11 * 60 + 30, 19 * 60][self.edit_slot]
            self.go("edit")
        elif name.startswith("light:"):
            self.set_brightness(int(name[6:]) if name[6] not in "+-" else self.brightness + int(name[6:]))
        elif name.startswith("adj:"):
            self.edit_minutes = (self.edit_minutes + int(name[4:])) % (24 * 60)
            self.dirty = True
        elif name in ("save", "off"):
            self.reminders[self.edit_slot] = self.edit_minutes if name == "save" else -1
            self.remind_done[self.edit_slot] = -1
            self.config.set(reminders=self.reminders, remind_done=self.remind_done)
            self.toast(("Nhắc lúc " + hhmm(self.edit_minutes)) if name == "save" else "Đã tắt nhắc", SAFE, 2.5)
            self.go("reminders")

    def menu_open(self, item):
        self.menu_sel = [k for k, _ in MENU].index(item)
        if item == "clear":
            if time.monotonic() > self.clear_confirm_until:
                self.clear_confirm_until = time.monotonic() + 4
                self.toast("Chạm lần nữa để xóa", ATTN, 4)
                return
            self.history.clear()
            self.result = None
            self.toast("Đã xóa lịch sử trên máy", SAFE)
            self.go("idle")
        elif item == "logout":
            if time.monotonic() > self.clear_confirm_until:
                self.clear_confirm_until = time.monotonic() + 4
                self.toast("Chạm lần nữa để đăng xuất", ATTN, 4)
                return
            self.cloud.logout()
            self.go("pair")
        else:
            self.go(item)

    def set_brightness(self, percent):
        self.brightness = min(100, max(10, int(round(percent / 10.0)) * 10))
        if self.backlight.set(self.brightness):
            self.config.set(brightness=self.brightness)
        self.dirty = True

    # ---------- measuring ----------
    def start_measuring(self):
        if not self.sensor_ok and self.board.ok:
            self.sensor_ok = self.oxi.start()    # plugged in just now?
        self.good_streak = self.bad_streak = 0
        self.live_hr = self.live_spo2 = 0
        self.wave = []
        self.go("place")
        self.voice.say("place", cut=True)

    def begin_count(self):
        now = time.monotonic()
        self.hr_samples, self.sp_samples = [], []
        self.measure_start = now
        self.hold_until = 0
        self.baseline_at = now + 0.5
        self.baseline = None
        self.restarts = 0
        self.last_sample = 0
        self.last_tick_second = -1
        self.go("measure")
        self.voice.say("start", cut=True)

    def poll_sensor(self, now):              # once a second
        if now - self.last_poll < 1.0:
            return
        self.last_poll = now
        if self.sensor_ok:
            got = self.oxi.read()
            if got is None and self.oxi.errors == 3:
                print("Sensor stopped answering: check the cable")
                self.dirty = True
        else:
            got = self.mock_oxi.read()
        sp, hr = got if got else (0, 0)
        good = got is not None and 70 <= sp <= 100 and 30 <= hr <= 220
        if good:
            self.good_streak += 1
            self.bad_streak = 0
            self.live_hr, self.live_spo2 = hr, sp
        else:
            self.bad_streak += 1
            self.good_streak = 0
        if self.screen in ("place", "measure"):
            print("Sensor: SpO2 %d, heart rate %d%s" % (sp, hr, "" if good else " (not valid)"))
            self.dirty = True
        counting = self.screen == "measure" and now - self.measure_start > SETTLE_SECONDS and now >= self.hold_until
        if not self.sensor_ok:
            counting = self.screen == "measure" and now >= self.hold_until and now > self.measure_start
        if counting and good and now - self.last_sample >= (4.0 if self.sensor_ok else 1.0):
            self.last_sample = now
            self.hr_samples.append(hr)
            self.sp_samples.append(sp)

    def measure_tick(self, now):
        if self.screen == "place":
            if self.sensor_ok:
                ready = self.good_streak >= 2 and now - self.since > 2.5
                if not ready and now - self.since > 45:
                    self.toast("Chưa đọc được, đeo lại cảm biến", ATTN)
                    self.voice.say("nofinger", cut=True)
                    self.go("idle")
                    return
            else:
                ready = now - self.since > 3 and self.voice.idle()
            if ready:
                self.begin_count()
            return
        if self.screen != "measure":
            return
        if self.sensor_ok and self.bad_streak >= 4:     # finger lifted
            self.go("place")
            self.voice.say("nofinger", cut=True)
            return
        if self.mock:                        # a pretend pulse wave for the mock screen
            t = now * 2 * 3.14159 * (self.live_hr or 72) / 60.0
            import math
            self.wave.append(math.sin(t) + 0.35 * math.sin(2 * t + 0.6))
            del self.wave[:-120]
        # hold still: the M10's motion sensor against the position at the start
        if now - self.last_accel >= 0.2:
            self.last_accel = now
            a = self.board.accel()
            if a is not None:
                if self.baseline is None:
                    if now >= self.baseline_at:
                        self.baseline = a
                elif now >= self.hold_until:
                    moved = max(abs(a[i] - self.baseline[i]) for i in range(3))
                    if moved > MOVE_LIMIT:
                        print("Moved by %.2f g (limit %.2f): restarting" % (moved, MOVE_LIMIT))
                        self.restarts += 1
                        if self.restarts > 5:
                            self.toast("Tay cử động nhiều, thử lại", ATTN)
                            self.voice.say("err", cut=True)
                            self.go("idle")
                            return
                        self.voice.say("hold", cut=True)
                        self.hold_until = now + 2.5
                        self.measure_start = now + 2.5
                        self.baseline_at = now + 2.3
                        self.baseline = None
                        self.hr_samples, self.sp_samples = [], []
                        self.last_tick_second = -1
                        self.dirty = True
                        return
        elapsed = now - self.measure_start
        left = self.measure_seconds() - int(elapsed)
        if elapsed > 0 and 1 <= left <= 3 and left != self.last_tick_second:
            self.last_tick_second = left
            self.voice.say("tick")
        if elapsed >= self.measure_seconds():
            self.finish()

    def finish(self):
        hr, sp = list(self.hr_samples), list(self.sp_samples)
        if len(hr) < 3 or len(sp) < 3:
            self.toast("Chưa đo được, thử lại", ATTN)
            self.voice.say("err", cut=True)
            self.go("idle")
            return
        print("Readings HR: %s  SpO2: %s" % (hr, sp))
        if not self.mock:                    # throw away odd readings; if too many are odd, show no number
            hr_k, sp_k = keep_near(hr, 12), keep_near(sp, 3)
            print("Kept %d/%d heart rate and %d/%d SpO2 readings" % (len(hr_k), len(hr), len(sp_k), len(sp)))
            if len(hr_k) < 3 or len(sp_k) < 3 or len(hr_k) * 3 < len(hr) * 2 or len(sp_k) * 3 < len(sp) * 2:
                self.toast("Số đo chưa ổn định, đo lại", ATTN)
                self.voice.say("unstable", cut=True)
                self.go("idle")
                return
            hr, sp = hr_k, sp_k
        rhr, rsp = int(round(median(hr))), int(round(median(sp)))
        self.result = self.history.add(rhr, rsp, self.mock, clock_ok())
        log_csv(self.result)
        lh, ls = level_hr(rhr), level_spo2(rsp)
        print("Result: %d bpm (%s), SpO2 %d%% (%s)%s" % (rhr, word_hr(lh), rsp, word_spo2(ls), " [mock]" if self.mock else ""))
        if ALERT in (lh, ls):
            self.go("emergency")
            self.voice.say("alarm", cut=True)
            self.voice.say("emergency")
            self.voice.say("emergency")
        else:
            self.go("result")
            self.voice.say("ok", cut=True)
            if ATTN in (lh, ls):
                self.voice.say("check")
            self.voice.say("done")

    def result_state(self):                  # what happened to the last result in the GeneSense profile
        r = self.result
        if not r:
            return ""
        for it in self.history.recent(40):
            if it.get("added") == r.get("added"):
                r = it
                break
        if r["mock"]:
            return "Số giả lập: không gửi lên hồ sơ"
        if r["sent"]:
            return "Đã lưu vào hồ sơ GeneSense"
        if r["local"]:
            return "Chỉ lưu trên máy"
        if self.cloud.sync_problem == 409:
            return "Hoàn thành hồ sơ trên ứng dụng để lưu"
        if not self.net.ssid:
            return "Chờ Wi-Fi để lưu vào hồ sơ"
        return "Đang lưu vào hồ sơ..."

    # ---------- reminders ----------
    def reminder_tick(self, now):
        if self.screen == "remind":
            if now - self.last_remind_voice > 60 and self.remind_said < 3 and self.voice.idle():
                self.last_remind_voice = now
                self.remind_said += 1
                self.voice.say("remind")
            return
        if not clock_ok():
            return
        tm = time.localtime()
        mins = tm.tm_hour * 60 + tm.tm_min
        if self.snooze_until and now >= self.snooze_until and self.calm():
            self.snooze_until = 0
            self.start_reminder(self.remind_label)
            return
        for i, at in enumerate(self.reminders):
            if at < 0 or self.remind_done[i] == tm.tm_yday or mins < at or mins >= at + 30:
                continue
            if not self.calm():
                return                       # measuring or busy: remind when that is finished
            self.remind_done[i] = tm.tm_yday
            self.config.set(remind_done=self.remind_done)
            self.start_reminder(hhmm(at))
            return

    def start_reminder(self, label):
        self.remind_label = label
        self.remind_said = 1
        self.last_remind_voice = time.monotonic()
        self.go("remind")
        self.voice.say("remind", cut=True)

    # ---------- the loop ----------
    def tick(self):
        now = time.monotonic()
        for ev in self.cloud.take_events():
            if ev == "signed_in":
                self.toast("Đã đăng nhập: " + (self.cloud.account_name or "GeneSense"), SAFE, 4)
                self.voice.say("ok")
                self.go("idle")
            elif ev == "revoked":
                self.toast("Máy đã bị ngắt khỏi tài khoản", ATTN, 5)
                self.go("pair")
                self.voice.say("login")
            elif ev == "saved":
                self.dirty = True
        if not self.cloud.signed_in and self.screen not in ("pair", "place", "measure", "result", "emergency"):
            self.go("pair")                  # signing in is required
        if self.screen == "pair" and self.cloud.signed_in:
            self.go("idle")
        if not self.sensor_ok and self.board.ok and self.screen == "idle" and now - self.last_scan > 10:
            self.last_scan = now             # the sensor plugged in later
            if self.oxi.start():
                self.sensor_ok = True
                self.toast("Đã thấy cảm biến", SAFE)
        self.poll_sensor(now)
        self.measure_tick(now)
        self.reminder_tick(now)
        if self.toast_text and now > self.toast_until:
            self.toast_text = ""
            self.dirty = True
        if now - self.last_light > 5:        # quieter voice in a dark room at night
            self.last_light = now
            lt = self.board.light()
            hour = time.localtime().tm_hour
            self.voice.night = 0 <= lt < 300 and (hour >= 21 or hour < 6)
        if self.net.ssid and self.voice.key:
            self.voice.start_making()

    # ---------- drawing ----------
    def draw(self):
        now = time.monotonic()
        red = self.screen == "emergency"
        c = ui.Canvas(ui.RED_SOLID if red else None)
        if not red:
            title = REMIND_NAMES[self.edit_slot] if self.screen == "edit" else TITLES.get(self.screen)
            c.top_bar(time.strftime("%H:%M") if clock_ok() else "", bool(self.net.ssid), title, BACK.get(self.screen))
        getattr(self, "draw_" + self.screen)(c)
        if self.toast_text:
            c.toast(self.toast_text, self.toast_level, top=self.screen in ("emergency", "edit", "menu", "pair"),
                    appear=(now - self.toast_at) / 0.28)
        c.strip(self.mock)
        self.hits = c.hits
        self.hits_screen = self.screen
        self.dirty = False
        return c

    def animating(self, now):                # something on screen moves without new data
        return (self.toast_text and now - self.toast_at < 0.32) or (self.flash and now - self.flash[1] < 0.2)

    def account_text(self):
        return self.cloud.account_name or ("Đã đăng nhập" if self.cloud.signed_in else "Chưa đăng nhập")

    def voice_text(self):
        need, have = len(CLIPS), self.voice.ready_count()
        if have >= need:
            return "Sẵn sàng", False
        if not self.voice.key:
            return "Chưa có khóa Gemini", True
        if self.voice.problem == 401:
            return "Khóa Gemini sai", True
        if self.voice.problem == 429:
            return "Hết lượt, thử lại sau", False
        if self.voice.problem == -1 or not self.net.ssid:
            return "Chờ Wi-Fi", False
        return "Đang tạo %d/%d" % (have, need), False

    def status_rows(self):
        rows = []
        if not self.sensor_ok:
            rows.append(("Cảm biến", "Không thấy", True))
        elif self.oxi.errors >= 3:
            rows.append(("Cảm biến", "Mất kết nối", True))
        else:
            rows.append(("Cảm biến", "Đã nối", False))
        rows.append(("Wi-Fi", self.net.ssid or "Chưa kết nối", False))
        rows.append(("Tài khoản", self.account_text(), False))
        unsent = self.history.unsent_count()
        voice, warn = self.voice_text()
        if self.cloud.sync_problem == 409:
            rows.append(("Hồ sơ", "Cần hoàn thành", True))
        elif unsent:
            rows.append(("Chờ gửi", "%d lần đo" % unsent, False))
        elif self.voice.ready_count() < len(CLIPS) and warn:
            rows.append(("Giọng nói", voice, True))
        elif self.next_reminder():
            rows.append(("Nhắc đo", self.next_reminder(), False))
        return rows

    def draw_idle(self, c):
        import math
        now = time.monotonic()
        # the big card: like the app's status panel (white to pale blue, blue edge and glow)
        c.box(10, 48, W - 20, 88, 18, ui.SURF, ui.hexc("#eef7ff"), ui.hexc("#c9e1ff"), 1, ui.SHADOW_BLUE[:1] + (0.12, 6, 3))
        beat = 0.5 + 0.5 * math.sin(now * 2 * math.pi * 1.1)
        c.box(22, 66, 52, 52, 26, ui.BLUE_TOP, ui.BLUE, None, 0, ui.SHADOW_BLUE)
        c.heart(48, 90, 8.5 + 1.2 * beat, ui.SURF)
        c.text(86, 84, "Chạm để đo", ui.INK, ("bold", 22))
        last = self.history.recent(1)
        c.text(86, 106, "nhịp tim, oxy máu", ui.INK2, ui.SMALL)
        if last:
            f = ("medium", 14)
            c.text(86, 125, c.fit("Lần trước %d · %d%%" % (last[0]["hr"], last[0]["spo2"]), f, W - 98), ui.BLUE, f)
        c.tap(10, 48, W - 20, 88, "start")
        rows = self.status_rows()[:4]
        h = 21
        c.card(10, 146, W - 20, len(rows) * h + 6, 16)
        y = 149
        for i, (label, value, warn) in enumerate(rows):
            c.row(y, h, label, value, i == len(rows) - 1, warn)
            y += h
        c.button("L", "Bắt đầu", "start", "main")
        c.button("R", "Menu", "menu")

    def next_reminder(self):
        on = sorted(m for m in self.reminders if m >= 0)
        if not on:
            return ""
        tm = time.localtime()
        mins = tm.tm_hour * 60 + tm.tm_min
        later = [m for m in on if m > mins]
        return hhmm(later[0] if later else on[0])

    def draw_place(self, c):
        import math
        now = time.monotonic()
        c.wrap_c(70, "Đeo cảm biến vào ngón tay" if self.sensor_ok else "Đặt ngón tay lên cảm biến", ui.INK, ui.TITLE, W - 40)
        t = (now % 2.0) / 2.0
        fy = 100 + 16 * ui.ease(t / 0.6 if t < 0.6 else 1.0)
        c.box(64, 174, 112, 28, 10, ui.hexc("#1a3a6b"), ui.LOGO, None, 0, ui.SHADOW_SOFT)
        c.rr(102, 179, 36, 18, 6, (40, 56, 90))
        c.disc(W / 2, 188, 9 + 3 * math.sin(now * 6.6), (255, 120, 110))
        c.disc(W / 2, 188, 5, (255, 60, 50))
        c.rr(98, fy, 44, 72, 22, ui.SKIN)
        c.rr(106, fy + 44, 28, 21, 10, ui.NAIL)
        if self.sensor_ok and self.good_streak == 0:
            s = "Đang chờ cảm biến... %ds" % int(now - self.since)
        elif self.sensor_ok:
            s = "Đã thấy ngón tay, giữ yên"
        else:
            s = "Giữ yên tay, thở đều"
        w = c.text_w(s, ui.BOLD) + 28
        c.box((W - w) / 2, 210, w, 26, 13, ui.BLUE_SOFT, ui.hexc("#e0edff"), ui.BLUE_LINE, 1, None)
        c.text_c(W / 2, 228, s, ui.BLUE, ui.BOLD)
        c.button("C", "Hủy", "cancel", key="B")

    def draw_measure(self, c):
        now = time.monotonic()
        elapsed = now - self.measure_start
        holding = now < self.hold_until
        if holding:
            c.box(10, 50, W - 20, 38, 14, ui.AMBER_BG, ui.AMBER_BG, ui.AMBER_LINE, 1, None)
            w = c.text_w("Giữ yên tay!", ui.TITLE) + 22
            c.mark((W - w) / 2, 62, ATTN)
            c.text((W - w) / 2 + 22, 76, "Giữ yên tay!", ui.AMBER, ui.TITLE)
        else:
            c.text_c(W / 2, 68, "Đang đo...", ui.INK, ui.TITLE)
            if self.sensor_ok:
                c.text_c(W / 2, 87, "Đã đọc %d lần · số mới mỗi 4 s" % len(self.hr_samples), ui.INK2, ui.SMALL)
        frac = min(1.0, max(0.0, elapsed / float(self.measure_seconds())))
        cy = 150
        c.disc(W / 2, cy, 60, ui.SURF)
        c.ring(W / 2, cy, 47, 57, 1, ui.BLUE_SOFT)
        c.ring(W / 2, cy, 47, 57, frac, ui.AMBER if holding else ui.BLUE)
        left = self.measure_seconds() if elapsed < 0 else max(0, self.measure_seconds() - int(elapsed))
        c.text_c(W / 2, cy + 16, str(left), ui.INK, ui.HUGE)
        c.text_c(W / 2, cy + 34, "giây", ui.INK2, ui.SMALL)
        live = ""
        if self.live_hr and not holding:
            live = "Nhịp %d" % self.live_hr
            if self.sensor_ok and self.live_spo2:
                live += " · %d%%" % self.live_spo2
        c.card(10, 214, W - 20, 24, 12, shadow=False)
        if holding:
            c.text_c(W / 2, 231, "Đo lại từ đầu", ui.AMBER, ui.BOLD)
        elif self.sensor_ok:
            c.text_c(W / 2, 231, live or "Chờ số đầu tiên...", ui.INK if live else ui.INK2, ui.BOLD)
        else:
            self.draw_wave(c, 20, 216, 120 if live else W - 40, 20)
            if live:
                c.text_r(W - 22, 231, live, ui.INK, ui.BOLD)
        c.button("C", "Hủy", "cancel", key="B")

    def draw_wave(self, c, x, y, w, h):
        v = self.wave[-120:]
        if len(v) < 2:
            return
        lo, hi = min(v), max(v)
        hi = hi if hi - lo > 1e-6 else lo + 1
        pts = [(x + i * (w - 1) / 119.0, y + h - 3 - (val - lo) / (hi - lo) * (h - 6)) for i, val in enumerate(v)]
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            c.line(ax, ay, bx, by, 2, ui.CHART)

    def tile(self, c, x, y, w, h, label, unit, value, level, word, lo, hi, edges, zones):
        c.card(x, y, w, h, 16)
        c.text(x + 12, y + 22, label, ui.INK, ui.BOLD)
        c.text(x + 12, y + 40, unit, ui.INK2, ui.SMALL)
        c.text_c(x + w / 2.0, y + 90, str(value), ui.INK, ui.NUM)
        bx, bw, by = x + 12, w - 24, y + 104

        def pos(v):
            return bx + (min(hi, max(lo, v)) - lo) * bw / float(hi - lo)
        for i, z in enumerate(zones):
            a, b = int(pos(edges[i])) + (1 if i else 0), int(pos(edges[i + 1]))
            c.rr(a, by, max(2, b - a), 6, 3, ui.ZONE[z])
        m = pos(value)
        c.rr(m - 4, by - 7, 8, 20, 3, ui.SURF)
        c.rr(m - 2, by - 5, 4, 16, 2, ui.INK)
        f = ("medium", 14)
        lines = c.split(word, f, w - 34, 2)
        ty, th = y + 124, h - 132
        c.rr(x + 6, ty, w - 12, th, 10, ui.LEVEL_BG[level])
        c.mark(x + 11, ty + th / 2.0 - 6, level, 12)
        for i, ln in enumerate(lines):
            c.text(x + 28, ty + th / 2.0 + 5 + (i * 2 - (len(lines) - 1)) * 8, ln, ui.LEVEL_COLOR[level], f)

    def draw_result(self, c):
        r = self.result
        lh, ls = level_hr(r["hr"]), level_spo2(r["spo2"])
        w = (W - 30) // 2
        self.tile(c, 10, 50, w, 166, "Nhịp tim", "lần/phút", r["hr"], lh, word_hr(lh), 30, 170,
                  [30, 40, 50, 110, 150, 170], [ALERT, ATTN, SAFE, ATTN, ALERT])
        self.tile(c, W - 10 - w, 50, w, 166, "Oxy máu", "SpO₂, %", r["spo2"], ls, word_spo2(ls), 85, 100,
                  [85, 90, 95, 100], [ALERT, ATTN, SAFE])
        state = self.result_state()
        if not self.toast_text:
            ok = state.startswith("Đã lưu")
            text = c.fit(state, ui.SMALL, W - 24)
            c.text_c(W / 2, 234, text, ui.GREEN if ok else ui.INK2, ui.SMALL)
        c.button("L", "Đo lại", "start")
        c.button("R", "Xong", "idle", "main")

    def draw_emergency(self, c):
        r = self.result
        if int(time.monotonic() * 2) % 2:
            for i in range(4):
                c.rect(i, i, W - 2 * i, 1, ui.SURF)
                c.rect(i, H - 1 - i, W - 2 * i, 1, ui.SURF)
                c.rect(i, i, 1, H - 2 * i, ui.SURF)
                c.rect(W - 1 - i, i, 1, H - 2 * i, ui.SURF)
        c.mark(W / 2 - 22, 12, ALERT, 44, ui.SURF)
        c.line(W / 2, 23, W / 2, 37, 4.5, ui.RED_SOLID)
        c.disc(W / 2, 45, 2.6, ui.RED_SOLID)
        c.text_c(W / 2, 86, "NGUY HIỂM", ui.SURF, ui.BIG)
        c.box(16, 96, W - 32, 96, 18, ui.SURF, ui.hexc("#fff4f3"), None, 0, ((60, 0, 0), 0.25, 5, 3))
        c.text_c(W / 2, 125, "Gọi cấp cứu", ui.RED_SOLID, ui.TITLE)
        c.text_c(W / 2, 182, "115", ui.RED_SOLID, ui.HUGE)
        y = 214
        if level_spo2(r["spo2"]) == ALERT:
            c.text_c(W / 2, y, "Oxy trong máu: %d%%" % r["spo2"], ui.SURF, ui.BOLD)
            y += 20
        if level_hr(r["hr"]) == ALERT:
            c.text_c(W / 2, y, "Nhịp tim: %d lần/phút" % r["hr"], ui.SURF, ui.BOLD)
            y += 20
        if y < 236:
            c.text_c(W / 2, y, "Đo lại ngay. Khó thở: gọi 115", ui.SURF, ui.SMALL)
        c.button("L", "Đo lại", "start", "onred")
        c.button("R", "Đã hiểu", "idle", "onred")

    def draw_menu(self, c):
        confirm = time.monotonic() < self.clear_confirm_until
        tw, th = (W - 30) // 2, 58
        for i, ((key, _), icon, label) in enumerate(zip(MENU[:6], MENU_ICONS, MENU_SHORT)):
            x, y = 10 + (i % 2) * (tw + 10), 50 + (i // 2) * (th + 6)
            if confirm and i == self.menu_sel and key in ("clear", "logout"):
                label = "Chạm lại"
            color = ui.RED if key in ("clear", "logout") else ui.BLUE
            c.tile(x, y, tw, th, icon, label, color, i == self.menu_sel, "menu:" + key)
        back = self.menu_sel == len(MENU) - 1
        c.button("L", "Về" if back else "Mở", "menu:" + MENU[self.menu_sel][0], "main")
        c.button("R", "Tiếp", "down")

    def chart(self, c, y, h, label, items, is_hr):
        c.card(10, y, W - 20, h, 16)
        c.text(22, y + 22, label, ui.INK2, ui.SMALL)
        n = len(items)
        if not n:
            c.text_c(W / 2, y + h / 2 + 12, "Chưa có lần đo", ui.INK2, ui.BODY)
            return
        key = "hr" if is_hr else "spo2"
        c.text_r(W - 22, y + 25, str(items[-1][key]) + ("" if is_hr else "%"), ui.INK, ui.TITLE)
        lo, hi = (50.0, 110.0) if is_hr else (90.0, 100.0)
        for it in items:
            lo, hi = min(lo, it[key] - 3), max(hi, it[key] + 3)
        if not is_hr:
            hi = min(hi, 101.0)
        x0, x1, y0, y1 = 28, W - 28, y + 34, y + h - 10

        def py(v):
            return y1 - (v - lo) / (hi - lo) * (y1 - y0)

        def px(k):
            return (x0 + x1) / 2.0 if n == 1 else x0 + k * (x1 - x0) / float(n - 1)
        band_lo, band_hi = (50, 110) if is_hr else (95, 100)
        b0, b1 = min(y1, max(y0, py(band_hi))), min(y1, max(y0, py(band_lo)))
        c.rr(x0 - 6, b0, x1 - x0 + 12, b1 - b0, 5, ui.GREEN_BG)
        for k in range(1, n):
            c.line(px(k - 1), py(items[k - 1][key]), px(k), py(items[k][key]), 2, ui.CHART)
        for k, it in enumerate(items):
            lv = level_hr(it[key]) if is_hr else level_spo2(it[key])
            cx, cy, s = px(k), py(it[key]), (8 if lv == SAFE else 10)
            c.mark(cx - s / 2.0 - 1, cy - s / 2.0 - 1, lv, s + 2, ui.SURF)
            c.mark(cx - s / 2.0, cy - s / 2.0, lv, s)
            if it["mock"]:
                c.mark(cx - s / 4.0, cy - s / 4.0 + (1 if lv == ATTN else 0), lv, s / 2.0, ui.SURF)

    def draw_history(self, c):
        items = self.history.recent(14)
        self.chart(c, 50, 88, "Nhịp tim · lần/phút", items, True)
        self.chart(c, 146, 88, "Oxy trong máu · %", items, False)
        c.button("L", "Đo", "start", "main")
        c.button("R", "Về", "menu")

    def draw_reminders(self, c):
        rh = 52
        c.card(10, 50, W - 20, 3 * rh + 6, 16)
        for i in range(3):
            y = 53 + i * rh
            m = self.reminders[i]
            c.text(24, y + 32, REMIND_NAMES[i], ui.INK2, ui.BODY)
            if m >= 0:
                c.text_r(W - 40, y + 34, hhmm(m), ui.INK, ui.TITLE)
            else:
                c.text_r(W - 40, y + 33, "Tắt", ui.INK2, ui.BOLD)
            c.icon("next", W - 26, y + rh / 2.0, ui.INK2, 0.9)
            if i < 2:
                c.rect(22, y + rh, W - 44, 1, ui.LINE)
            c.tap(10, y, W - 20, rh, "slot:%d" % i)
        note = "Chạm một dòng để đổi giờ" if clock_ok() else "Cần Wi-Fi để máy biết giờ"
        c.text_c(W / 2, 230, note, ui.INK2, ui.SMALL)
        c.button("C", "Về", "menu", key="B")

    def draw_edit(self, c):
        c.card(10, 50, W - 20, 184, 16)
        h, m = self.edit_minutes // 60, self.edit_minutes % 60
        for col, (val, minus, plus) in enumerate((("%02d" % h, -60, 60), ("%02d" % m, -15, 15))):
            cx = 70 if col == 0 else 170
            c.stepper(cx - 34, 60, 68, 42, "+", "adj:%d" % plus)
            c.text_c(cx, 150, val, ui.INK, ui.NUM)
            c.stepper(cx - 34, 164, 68, 42, "-", "adj:%d" % minus)
        c.text_c(W / 2, 147, ":", ui.INK2, ui.NUM)
        c.text_c(W / 2, 226, "Giờ cách 1 · phút cách 15", ui.INK2, ui.SMALL)
        c.button("L", "Lưu", "save", "main")
        c.button("R", "Tắt nhắc", "off")

    def draw_remind(self, c):
        import math
        c.box(10, 50, W - 20, 184, 18, ui.SURF, ui.hexc("#eef7ff"), ui.hexc("#c9e1ff"), 1, ui.SHADOW_CARD)
        wob = math.sin(time.monotonic() * 9) * 4 if int(time.monotonic()) % 3 == 0 else 0
        c.box(W / 2 - 34, 66, 68, 68, 34, ui.BLUE_TOP, ui.BLUE, None, 0, ui.SHADOW_BLUE)
        c.icon("clock", W / 2 + wob * 0.3, 100, ui.SURF, 1.6)
        c.text_c(W / 2, 168, "Đến giờ đo", ui.INK, ui.BIG)
        c.text_c(W / 2, 192, "Nhắc lúc " + self.remind_label, ui.INK2, ui.BODY)
        c.text_c(W / 2, 220, "Chạm để đo ngay", ui.BLUE, ui.BOLD)
        c.tap(10, 50, W - 20, 184, "start")
        c.button("L", "Đo ngay", "start", "main")
        c.button("R", "Để sau", "later")

    def draw_brightness(self, c):
        c.card(10, 50, W - 20, 184, 16)
        c.box(W / 2 - 28, 62, 56, 56, 28, ui.BLUE_TOP, ui.BLUE, None, 0, ui.SHADOW_BLUE)
        c.icon("sun", W / 2, 90, ui.SURF, 1.3)
        if not self.backlight.ok:
            c.text_c(W / 2, 150, "Không chỉnh được", ui.INK, ui.BOLD)
            c.wrap_c(176, "Máy này không cho phần mềm chỉnh độ sáng màn hình.", ui.INK2, ui.SMALL, W - 48)
            c.button("C", "Về", "menu", key="B")
            return
        c.text_c(W / 2, 156, "%d%%" % self.brightness, ui.INK, ui.BIG)
        c.stepper(20, 168, 44, 40, "-", "light:-10")
        c.stepper(W - 64, 168, 44, 40, "+", "light:+10")
        x0, x1, y = 76, W - 76, 188
        c.rr(x0, y - 4, x1 - x0, 8, 4, ui.BLUE_SOFT)
        k = x0 + (x1 - x0) * (self.brightness - 10) / 90.0
        c.rr(x0, y - 4, max(8, k - x0), 8, 4, ui.BLUE)
        c.disc(k, y, 9, ui.SURF)
        c.disc(k, y, 6, ui.BLUE)
        for i in range(10):                  # touch anywhere on the bar: 10 % .. 100 %
            seg = (x1 - x0 + 16) / 10.0
            c.tap(x0 - 8 + i * seg, y - 18, seg, 36, "light:%d" % ((i + 1) * 10))
        c.text_c(W / 2, 226, "Chạm thanh để chọn nhanh", ui.INK2, ui.SMALL)
        c.button("C", "Về", "menu", key="B")

    def draw_info(self, c):
        rows = []
        sd = sd_folder()
        if sd:
            try:
                st = os.statvfs(sd)
                rows.append(("Thẻ nhớ", "trống %s GB" % ui.vn(st.f_bavail * st.f_frsize / 1e9, 0), False))
            except OSError:
                rows.append(("Thẻ nhớ", "Có thẻ", False))
        else:
            rows.append(("Thẻ nhớ", "Không có thẻ", False))
        rows.append(("Tài khoản", self.account_text(), False))
        unsent = self.history.unsent_count()
        if self.cloud.sync_problem == 409:
            rows.append(("Đồng bộ", "Cần hoàn thành hồ sơ", True))
        else:
            rows.append(("Đồng bộ", ("Chờ gửi %d" % unsent) if unsent else "Đã gửi hết", False))
        card = usb_card()
        rows.append(("Loa", card[1] if card else "Dùng còi", card is None))
        voice, warn = self.voice_text()
        rows.append(("Giọng nói", voice, warn))
        rows.append(("Wi-Fi", self.net.ssid or "Chưa kết nối", False))
        rows.append(("Địa chỉ", self.net.ip, False) if self.net.ssid else ("Cài Wi-Fi", "USB, mở 10.1.2.3", False))
        rh = 25
        c.card(10, 50, W - 20, len(rows) * rh + 6, 16)
        y = 53
        for i, (label, value, warn) in enumerate(rows):
            c.row(y, rh, label, value or "—", i == len(rows) - 1, warn)
            y += rh
        c.button("C", "Về", "menu", key="B")

    _qr_cache = (None, None)

    def qr_matrix(self, url):
        if self._qr_cache[0] != url:
            try:
                import qrcode
                q = qrcode.QRCode(border=0, error_correction=qrcode.constants.ERROR_CORRECT_M)
                q.add_data(url)
                q.make(fit=True)
                self._qr_cache = (url, q.get_matrix())
            except ImportError:
                self._qr_cache = (url, None)
        return self._qr_cache[1]

    def draw_pair(self, c):
        code, url = self.cloud.pair_code, self.cloud.pair_url
        if not self.net.ssid:                # step 1: Wi-Fi
            c.text_c(W / 2, 70, "Đăng nhập", ui.INK, ui.TITLE)
            c.card(10, 84, W - 20, 150, 16)
            c.status_icon(W / 2, 124, ATTN)
            c.text_c(W / 2, 172, "Bước 1: nối Wi-Fi", ui.INK, ui.BOLD)
            c.wrap_c(194, "Cắm cáp USB vào máy tính, mở trang 10.1.2.3, chọn Wi-Fi.", ui.INK2, ui.SMALL, W - 44)
            return
        if not code:
            now = time.monotonic()
            c.text_c(W / 2, 70, "Đăng nhập", ui.INK, ui.TITLE)
            c.card(10, 84, W - 20, 150, 16)
            c.ring(W / 2, 134, 22, 28, 1, ui.BLUE_SOFT)
            c.arc(W / 2, 134, 25, (now * 300) % 360, (now * 300) % 360 + 90, 6, ui.BLUE)
            p = self.cloud.pair_problem
            c.text_c(W / 2, 192, "Chưa lấy được mã" if p else "Đang lấy mã...", ui.INK, ui.BOLD)
            if p:
                why = ("Không vào được mạng, thử lại..." if p < 0 else
                       "Máy chủ chưa hỗ trợ máy đo (404)" if p == 404 else "Lỗi %d, thử lại..." % p)
                c.wrap_c(214, why, ui.INK2, ui.SMALL, W - 44)
            return
        c.text_c(W / 2, 66, "Quét mã để đăng nhập", ui.INK, ui.BOLD)
        m = self.qr_matrix(url)
        if m:
            c.qr(m, 78, 116)
        else:
            c.wrap_c(120, "Mở ứng dụng GeneSense, chọn Kết nối máy đo và nhập mã:", ui.INK2, ui.BODY, W - 32)
        c.text_c(W / 2, 228, code[:4] + " " + code[4:], ui.NAVY, ui.BIG)
        c.button("C", "Mã mới", "newcode")


TITLES = {"menu": "Menu", "brightness": "Độ sáng", "history": "Lịch sử đo", "reminders": "Nhắc đo", "info": "Thông tin", "result": "Kết quả đo"}
BACK = {"menu": "idle", "brightness": "menu", "history": "menu", "reminders": "menu", "edit": "reminders", "info": "menu", "result": "idle"}
DEPTH = {"pair": 0, "idle": 0, "remind": 1, "place": 1, "measure": 1, "menu": 1, "result": 2, "emergency": 2,
         "history": 2, "reminders": 2, "info": 2, "brightness": 2, "edit": 3}
FRAME_EVERY = {"measure": 0.1, "place": 0.1, "pair": 0.1, "idle": 0.12, "remind": 0.12, "emergency": 0.25}
MENU_ICONS = ["chart", "clock", "sun", "info", "logout", "trash"]
MENU_SHORT = ["Lịch sử", "Nhắc đo", "Độ sáng", "Thông tin", "Đăng xuất", "Xóa lịch sử"]


def run_tk(app):
    import tkinter as tk
    from PIL import ImageTk
    os.environ.setdefault("DISPLAY", ":0")
    root = tk.Tk()
    root.title("GeneSense")
    root.geometry("%dx%d+0+0" % (W, H))
    root.resizable(False, False)
    if app.board.ok:                         # on the M10: full screen, no mouse pointer
        root.overrideredirect(True)
        root.config(cursor="none")
    label = tk.Label(root, bd=0, highlightthickness=0)
    label.pack()
    st = {"photo": None, "last": 0.0, "minute": -1, "a": False, "b": False, "screen": None, "base": None, "trans": None,
          "cost": 0.03}

    label.bind("<Button-1>", lambda e: app.tap(e.x, e.y))
    root.bind("<Escape>", lambda e: root.destroy())
    root.bind("a", lambda e: app.button("A"))
    root.bind("b", lambda e: app.button("B"))

    def show(img):
        st["photo"] = ImageTk.PhotoImage(img)
        label.configure(image=st["photo"])

    def loop():
        try:
            a, b = app.board.buttons()
            if a and not st["a"]:
                app.button("A")
            if b and not st["b"]:
                app.button("B")
            st["a"], st["b"] = a, b
            app.tick()
            now = time.monotonic()
            img = None
            if app.screen != st["screen"]:   # a new screen slides in over the old one
                old = st["base"]
                new = app.draw().frame()
                if old is not None:
                    if app.flash and now - app.flash[1] < 0.3:
                        old = ui.flash(old, app.flash[0], 1.0)
                    d = DEPTH.get(app.screen, 1) - DEPTH.get(st["screen"], 1)
                    st["trans"] = (old, new, now, (d > 0) - (d < 0))
                st["screen"], st["base"], st["last"] = app.screen, new, now
                img = new if old is None else old
            if st["trans"]:
                old, new, t0, direction = st["trans"]
                t = (now - t0) / 0.26
                if t >= 1:
                    st["trans"] = None
                    img = st["base"]
                else:
                    img = ui.slide(old, new, t, direction)
            if not st["trans"]:
                minute = time.localtime().tm_min
                every = FRAME_EVERY.get(app.screen)
                if every:                    # a slow frame: draw less often, so touches stay quick
                    every = max(every, st["cost"] * 3)
                if (app.dirty or app.animating(now) or minute != st["minute"] or
                        (every and now - st["last"] >= every)):
                    st["minute"], st["last"] = minute, now
                    st["base"] = app.draw().frame()
                    st["cost"] = st["cost"] * 0.8 + (time.monotonic() - now) * 0.2
                    img = st["base"]
                if app.flash and now - app.flash[1] < 0.2:
                    img = ui.flash(img or st["base"], app.flash[0], 1 - (now - app.flash[1]) / 0.2)
            if img is not None:
                show(img)
        except Exception as e:               # keep the device running whatever happens
            import traceback
            traceback.print_exc()
            print("Screen loop: %s" % e)
        root.after(30, loop)
    loop()
    root.mainloop()


def make_app():
    config = Config()
    if GEMINI_KEY:
        config.set(gemini_key=GEMINI_KEY)
    board = Board()
    history = History()
    cloud = Cloud(GENESENSE_URL, DEVICE_NAME, config, history)
    voice = Voice(board, config.get("gemini_key", ""), VOICE_VOLUME)
    app = App(board, config, history, cloud, voice, Network())
    cloud.start()
    return app


if __name__ == "__main__":
    print("GeneSense M10, server %s" % GENESENSE_URL)
    run_tk(make_app())
