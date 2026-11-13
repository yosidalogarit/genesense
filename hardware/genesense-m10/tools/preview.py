"""Draws every screen to PNG files (no M10, no network needed): python3 tools/preview.py [folder]"""
import os
import sys
import time

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, HERE)

import genesense as g  # noqa: E402
from PIL import Image  # noqa: E402


class FakeBoard:
    ok = False

    def buttons(self):
        return False, False

    def accel(self):
        return None

    def light(self):
        return -1

    def tone(self, freq, ms):
        pass


class FakeCloud:
    signed_in, account_name = True, "Nguyễn Thị Lan"
    pair_code, pair_url, pair_problem, sync_problem, want_pairing, meds_problem = "", "", 0, 0, False, 0
    medications = [
        {"id": "m1", "name": "Metformin", "strength": "500 mg", "amount": "1 viên", "meal": "after",
         "morning": True, "noon": False, "afternoon": False, "evening": True},
        {"id": "m2", "name": "Amlodipin", "strength": "5 mg", "amount": "1 viên", "meal": "any",
         "morning": True, "noon": False, "afternoon": False, "evening": False},
        {"id": "m3", "name": "Vitamin D3", "strength": "", "amount": "1 viên", "meal": "after",
         "morning": False, "noon": True, "afternoon": False, "evening": False},
    ]

    def __init__(self):
        self.taken = {("m3", "noon")}

    def take_events(self):
        return []

    def meds_today(self, day):
        return list(self.medications), set(self.taken)

    def mark_taken(self, day, items):
        self.taken.update(items)

    def refresh_meds(self):
        pass


class FakeVoice:
    key, problem, night = "x", 0, False

    def say(self, *a, **k):
        pass

    def idle(self):
        return True

    def ready_count(self):
        return 4

    def start_making(self):
        pass


class FakeNet:
    ssid, ip = "Nha Lan 5G", "192.168.1.23"


class MemConfig(dict):
    def set(self, **v):
        self.update(v)


class MemHistory:
    def __init__(self):
        now = time.time()
        vals = [(72, 98), (76, 97), (81, 96), (69, 98), (74, 97), (70, 97), (75, 98), (73, 98), (71, 97), (77, 97),
                (72, 98)]
        self.items = [{"t": int(now - (len(vals) - i) * 50000), "hr": h, "spo2": s, "mock": False, "sent": True,
                       "local": False, "added": now - (len(vals) - i) * 50000} for i, (h, s) in enumerate(vals)]

    def add(self, hr, spo2, mock, clock_ok):
        it = {"t": int(time.time()), "hr": hr, "spo2": spo2, "mock": mock, "sent": False, "local": False,
              "added": time.time()}
        self.items.append(it)
        return it

    def recent(self, n):
        return [dict(i) for i in self.items[-n:]]

    def unsent_count(self):
        return sum(1 for i in self.items if not (i["mock"] or i["sent"] or i["local"]))

    def clear(self):
        self.items = []


def shots(out):
    os.makedirs(out, exist_ok=True)
    cloud, net, voice = FakeCloud(), FakeNet(), FakeVoice()
    app = g.App(FakeBoard(), MemConfig(reminders=[7 * 60, -1, 19 * 60 + 30]), MemHistory(), cloud, voice, net)
    app.sensor_ok = True
    pics = []

    def snap(name):
        img = app.draw().frame()
        img.save(os.path.join(out, name + ".png"))
        pics.append(img)

    snap("01_idle")
    app.go("place")
    app.since = time.monotonic() - 4
    snap("02_place")
    app.go("measure")
    app.measure_start = time.monotonic() - 17
    app.hr_samples = [74, 75, 73]
    app.live_hr, app.live_spo2 = 74, 97
    snap("03_measure")
    app.hold_until = time.monotonic() + 2
    snap("04_hold")
    app.hold_until = 0
    app.result = app.history.add(74, 97, False, True)
    app.go("result")
    snap("05_result")
    app.result = app.history.add(118, 93, False, True)
    app.history.items[-1]["sent"] = True
    snap("06_result_attention")
    app.result = app.history.add(156, 87, False, True)
    app.go("emergency")
    snap("07_emergency")
    app.go("menu")
    app.menu_sel = 2
    snap("08_menu")
    app.go("history")
    snap("09_history")
    app.go("reminders")
    snap("10_reminders")
    app.edit_slot, app.edit_minutes = 0, 7 * 60
    app.go("edit")
    snap("11_edit")
    app.remind_label = "19:30"
    app.go("remind")
    snap("12_remind")
    app.go("info")
    snap("13_info")
    cloud.signed_in = False
    cloud.pair_code, cloud.pair_url = "K7MP4XQ2", "https://genesense-five.vercel.app/#ket-noi-may?ma=K7MP4XQ2"
    app.go("pair")
    snap("14_pair")
    net.ssid = ""
    snap("15_pair_wifi")
    net.ssid = "Nha Lan 5G"
    cloud.pair_code = ""
    cloud.pair_problem = -1
    snap("16_pair_wait")
    cloud.signed_in = True
    app.sensor_ok = False
    app.go("measure")
    app.measure_start = time.monotonic() - 6
    app.wave = [__import__("math").sin(i / 3.0) for i in range(120)]
    snap("17_measure_mock")
    app.go("idle")
    app.toast("Đã đăng nhập: Nguyễn Thị Lan", g.SAFE)
    snap("18_idle_mock_toast")

    app.sensor_ok = True
    app.toast_text = ""
    app.go("clock")
    snap("19_clock")
    app.med_slot = "morning"
    app.go("medicine")
    snap("20_medicine")
    app.go("meds")
    snap("21_meds")
    app.result = app.history.add(74, 97, False, True)
    app.go("trend")
    snap("22_trend")
    app.result = app.history.add(96, 93, False, True)
    snap("23_trend_attention")
    app.go("result")
    snap("24_result")

    cols = 6
    rows = (len(pics) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (g.W + 12) + 12, rows * (g.H + 12) + 12), (40, 44, 52))
    for i, p in enumerate(pics):
        sheet.paste(p, (12 + (i % cols) * (g.W + 12), 12 + (i // cols) * (g.H + 12)))
    sheet.save(os.path.join(out, "all.png"))
    print("Saved %d screens to %s" % (len(pics), out))


if __name__ == "__main__":
    shots(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "preview"))
