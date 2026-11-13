# GeneSense M10 measuring device

Written 11 November 2026. The owner is moving the GeneSense device from the UNIHIKER K10 (`../genesense-k10/`) to a DFRobot **UNIHIKER M10**: Linux, a touch screen, and smaller because the green LED button is gone. **Status: written and tested on a PC only** (screens drawn headless, measuring logic run with mock values, sign-in and upload tested against a local GeneSense server). It has **not yet run on the real M10**; check section 6 first when it does.

It is a test device, not a medical device; every screen says so.

## 1. What it does

- Measures heart rate and SpO₂ with the **SEN0518** (30 s, the first 8 s ignored, a sample every 4 s, odd readings dropped, median shown). It uses the M10's motion sensor to ask the user to hold still. Without the sensor it uses clearly labelled mock values.
- Uses the same limits and words as the GeneSense app. SpO₂ < 90 % or heart rate < 40 / > 150 is danger: a red screen saying "Gọi cấp cứu 115", an alarm and a spoken warning.
- **Sign-in is required** on first start. It shows a QR code and the code `ABCD 2345`; the phone app approves it. Every real reading then goes to that person's GeneSense profile. Readings taken before sign-in, mock readings and readings without a clock stay on the device. The server API is the same as the K10's (`backend/app/devices.py`).
- History charts (last 14), reminders to measure (3 times a day, set by touch), and a CSV log on the microSD card (`GeneSense/measurements.csv`, else in `data/`).
- **Độ sáng** (menu): screen brightness 10–100 % with −/+ or a touch on the bar, set with the M10's own **`brightness 0-100` command** (UNIHIKER FAQ; the M10 has no `/sys/class/backlight`, which the first version used, so it did nothing). The command runs in a background thread. Changing it fast **froze the whole M10** (11 November 2026), probably because the command and the program's pinpong polling used the co-processor link at the same time. Now the level is applied only 0.7 s after the last tap and at most every 1.5 s, and the command holds `Board.io`. That lock now guards **every** pinpong call (buttons, motion, light, buzzer, SEN0518), which pinpong needs anyway: the voice thread's buzzer and the screen loop used to talk to it at the same time, a likely cause of the old "Thử loa" crash too. The M10 resets brightness at restart, so the program sets the saved level from `data/config.json` at start.
- **Medicine reminders** (13 November 2026). The device reads today's medicines from the app's "Thuốc" list.
  - **API:** `GET /api/devices/medications?day=` with the device token (backend/app/main.py). The list is fetched every 10 minutes and cached in the config, so it also works without Wi-Fi.
  - **Times:** the app only stores Sáng/Trưa/Chiều/Tối, so the clock times live on the device (`MED_TIMES`, default 07:00 / 11:30 / 17:00 / 20:00). Change them in Menu → Thuốc by tapping a row.
  - **The reminder:** within 2 hours of a time, if a medicine is not ticked, the "Đến giờ uống thuốc" screen shows the medicines with their dose and "trước/sau ăn", plus a voice clip. It asks at most 3 times; "Để sau" waits 10 minutes.
  - **Ticking:** "Đã uống" ticks them in the app (`PUT /api/devices/medications/{id}/intakes/{slot}`). Ticks are queued (`intake_queue`) and retried until the server answers.
- **Measuring tolerance and ghost readings** (13 November 2026; the owner found that slight movement reset the whole measurement).
  - **Movement:** the motion check is smoothed over 1 s and must stay above `MOVE_LIMIT` (0.35 g, was 0.15) for `MOVE_SECONDS` (0.8 s), so bumps and a shaky hand are ignored.
    - Real movement now **pauses** the count for 2.5 s and drops only the readings from the last 4 s; it no longer starts over.
    - The "still" position follows slow tilts.
    - The measurement gives up after 8 pauses.
  - **Finger off:** it takes `LIFT_SECONDS` (8 s, was 4) without a good reading before the screen goes back to "Đeo cảm biến". Shorter drop-outs only pause.
  - **Ghost heart rates:** the SEN0518 sometimes reports 150–220 bpm when the finger shifts.
    - Each new reading is compared with the average of the ones kept, and one further than `GHOST_LIMIT` (20 %, at least 15 bpm) is left out ("bỏ N số lạ" on screen).
    - If 3 left-out readings in a row agree with each other, the first ones were the odd ones, so the average starts again from those 3. A real, steady high rate therefore still reaches the emergency screen.
    - The final value is the median of the readings within 15 % of the middle.
    - With fewer than 4 good readings at the end, it measures up to 24 s longer ("Đo thêm một chút...").
  - **Tested** with a simulated sensor and motion: clean, ghost spikes, ghosts at the start, a 4 s finger slip, one bump, 2 s of movement, a shaky hand, a real 158 bpm (shows the emergency screen).
- **Finger detection** (13 November 2026; the owner found it slow, saw it "find" a finger when nothing was there, and found it still too sensitive to movement).
  - **Fresh start per measurement:** each measurement restarts the SEN0518 (`0x20 [0,2]` stop, then `[0,1]` start, as in DFRobot's library). It is stopped again when the measuring screens close, so its red light is off between measurements.
  - **Old numbers are ignored:** the sensor keeps showing its last numbers after the finger leaves. The program remembers what it shows at the start and treats those numbers as no finger until they change. Numbers that stay exactly the same for 20 s are also treated as no finger.
  - **Faster:** counting begins at the first new, valid reading, instead of 2 readings plus 2.5 s.
  - **Movement:** the M10's motion sensor measures the M10, not the finger, so the check (`MOVE_CHECK`) now only reacts to the M10 being picked up or shaken: 0.6 g for 1.5 s. Finger movement is handled by leaving out ghost readings.
  - **Tested** in simulation: old numbers with no finger (it times out instead of measuring), a finger after 3 s (counting starts 0.4 s after its first reading), the M10 held in a moving hand (no pause), and the M10 picked up for 3 s (one pause).
- **Clock and screen sleep.** After `CLOCK_AFTER` (45 s) without a touch, a resting screen becomes a big clock. It shows the date, the next medicine, the next measuring reminder and the last reading.
  - After `SLEEP_AFTER` (120 s) the backlight drops to `SLEEP_LEVEL` (10 %). The first touch or button press only wakes the screen.
  - Reminders, medicines and emergencies wake it themselves.
  - At night in a dark room the screen is at most `NIGHT_LEVEL` (40 %) bright.
  - Measuring, editing and sign-in screens never sleep.
- **Trend chart.** "Biểu đồ" on the result screen opens "Xu hướng": one card each for heart rate and SpO₂ over the last 7 days.
  - Each card shows the daily averages as a line on the app's green safe band, with a dashed line for the average of the earlier days ("TB").
  - Today's reading is drawn in the app's level shape and colour with its value, and the day names run underneath.
  - A plain phrase in the corner says "Như thường lệ", "Cao hơn 6" or "Thấp hơn 2%".
- **Menu changes:** the tiles are now Lịch sử, Nhắc đo, Thuốc, Độ sáng, Thông tin, Đăng xuất. "Xóa hết" (clear history) moved to the Thông tin screen.
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
| `tools/autostart.sh` | Start at power-on as a systemd service: `install`, `remove`, `status`, `log`. |

`data/` is created on the device and is git-ignored. **Never commit a Gemini key or a device token.**

## 3. Hardware

| Part | Where | Notes |
|---|---|---|
| UNIHIKER M10 | | RK3308 (aarch64), Debian 10, **Python 3.7**, 240×320 touch screen, buttons A/B, buzzer, accelerometer, light sensor, Wi-Fi + BT, USB-A host port, microSD. The GD32 co-processor runs the Gravity ports; pinpong talks to it. |
| DFRobot **SEN0518** | 4-pin **Gravity I2C** port | Switch on the sensor set to **I2C**, address 0x57. Linux sees the port as `/dev/i2c-4`; the program uses pinpong `I2C(bus_num=4)`. |
| Speaker | **USB-A** | The M10 has only a buzzer. The owner has **FIT0502** (passive stereo 3 W 8 Ω speakers, PH2.0), which need an amplifier, so they plan to use the **DFPlayer Pro** (DFR0768) as a USB sound card. **Not confirmed** that it shows up as one. If it doesn't, use any USB sound dongle with a PAM8403 amplifier board (5 V) driving the FIT0502. `voice.usb_card()` reads `/proc/asound/cards`, then makes the USB card PulseAudio's default output (`pactl set-default-sink`), or opens it through ALSA when PulseAudio is missing. The menu's "Thử loa" button was removed (11 November 2026): pressing it **crashed the whole M10**, cause not found (no log yet; suspects: the buzzer or pygame/PulseAudio started from the voice thread). If voice playback crashes the device the same way once a USB speaker is in, get the console output first. |

## 4. Putting it on the M10

1. Connect the M10 to a computer with USB-C. It appears as network address **10.1.2.3**.
2. Open `http://10.1.2.3` in a browser, open the network settings, and join the home Wi-Fi.
3. Copy the whole `genesense-m10` folder to `/root/genesense-m10` on the M10. Any of these works:
   - Windows Explorer `\\10.1.2.3`
   - the web page's file upload
   - `scp -r genesense-m10 root@10.1.2.3:/root/` (the M10's default password is `dfrobot`)
4. In the M10's copy of `genesense.py`, set `GEMINI_KEY = "..."`. The key is saved in `data/config.json` on the first run, after which the line can go back to `""`.
5. Run it from the M10's own menu (Run Programs → root → genesense-m10 → genesense.py), or over SSH with `cd /root/genesense-m10 && python3 genesense.py`. The console shows sensor values, sign-in and upload lines.
6. **Start at power-on.** The M10 menu's "Auto boot" did **not** work for the owner (11 November 2026): after a power cycle the default UNIHIKER screen came back. Use the systemd service instead. Over SSH, run `sh /root/genesense-m10/tools/autostart.sh install`, turn Auto boot off, then restart. The service waits for X (`/tmp/.X11-unix/X0`) and 4 s more, runs with `DISPLAY=:0`, and restarts the program if it crashes. Use `... remove` to undo it, `status` to check it, and `log` to read the output.
   - **Making start-up robust (in the program itself):**
     - `tk.Tk()` is retried for 90 s while the screen is not ready, and pinpong `begin()` 3 times.
     - The window is kept on top of the UNIHIKER menu (`-topmost`, re-raised every 3 s).
     - A lock file (`data/genesense.lock`) allows only one copy, because two copies would fight over the co-processor.
     - Everything printed also goes to `data/genesense.log` (kept under 512 KB).
   - **Not yet confirmed on the device:** whether Auto boot failed because the program crashed at boot, or because the menu covered its window.

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
