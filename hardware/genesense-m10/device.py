"""The M10's own hardware (buttons A/B, buzzer, motion sensor, light sensor) and the SEN0518 sensor.

The SEN0518 plugs into the 4-pin Gravity I2C port. On the M10 that port belongs to the co-processor,
which Linux sees as I2C bus 4; the pinpong library talks to it. Off the board (on a PC) everything here
falls back to a mock so the screens can still be tried.
"""
import os
import platform
import random
import threading
import time

OXI_ADDR = 0x57                              # SEN0518, switch on the sensor set to I2C


class Board:
    def __init__(self):
        self.ok = False
        self.i2c = None
        self._beep_lock = threading.Lock()
        if platform.machine() != "aarch64" or os.environ.get("GENESENSE_NO_BOARD"):
            print("Board: not a UNIHIKER, using mock values")   # pinpong would hunt for a board on a PC
            return
        try:
            from pinpong.board import Board as PinpongBoard, I2C
            PinpongBoard("UNIHIKER").begin()   # starts the co-processor link (a few seconds)
            from pinpong.extension.unihiker import accelerometer, button_a, button_b, buzzer, light
            self._a, self._b, self._buzzer, self._light, self._acc = button_a, button_b, buzzer, light, accelerometer
            self.i2c = I2C(bus_num=4)
            self.ok = True
        except Exception as e:               # not a UNIHIKER, or pinpong missing
            print("Board: running without the M10's hardware (%s)" % e)

    def buttons(self):                       # (A pressed, B pressed)
        if not self.ok:
            return False, False
        try:
            return bool(self._a.is_pressed()), bool(self._b.is_pressed())
        except Exception:
            return False, False

    def accel(self):                         # (x, y, z) in g, or None
        if not self.ok:
            return None
        try:
            self._acc.get_alldata()
            return self._acc._ax, self._acc._ay, self._acc._az
        except Exception:
            return None

    def light(self):                         # 0 (dark) .. 4095 (bright), -1 = unknown
        if not self.ok:
            return -1
        try:
            return int(self._light.read())
        except Exception:
            return -1

    def tone(self, freq, ms):                # one note on the buzzer, waits until it ends
        if not self.ok:
            time.sleep(ms / 1000.0)
            return
        with self._beep_lock:
            try:
                self._buzzer.pitch(int(freq))
                time.sleep(ms / 1000.0)
                self._buzzer.stop()
            except Exception:
                pass


class Oximeter:
    """DFRobot SEN0518: its own chip works out heart rate and SpO2; we read the numbers about every 4 s."""

    def __init__(self, board):
        self.board = board
        self.found = False
        self.errors = 0

    def start(self):                         # True = the sensor answered
        self.found = False
        if not self.board.ok:
            return False
        try:
            if OXI_ADDR not in self.board.i2c.scan():
                return False
            self.board.i2c.writeto_mem(OXI_ADDR, 0x20, [0x00, 0x01])   # "start measuring"
            self.found = True
            self.errors = 0
        except Exception as e:
            print("SEN0518: %s" % e)
        return self.found

    def read(self):                          # (spo2, heart rate); spo2 0 = no finger yet; None = no answer
        try:
            d = self.board.i2c.readfrom_mem(OXI_ADDR, 0x0C, 8)
            self.errors = 0
            return int(d[0]), (d[2] << 24) | (d[3] << 16) | (d[4] << 8) | d[5]
        except Exception:
            self.errors += 1
            return None


class Backlight:
    """The screen's backlight through Linux (/sys/class/backlight). The program runs as root, so it may write it."""
    ROOT = "/sys/class/backlight"

    def __init__(self):
        self.path, self.max = None, 0
        try:
            for name in sorted(os.listdir(self.ROOT)):
                path = os.path.join(self.ROOT, name)
                with open(os.path.join(path, "max_brightness")) as f:
                    top = int(f.read().strip())
                if top > 0:
                    self.path, self.max = path, top
                    break
        except (OSError, ValueError):
            pass
        print("Backlight: %s" % (self.path or "none found"))

    @property
    def ok(self):
        return self.path is not None

    def get(self):                           # percent, or None
        if not self.ok:
            return None
        try:
            with open(os.path.join(self.path, "brightness")) as f:
                return int(round(int(f.read().strip()) * 100.0 / self.max))
        except (OSError, ValueError):
            return None

    def set(self, percent):                  # True = written
        if not self.ok:
            return False
        try:
            with open(os.path.join(self.path, "brightness"), "w") as f:
                f.write(str(max(1, int(round(self.max * percent / 100.0)))))
            return True
        except (OSError, ValueError) as e:
            print("Backlight: %s" % e)
            return False


class MockOximeter:
    """Believable numbers when no sensor is plugged in. The screen says they are mock values."""

    def __init__(self):
        self.hr, self.spo2 = 74.0, 97.6

    def read(self):
        self.hr += (74 - self.hr) * 0.08 + random.uniform(-0.8, 0.8)
        self.spo2 = min(100.0, max(90.0, self.spo2 + (97.6 - self.spo2) * 0.15 + random.uniform(-0.15, 0.15)))
        return int(round(self.spo2)), int(round(self.hr))
