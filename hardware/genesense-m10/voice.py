"""Vietnamese voice: made once by Gemini text-to-speech, saved as WAV files, played on a USB speaker.

The M10 has only a buzzer, so the voice needs a USB speaker (or a USB sound card with a small amplifier).
Until the clips exist, or without a speaker, short buzzer tunes play instead.
"""
import base64
import hashlib
import json
import os
import queue
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
VOICE_DIR = os.path.join(HERE, "data", "voice")
TTS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions"
TTS_MODELS = ["gemini-3.8-flash-lite-tts", "gemini-3.8-flash-tts"]
VOICE = "Kore"
STYLE = "Calm, warm and clear, a little slow, speaking kindly to an older person; natural standard Vietnamese pronunciation."

CLIPS = {
    "welcome": "Xin chào. Chạm vào màn hình hoặc bấm nút A để bắt đầu đo.",
    "place": "Hãy đeo cảm biến vào đầu ngón tay, rồi giữ yên tay.",
    "start": "Bắt đầu đo. Hãy giữ yên tay và thở đều.",
    "hold": "Giữ yên tay nhé. Máy sẽ đo lại từ đầu.",
    "done": "Đo xong rồi. Kết quả đang được lưu vào hồ sơ của bạn.",
    "check": "Có chỉ số cần chú ý. Hãy ngồi nghỉ rồi đo lại.",
    "emergency": "Chỉ số ở mức nguy hiểm. Hãy đo lại ngay. Nếu thấy khó thở hoặc mệt lả, hãy gọi cấp cứu một một năm.",
    "nofinger": "Chưa đọc được ngón tay. Hãy đeo lại cảm biến cho vừa khít.",
    "unstable": "Số đo chưa ổn định. Hãy ngồi yên, thả lỏng tay, rồi đo lại.",
    "remind": "Đã đến giờ đo. Chạm vào màn hình để bắt đầu đo.",
    "medicine": "Đến giờ uống thuốc. Uống xong, hãy chạm nút Đã uống.",
    "login": "Hãy đăng nhập. Dùng điện thoại có ứng dụng GeneSense để quét mã trên màn hình.",
}
# buzzer tunes while there is no voice: (frequency, ms) pairs
TUNES = {"beep": [(880, 140)], "ok": [(660, 120), (990, 200)], "err": [(520, 150), (390, 250)], "tick": [(1400, 40)],
         "alarm": [(1050, 260), (760, 260)] * 3}
FALLBACK = {"medicine": "ok", "emergency": "alarm", "done": "ok", "hold": "err", "check": "err", "nofinger": "err", "unstable": "err"}


def clip_path(name):
    h = hashlib.sha1((VOICE + "|" + CLIPS[name]).encode()).hexdigest()[:12]
    return os.path.join(VOICE_DIR, "%s_%s.wav" % (name, h))


class Voice:
    def __init__(self, board, gemini_key, volume=0.8):
        self.board = board
        self.key = gemini_key
        self.volume = volume
        self.night = False                   # set by the app: quieter in a dark room at night
        self.problem = 0                     # last HTTP problem making clips, -1 = no connection, 401 = wrong key
        self.making = False
        self.speaker = False                 # the sound system started (the speaker itself is usb_card())
        self._q = queue.Queue()
        self._mixer_tried = 0.0
        os.makedirs(VOICE_DIR, exist_ok=True)
        threading.Thread(target=self._player, daemon=True).start()

    def ready_count(self):
        return sum(1 for n in CLIPS if os.path.exists(clip_path(n)))

    def say(self, name, cut=False):          # a clip name or a tune name
        if cut:
            try:
                while True:
                    self._q.get_nowait()
            except queue.Empty:
                pass
            self._stop_sound()
        self._q.put(name)

    def idle(self):
        return self._q.empty() and not self._busy

    # ---------- playing ----------
    _busy = False
    _channel = None

    def _mixer(self):
        if self.speaker:
            return True
        if time.time() - self._mixer_tried < 20:   # a speaker may be plugged in later: try again now and then
            return False
        self._mixer_tried = time.time()
        try:
            card = usb_card()
            if card is not None:
                _use_usb_output(card)
            os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
            import pygame
            pygame.mixer.init()
            self._pg = pygame
            self.speaker = True
            print("Voice: sound ready")
        except Exception as e:
            print("Voice: no sound yet (%s)" % e)
        return self.speaker

    def _stop_sound(self):
        if self._channel is not None:
            try:
                self._channel.stop()
            except Exception:
                pass

    def _player(self):
        while True:
            name = self._q.get()
            self._busy = True
            try:
                if name in CLIPS and os.path.exists(clip_path(name)) and usb_card() is not None and self._mixer():
                    snd = self._pg.mixer.Sound(clip_path(name))
                    snd.set_volume(self.volume * (0.5 if self.night else 1.0))
                    self._channel = snd.play()
                    while self._channel is not None and self._channel.get_busy():
                        time.sleep(0.05)
                else:
                    for freq, ms in TUNES.get(FALLBACK.get(name, name), TUNES["beep"]):
                        self.board.tone(freq, ms)
            except Exception as e:
                print("Voice: %s" % e)
            self._busy = False
            time.sleep(0.12)

    # ---------- making the clips (once, needs Wi-Fi and a Gemini key) ----------
    def start_making(self):
        if self.making or not self.key or self.ready_count() == len(CLIPS):
            return
        self.making = True
        threading.Thread(target=self._make_all, daemon=True).start()

    def _make_all(self):
        for _ in range(40):                  # about 2 hours of tries at most
            missing = [n for n in CLIPS if not os.path.exists(clip_path(n))]
            if not missing or self.problem == 401:
                break
            for name in missing:
                if self._make(name):
                    self.problem = 0
                elif self.problem == 401:
                    break
                time.sleep(7)                # the free tier allows only a few requests a minute
            if any(not os.path.exists(clip_path(n)) for n in CLIPS) and self.problem != 401:
                time.sleep(180)
        self.making = False

    def _make(self, name):
        for model in TTS_MODELS:
            body = {"model": model, "store": False,
                    "input": [{"type": "user_input", "content": [{"type": "text", "text": CLIPS[name],
                                                                    "annotations": [{"type": "speech_metadata", "style": STYLE}]}]}],
                    "response_format": {"type": "audio", "mime_type": "audio/wav", "sample_rate": 16000},
                    "generation_config": {"speech_config": [{"voice": VOICE}]}}
            req = urllib.request.Request(TTS_URL, data=json.dumps(body).encode(), method="POST")
            req.add_header("Content-Type", "application/json")
            req.add_header("x-goog-api-key", self.key)
            try:
                with urllib.request.urlopen(req, timeout=90) as r:
                    reply = json.loads(r.read().decode())
            except urllib.error.HTTPError as e:
                text = e.read().decode(errors="replace")[:300]
                print("Voice %s with %s: HTTP %d %s" % (name, model, e.code, text))
                self.problem = 401 if (e.code in (401, 403) or "API key not valid" in text) else e.code
                if self.problem == 401:
                    return False
                continue
            except (urllib.error.URLError, OSError, ValueError) as e:
                print("Voice: no connection (%s)" % e)
                self.problem = -1
                return False
            audio = None
            for step in reply.get("steps", []):
                for part in step.get("content", []) or []:
                    if part.get("type") == "audio" and part.get("data"):
                        audio = part["data"]     # the last audio block is the answer
            if not audio:
                print("Voice %s: no audio in the answer" % name)
                continue
            data = base64.b64decode(audio)
            if data[:4] != b"RIFF":          # raw 16-bit audio: add a WAV header
                data = _wav_header(len(data), 24000) + data
            tmp = clip_path(name) + ".tmp"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, clip_path(name))
            print("Voice %s saved (%d KB)" % (name, len(data) // 1024))
            return True
        return False


def usb_card():
    """(number, name) of a USB sound card (USB speaker, DFPlayer Pro in sound-card mode, USB dongle), or None.
    The M10's own sound chip has no speaker, so without one of these the buzzer is used."""
    try:
        with open("/proc/asound/cards") as f:
            for line in f:
                if "USB-Audio" in line or "USB Audio" in line:
                    parts = line.split("]:", 1)
                    num = line.split("[", 1)[0].strip()
                    name = parts[1].split(" - ", 1)[-1].strip() if len(parts) > 1 else "USB"
                    return int(num), name
    except (OSError, ValueError):
        pass
    return None


def _use_usb_output(card):
    """Send the sound to the USB card: make it PulseAudio's default output, or open it straight through ALSA."""
    import subprocess
    try:
        out = subprocess.run(["pactl", "list", "sinks", "short"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             universal_newlines=True, timeout=5).stdout
        for line in out.splitlines():
            parts = line.split()
            if len(parts) > 1 and "usb" in parts[1].lower():
                subprocess.run(["pactl", "set-default-sink", parts[1]], timeout=5)
                print("Voice: sound goes to %s" % parts[1])
                return
    except (OSError, subprocess.SubprocessError):
        pass
    os.environ["SDL_AUDIODRIVER"] = "alsa"          # no PulseAudio: open the card directly
    os.environ["AUDIODEV"] = "plughw:%d,0" % card[0]
    print("Voice: sound goes to ALSA card %d" % card[0])


def _wav_header(n, rate):
    import struct
    return (b"RIFF" + struct.pack("<I", 36 + n) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) +
            b"data" + struct.pack("<I", n))
