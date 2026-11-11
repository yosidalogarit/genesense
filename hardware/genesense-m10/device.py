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
    """All talk with the co-processor goes through `io`, one thing at a time: pinpong is not safe to use from two
    threads at once (screen loop, voice thread), and the system's `brightness` command may use the same link.
    Reads give up quickly when the link is busy instead of waiting, so the screen never hangs on them."""

    def __init__(self):
        self.ok = False
        self.i2c = None
        self.io = threading.RLock()
        if platform.machine() != "aarch64" or os.environ.get("GENESENSE_NO_BOARD"):
            print("Board: not a UNIHIKER, using mock values")   # pinpong would hunt for a board on a PC
            return
        for attempt in range(3):             # right after power-on the co-processor may need a moment
            try:
                from pinpong.board import Board as PinpongBoard, I2C
                PinpongBoard("UNIHIKER").begin()   # starts the co-processor link (a few seconds)
                from pinpong.extension.unihiker import accelerometer, button_a, button_b, buzzer, light
                self._a, self._b, self._buzzer, self._light, self._acc = button_a, button_b, buzzer, light, accelerometer
                self.i2c = I2C(bus_num=4)
                self.ok = True
                return
            except ImportError as e:         # pinpong missing: no point trying again
                print("Board: running without the M10's hardware (%s)" % e)
                return
            except Exception as e:
                print("Board: co-processor not ready (%s), attempt %d" % (e, attempt + 1))
                time.sleep(4)
        print("Board: running without the M10's hardware")

    def _take(self, wait=0.05):
        return self.io.acquire(timeout=wait)

    def buttons(self):                       # (A pressed, B pressed)
        if not self.ok or not self._take():
            return False, False
        try:
            return bool(self._a.is_pressed()), bool(self._b.is_pressed())
        except Exception:
            return False, False
        finally:
            self.io.release()

    def accel(self):                         # (x, y, z) in g, or None
        if not self.ok or not self._take():
            return None
        try:
            self._acc.get_alldata()
            return self._acc._ax, self._acc._ay, self._acc._az
        except Exception:
            return None
        finally:
            self.io.release()

    def light(self):                         # 0 (dark) .. 4095 (bright), -1 = unknown
        if not self.ok or not self._take():
            return -1
        try:
            return int(self._light.read())
        except Exception:
            return -1
        finally:
            self.io.release()

    def tone(self, freq, ms):                # one note on the buzzer, waits until it ends
        if not self.ok:
            time.sleep(ms / 1000.0)
            return
        if not self._take(1.0):              # busy for long: skip the note rather than pile up
            return
        try:
            self._buzzer.pitch(int(freq))
        except Exception:
            pass
        finally:
            self.io.release()
        time.sleep(ms / 1000.0)              # the link is free while the note sounds
        with self.io:
            try:
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
            with self.board.io:
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
            if not self.board._take(0.3):
                return None
            try:
                d = self.board.i2c.readfrom_mem(OXI_ADDR, 0x0C, 8)
            finally:
                self.board.io.release()
            self.errors = 0
            return int(d[0]), (d[2] << 24) | (d[3] << 16) | (d[4] << 8) | d[5]
        except Exception:
            self.errors += 1
            return None


class Backlight:
    """The screen's backlight. The M10 has no Linux backlight file: its system gives a `brightness 0-100` command
    (unihiker.UNIConfig uses the same). The level resets when the M10 restarts, so the program sets it again at start.
    /sys/class/backlight is still tried for other boards."""
    ROOT = "/sys/class/backlight"

    SETTLE = 0.7                             # wait until taps stop for this long before changing it
    SPACING = 1.5                            # and never run the command more often than this

    def __init__(self, link=None):
        import shutil
        self.link = link                     # Board.io: nothing else talks to the co-processor while it runs
        self._last_run = 0.0
        self._asked = 0.0
        self.command = shutil.which("brightness") or next(
            (p for p in ("/usr/bin/brightness", "/usr/local/bin/brightness", "/opt/unihiker/bin/brightness") if os.path.exists(p)), None)
        self.path, self.max = None, 0
        if not self.command:
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
        self._want = None
        self._lock = threading.Lock()
        self._busy = False
        print("Backlight: %s" % (self.command or self.path or "no way to change it found"))

    @property
    def ok(self):
        return bool(self.command or self.path)

    def get(self):                           # percent, or None when it cannot be read (the command only sets)
        if not self.path:
            return None
        try:
            with open(os.path.join(self.path, "brightness")) as f:
                return int(round(int(f.read().strip()) * 100.0 / self.max))
        except (OSError, ValueError):
            return None

    def set(self, percent):                  # True = accepted; the command runs in the background
        if not self.ok:
            return False
        percent = max(5, min(100, int(percent)))
        if self.path:
            try:
                with open(os.path.join(self.path, "brightness"), "w") as f:
                    f.write(str(max(1, int(round(self.max * percent / 100.0)))))
                return True
            except (OSError, ValueError) as e:
                print("Backlight: %s" % e)
                return False
        with self._lock:                     # quick taps: only the last level is sent, once they stop
            self._want = percent
            self._asked = time.time()
            if self._busy:
                return True
            self._busy = True
        threading.Thread(target=self._run, daemon=True).start()
        return True

    def _run(self):
        import subprocess
        while True:
            while True:                      # let the taps settle, and keep runs apart
                now = time.time()
                wait = max(self._asked + self.SETTLE - now, self._last_run + self.SPACING - now)
                if wait <= 0:
                    break
                time.sleep(min(wait, 0.2))
            with self._lock:
                level, self._want = self._want, None
                if level is None:
                    self._busy = False
                    return
            if self.link is not None:
                self.link.acquire()
            try:
                subprocess.run([self.command, str(level)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
            except (OSError, subprocess.SubprocessError) as e:
                print("Backlight: %s" % e)
            finally:
                if self.link is not None:
                    self.link.release()
                self._last_run = time.time()


class MockOximeter:
    """Believable numbers when no sensor is plugged in. The screen says they are mock values."""

    def __init__(self):
        self.hr, self.spo2 = 74.0, 97.6

    def read(self):
        self.hr += (74 - self.hr) * 0.08 + random.uniform(-0.8, 0.8)
        self.spo2 = min(100.0, max(90.0, self.spo2 + (97.6 - self.spo2) * 0.15 + random.uniform(-0.15, 0.15)))
        return int(round(self.spo2)), int(round(self.hr))
