# GeneSense M10 measuring device

Written 11 November 2026. The owner is moving the GeneSense device from the UNIHIKER K10 (`../genesense-k10/`) to a DFRobot **UNIHIKER M10**: Linux, a touch screen, and smaller because the green LED button is gone. **Status: written and tested on a PC only** (screens drawn headless, measuring logic run with mock values, sign-in and upload tested against a local GeneSense server). It has **not yet run on the real M10**; check section 6 first when it does.

It is a test device, not a medical device; every screen says so.

## 1. What it does

- Measures heart rate and SpO₂ with the **SEN0518** (30 s, the first 8 s ignored, a sample every 4 s, odd readings dropped, median shown). It uses the M10's motion sensor to ask the user to hold still. Without the sensor it uses clearly labelled mock values.
- Uses the same limits and words as the GeneSense app. SpO₂ < 90 % or heart rate < 40 / > 150 is danger: a red screen saying "Gọi cấp cứu 115", an alarm and a spoken warning.
- **Sign-in is required** on first start. It shows a QR code and the code `ABCD 2345`; the phone app approves it. Every real reading then goes to that person's GeneSense profile. Readings taken before sign-in, mock readings and readings without a clock stay on the device. The server API is the same as the K10's (`backend/app/devices.py`).
- History charts (last 14), reminders to measure (3 times a day, set by touch), and a CSV log on the microSD card (`GeneSense/measurements.csv`, else in `data/`).
- **Voice:** Vietnamese clips made once by Gemini TTS (needs a Gemini key and Wi-Fi), played on a **USB** sound device. Without one, the buzzer plays short tunes. The voice is quieter in a dark room at night.
- Touch everywhere. Bottom buttons are 46 px tall and 12 px apart, and sub-screens have a back arrow in the header. Buttons **A/B** on the side do the same as the two bottom buttons. The menu is 6 tiles: B moves through them (and "Về"), A opens. Screens slide in (forwards from the right, back from the left), a pressed button darkens briefly, and messages slide in.
- Redesigned 11 November 2026 at the owner's request ("buttons too small and too close", match the web and app design).

## 2. Files

| File | What |
|---|---|
| `genesense.py` | Main program: settings at the top, screens, measuring, reminders, the tkinter window. |
| `ui.py` | Drawing in the app's design language: the soft blue glow background, the pale blue header with a back arrow, white cards with gradient and shadow, 46 px touch buttons 12 px apart, menu tiles with line icons, and the screen slide and touch-flash animations. Drawn at 2× and scaled down; uses only Pillow 5.4 features. |
| `device.py` | Buttons, buzzer, motion and light sensors (pinpong) and the SEN0518 on I2C bus 4. Mocks off the board. |
| `cloud.py` | GeneSense sign-in and upload in a background thread. |
| `store.py` | `data/config.json` (account token, Gemini key, reminders), `data/history.json`, and the CSV log. |
| `voice.py` | Gemini TTS clips in `data/voice/`, playback, and picking the USB sound card. |
| `fonts/` | Be Vietnam Pro TTFs + `OFL.txt` (keep the licence with the fonts). |
| `tools/preview.py` | Draws every screen to PNGs on a PC: `python3 tools/preview.py out/`. |

`data/` is created on the device and is git-ignored. **Never commit a Gemini key or a device token.**

## 3. Hardware

| Part | Where | Notes |
|---|---|---|
| UNIHIKER M10 | | RK3308 (aarch64), Debian 10, **Python 3.7**, 240×320 touch screen, buttons A/B, buzzer, accelerometer, light sensor, Wi-Fi + BT, USB-A host port, microSD. The GD32 co-processor runs the Gravity ports; pinpong talks to it. |
| DFRobot **SEN0518** | 4-pin **Gravity I2C** port | Switch on the sensor set to **I2C**, address 0x57. Linux sees the port as `/dev/i2c-4`; the program uses pinpong `I2C(bus_num=4)`. |
| Speaker | **USB-A** | The M10 has only a buzzer. The owner has **FIT0502** (passive stereo 3 W 8 Ω speakers, PH2.0), which need an amplifier, so they plan to use the **DFPlayer Pro** (DFR0768) as a USB sound card. **Not confirmed** that it shows up as one. If it doesn't, use any USB sound dongle with a PAM8403 amplifier board (5 V) driving the FIT0502. `voice.usb_card()` reads `/proc/asound/cards`, then makes the USB card PulseAudio's default output (`pactl set-default-sink`), or opens it through ALSA when PulseAudio is missing. Menu → **Thử loa** tests it. |

## 4. Putting it on the M10

1. Connect the M10 to a computer with USB-C. It appears as network address **10.1.2.3**.
2. Open `http://10.1.2.3` in a browser, open the network settings, and join the home Wi-Fi.
3. Copy the whole `genesense-m10` folder to `/root/genesense-m10` on the M10. Any of these works:
   - Windows Explorer `\\10.1.2.3`
   - the web page's file upload
   - `scp -r genesense-m10 root@10.1.2.3:/root/` (the M10's default password is `dfrobot`)
4. In the M10's copy of `genesense.py`, set `GEMINI_KEY = "..."`. The key is saved in `data/config.json` on the first run, after which the line can go back to `""`.
5. Run it from the M10's own menu (Run Programs → root → genesense-m10 → genesense.py), or over SSH with `cd /root/genesense-m10 && python3 genesense.py`. The console shows sensor values, sign-in and upload lines.
6. **Start at power-on:** turn on "Auto boot" in the M10 menu's service settings, which runs the last program at start.

pinpong, Pillow, qrcode, pygame and tkinter all come with the M10 image (the `unihiker` library itself uses them), so nothing needs installing.

## 5. Settings (top of `genesense.py`)

| Setting | Meaning |
|---|---|
| `GENESENSE_URL` | Server and app link; the `GENESENSE_URL` environment variable overrides it (used for local tests). |
| `DEVICE_NAME` | Name shown in the app's device list. |
| `MEASURE_SECONDS`, `SETTLE_SECONDS`, `MOCK_SECONDS` | Measurement timing. |
| `MOVE_LIMIT` | How much the M10 may move during a measurement, in g (default 0.15). |
| `VOICE_VOLUME`, `TIMEZONE` | Volume 0.1–1.0; `Asia/Ho_Chi_Minh`. |

## 6. Check on the real device (not yet confirmed)

- pinpong `Board("UNIHIKER").begin()` then `I2C(bus_num=4)`: does `scan()` list 0x57 with the SEN0518 plugged in?
- Accelerometer values in g (`_ax/_ay/_az` after `get_alldata()`): does 0.15 g feel right, or is it too strict?
- Touch: tkinter `<Button-1>` coordinates should match the 240×320 picture. The window is undecorated and has no cursor.
- The Wi-Fi name comes from `iwgetid -r`, then `wpa_cli -i wlan0 status`, then `nmcli`. If the home screen shows "Chưa kết nối" while Wi-Fi works, check which of those exists.
- The clock: the M10 has no clock battery, so times are right only after Wi-Fi time sync. A reading taken before that has no time: it is sent without one (the server uses "now") if it goes out within 15 minutes, otherwise it stays on the device.
- The DFPlayer Pro as a USB sound card. Test with `cat /proc/asound/cards`, `aplay -l` and `speaker-test -c 2 -t wav`.
- How fast the screen redraws. Each frame is drawn at 480×640 and scaled down with BOX. Cards, buttons, the background and every text are rendered once and cached, which makes a frame about 4 ms on a PC (roughly 30–40 ms expected on the RK3308). Moving screens aim for 8–10 frames a second, and the loop draws less often by itself if frames get slow (`FRAME_EVERY` and `cost` in `run_tk`).

## 7. Not done (on purpose, for now)

- **Bluetooth link to the phone:** the K10 had one; the M10 port is Wi-Fi only, so the home screen has no Bluetooth row.
- Setting up Wi-Fi from the device itself; it is done on the 10.1.2.3 page.
- Temperature and humidity: the owner removed them on the K10 ("too bloated"). Do not add them back without asking.
