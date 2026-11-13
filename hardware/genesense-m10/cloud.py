"""GeneSense account: sign in once by QR code, then send every finished reading to the person's profile.

Same server API as the K10 (backend/app/devices.py):
  POST /api/devices/pair          -> a code to show, with the link for the QR code
  POST /api/devices/pair/token    -> 202 until the owner taps "Kết nối" on the phone, then the device token
  POST /api/devices/readings      -> one reading (Bearer token)
  GET  /api/devices/me            -> whose profile; 401 = the device was disconnected
  DELETE /api/devices/me          -> sign out
  GET  /api/devices/medications   -> today's medicines from the app, and which were already ticked
  PUT  /api/devices/medications/{id}/intakes/{slot} -> "Đã uống"
"""
import hashlib
import json
import threading
import time
import urllib.error
import urllib.request


def reading_id(t, hr, spo2, salt):
    """The same id the app makes for a device link, so a reading saved both ways is saved once."""
    text = ("genesense-device|%d000|%d|%d" % (t, hr, spo2)) if t else ("genesense-m10|%s|%d|%d" % (salt, hr, spo2))
    x = hashlib.sha256(text.encode()).hexdigest()
    return "%s-%s-%s-%s-%s" % (x[:8], x[8:12], x[12:16], x[16:20], x[20:32])


class Cloud:
    def __init__(self, base_url, device_name, config, history):
        self.base = base_url.rstrip("/")
        self.device_name = device_name
        self.config = config
        self.history = history
        self.lock = threading.Lock()
        self.pair_code = ""                  # shown on the screen while signing in
        self.pair_url = ""
        self.pair_problem = 0                # HTTP code of the last failed attempt, -1 = no connection
        self.sync_problem = 0
        self.want_pairing = False            # the screen sets this while the sign-in screen is up
        self.events = []                     # for the screen: "signed_in", "revoked", "saved"
        self._device_code = ""
        self._expires = 0.0
        self._next_poll = 0.0
        self._pause_until = 0.0
        self._logout = False
        self._new_code = False
        # today's medicines (from the app's "Thuốc" list); kept in the config so they work without Wi-Fi too
        cached = config.get("meds_cache") or {}
        self.meds = {"day": cached.get("day", ""), "medications": cached.get("medications", []),
                     "taken": set(tuple(x) for x in cached.get("taken", []))}
        self.meds_problem = 0
        self._meds_at = 0.0
        self._meds_now = True
        self._intake_pause = 0.0

    # ---------- state the screen reads ----------
    @property
    def signed_in(self):
        return bool(self.config.get("device_token"))

    @property
    def account_name(self):
        return self.config.get("account_name", "")

    def take_events(self):
        with self.lock:
            out, self.events = self.events, []
        return out

    def _event(self, name):
        with self.lock:
            self.events.append(name)

    def new_code(self):
        self._new_code = True

    # ---------- medicines ----------
    def meds_today(self, day):
        """(medications, taken set of (id, slot)) for that day, or (None, set()) when not fetched yet."""
        with self.lock:
            if self.meds["day"] != day:
                return None, set()
            return list(self.meds["medications"]), set(self.meds["taken"])

    def refresh_meds(self):
        self._meds_now = True

    def mark_taken(self, day, items):
        """items: [(medication id, slot)]. Shown as taken at once; sent when there is a connection."""
        with self.lock:
            if self.meds["day"] == day:
                self.meds["taken"].update(items)
            self._save_meds()
        queue = list(self.config.get("intake_queue", []))
        queue += [{"day": day, "id": mid, "slot": slot} for mid, slot in items]
        self.config.set(intake_queue=queue[-100:])
        self._intake_pause = 0

    def _save_meds(self):                    # call with the lock held
        self.config.set(meds_cache={"day": self.meds["day"], "medications": self.meds["medications"],
                                    "taken": sorted(list(x) for x in self.meds["taken"])})

    def _sync_meds(self):
        if time.time() < 1700000000:         # no clock yet: "today" is unknown
            return
        day = time.strftime("%Y-%m-%d")
        now = time.time()
        if not (self._meds_now or now - self._meds_at > 600 or self.meds["day"] != day):
            return
        self._meds_now = False
        self._meds_at = now
        code, j = self.request("GET", "/api/devices/medications?day=" + day, token=self.config.get("device_token"))
        if code == 401:
            self._forget()
            self._event("revoked")
            return
        if code != 200:
            self.meds_problem = code
            self._meds_at = now - 540        # try again in a minute
            return
        self.meds_problem = 0
        pending = set((q["id"], q["slot"]) for q in self.config.get("intake_queue", []) if q.get("day") == day)
        with self.lock:
            self.meds = {"day": day, "medications": j.get("medications", []),
                         "taken": set((t["medication_id"], t["slot"]) for t in j.get("taken", [])) | pending}
            self._save_meds()
        self._event("meds")

    def _send_intakes(self):
        queue = list(self.config.get("intake_queue", []))
        if not queue or time.time() < self._intake_pause:
            return
        item = queue[0]
        code, _ = self.request("PUT", "/api/devices/medications/%s/intakes/%s" % (item["id"], item["slot"]),
                               {"scheduled_on": item["day"], "taken": True}, token=self.config.get("device_token"))
        if code == 401:
            self._forget()
            self._event("revoked")
        elif code in (200, 404, 422):       # saved, or the medicine/day no longer exists: drop it
            self.config.set(intake_queue=[q for q in self.config.get("intake_queue", []) if q != item])
            print("GeneSense: medicine intake %s (HTTP %d)" % ("saved" if code == 200 else "dropped", code))
        else:
            self._intake_pause = time.time() + 30

    def logout(self):
        self._logout = True

    # ---------- HTTP ----------
    def request(self, method, path, body=None, token=None):
        """Returns (HTTP code, parsed JSON or {}); code -1 = no connection."""
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("User-Agent", "GeneSense-M10")
        req.add_header("X-Requested-With", "HealthPredict")   # the server's guard against other web pages
        if data is not None:
            req.add_header("Content-Type", "application/json")
        if token:
            req.add_header("Authorization", "Bearer " + token)
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                raw = r.read()
                return r.status, (json.loads(raw.decode()) if raw else {})
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read().decode() or "{}")
            except ValueError:
                return e.code, {}
        except (urllib.error.URLError, OSError, ValueError) as e:
            print("GeneSense: no connection (%s)" % e)
            return -1, {}

    # ---------- the background loop ----------
    def start(self):
        t = threading.Thread(target=self._loop, daemon=True)
        t.start()

    def _loop(self):
        last_check = 0.0
        while True:
            try:
                if self._logout:
                    token = self.config.get("device_token")
                    if token:
                        self.request("DELETE", "/api/devices/me", token=token)
                    self._forget()
                    self._logout = False
                elif not self.signed_in:
                    if self.want_pairing:
                        self._pair_step()
                else:
                    if not last_check or time.time() - last_check > 30 * 60:
                        self._check_account()
                        last_check = time.time()
                    if self.signed_in:
                        self._sync_one()
                    if self.signed_in:
                        self._sync_meds()
                    if self.signed_in:
                        self._send_intakes()
            except Exception as e:           # never let the loop die
                print("GeneSense loop: %s" % e)
            time.sleep(0.5 if not self.signed_in else 2)

    def _forget(self):
        self.config.set(device_token="", account_name="", meds_cache={}, intake_queue=[])
        with self.lock:
            self.meds = {"day": "", "medications": [], "taken": set()}
        self._meds_now = True
        with self.lock:
            self.pair_code = self.pair_url = ""
        self._device_code = ""

    def _pair_step(self):
        now = time.time()
        if self._new_code:
            self._new_code = False
            self._device_code = ""
        if not self._device_code or now >= self._expires:
            code, j = self.request("POST", "/api/devices/pair", {"name": self.device_name})
            if code != 201:
                self.pair_problem = code
                self._device_code = ""
                with self.lock:
                    self.pair_code = ""
                print("GeneSense: no sign-in code (HTTP %d)" % code)
                time.sleep(10)
                return
            with self.lock:
                self.pair_code, self.pair_url = j.get("user_code", ""), j.get("verification_url", "")
            self._device_code = j.get("device_code", "")
            self._expires = now + max(60, int(j.get("expires_in", 600))) - 20
            self._next_poll = now + 5
            self.pair_problem = 0
            print("GeneSense: sign-in code %s" % self.pair_code)
            return
        if now < self._next_poll:
            return
        self._next_poll = now + 5
        code, j = self.request("POST", "/api/devices/pair/token", {"device_code": self._device_code})
        if code == 202:
            return                           # not confirmed yet
        if code == 404:
            self._device_code = ""           # expired: a new code
            return
        if code != 200 or not j.get("token"):
            print("GeneSense: sign-in check HTTP %d" % code)
            return
        self.history.keep_all_local()        # readings already here stay here: only new ones go to this account
        self.config.set(device_token=j["token"], account_name=j.get("display_name", ""))
        self._device_code = ""
        with self.lock:
            self.pair_code = self.pair_url = ""
        self.sync_problem = 0
        print("GeneSense: signed in as %s" % self.account_name)
        self._event("signed_in")

    def _check_account(self):
        code, j = self.request("GET", "/api/devices/me", token=self.config.get("device_token"))
        if code == 200 and j.get("display_name") and j["display_name"] != self.account_name:
            self.config.set(account_name=j["display_name"])
        elif code == 401:
            print("GeneSense: this device was disconnected from the account")
            self._forget()
            self._event("revoked")

    def _sync_one(self):
        if time.time() < self._pause_until:
            return
        item = self.history.next_unsent()
        if not item:
            return
        fresh = time.time() - item.get("added", 0) < 15 * 60
        if not item["t"] and not fresh:      # no time and not just measured: the server could not date it
            self.history.mark(item, local=True)
            return
        body = {"heart_rate": item["hr"], "spo2": item["spo2"],
                "client_id": reading_id(item["t"], item["hr"], item["spo2"], item.get("added", 0))}
        if item["t"]:
            body["measured_at"] = item["t"]
        code, j = self.request("POST", "/api/devices/readings", body, token=self.config.get("device_token"))
        if code == 401:
            self._forget()
            self._event("revoked")
        elif code in (201, 422):             # saved, or refused for good (e.g. a bad time): do not send again
            self.history.mark(item, sent=(code == 201), local=(code == 422))
            self.sync_problem = 0
            if code == 201:
                print("GeneSense: saved %d bpm, SpO2 %d%%" % (item["hr"], item["spo2"]))
                self._event("saved")
            else:
                print("GeneSense: reading refused: %s" % j)
        else:
            self.sync_problem = code         # 409 = the profile is not finished
            self._pause_until = time.time() + (600 if code == 409 else 60)
            print("GeneSense: sending failed (HTTP %d), trying again later" % code)
