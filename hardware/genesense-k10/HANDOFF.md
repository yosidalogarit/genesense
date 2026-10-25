# Handoff: GeneSense K10 measuring device

Written 25 October 2026 for the next Claude agent. The owner confirmed on 25 October 2026 that **everything in this folder works on the real device**. Read section 5 before changing power, Wi-Fi or sleep code: each item there broke the device once.

## 1. What this is

A home measuring device for GeneSense on a DFRobot **UNIHIKER K10** (ESP32-S3 N16R8, 240×320 screen, speaker, buttons A/B, RGB LEDs, accelerometer, LTR303 light sensor, microphones, camera, microSD slot). It measures heart rate and SpO₂ with a real sensor, guides older Vietnamese users by screen and voice, and **signs in to a GeneSense account** so every reading goes to that person's profile (also Bluetooth and a QR link). **It is a test device, not a medical device**; the screen says so on every page.

## 2. Files

| File | What |
|---|---|
| `genesense_k10/genesense_k10.ino` | The sketch (one file). Settings at the top. |
| `genesense_k10/gs_fonts.h` | Be Vietnam Pro (the app's font) as 4-bit anti-aliased glyph tables. Generated; do not edit by hand. |
| `genesense_k10/OFL.txt` | The font's licence (SIL OFL 1.1). Keep it next to the font. |
| `tools/genfonts.py` | Makes `gs_fonts.h` from the Be Vietnam Pro TTFs (Pillow): `python genfonts.py <folder with BeVietnamPro-*.ttf> gs_fonts.h`. Sizes and character sets are at the top of the script. |

The owner keeps a working copy in their Arduino folder. **Never put a Gemini key or Wi-Fi password in this repository**: the key is typed into the device (sketch setting or phone setup page) and saved in its flash.

## 3. Hardware and wiring

| Part | Port | Notes |
|---|---|---|
| DFRobot **SEN0518** (MAX30102 + its own processor) | I2C (Gravity, left/A-B edge) | Switch on the sensor set to **I2C**. Address **0x57**. Write `0x20 0x00 0x01` to start; read 8 bytes from register `0x0C`: byte 0 = SpO₂, bytes 2–5 = heart rate (big-endian). New values about every 4 s. It sends **no raw pulse wave**, so HRV, breathing rate or blood-pressure estimates are impossible with it. |
| DFRobot **DFR0789** green LED latching button | **P0** (GPIO1) | Now the **on/off switch** (`GREEN_ON_LEVEL 1`: reads 1 when latched on and lit). |
| 3×AA holder (FIT0619) | BAT IN | Use **alkaline** cells. Zinc "heavy duty" cells brown out and the board restarts or squeals. |

The screen has its own SPI bus (FSPI: SCK 12, MOSI 21, CS 14). The **microSD slot is on a second bus**, `SPI1` (HSPI: SCK 44, MISO 41, MOSI 42, card CS **40**), shared with the board's font chip; mount it with `SD.begin(40, SPI1, 20000000, "/sd")` after `k10.begin()`. The card must be FAT32. Counting free space on a big card is slow, so the sketch reads it once at start.

## 4. Arduino setup

Board package "unihiker" (`https://downloadcd.dfrobot.com.cn/UNIHIKER/package_unihiker_index.json`), board **unihiker k10**, PSRAM **OPI PSRAM**, partition **16M Flash (3MB APP/9.9MB FATFS)**, **Model: None** (other Model choices overwrite flash data on every upload), **USB CDC On Boot: Enabled** (Serial Monitor). Libraries: Adafruit GFX (the K10 package brings TFT_eSPI). U8g2 is **no longer** needed.

## 5. Root causes found the hard way (do not reintroduce)

1. **`WiFi.setSleep(false)` restarts the board** whenever Bluetooth is on. The Wi-Fi library aborts with "Should enable WiFi modem sleep when both WiFi and Bluetooth are enabled". Leave modem sleep on.
2. **`Serial.flush()` hangs forever without a computer** on the USB port (USB CDC On Boot = Enabled; `HWCDC::flush` has no timeout). It froze the device on power banks and batteries. Never call it.
3. **Power off is a standby loop, not deep sleep.** The green button only sends a signal; it cannot cut power. "Off" turns off the screen light, speaker amplifier, LEDs, Wi-Fi and Bluetooth, drops the CPU to 80 MHz and polls the button; "on" calls `esp_restart()`. Deep sleep with an ext0 wake was unreliable.
4. **Turn the speaker amplifier off (`digital_write(eAmp_Gain, 0)`) before going quiet**, after stopping I2S. Otherwise it amplifies noise and screams.
5. **Saving voice clips:** the `voice_data` FAT partition does not exist with every board package or partition choice. Storage tries, in order: microSD (if added later), FAT `voice_data`, FAT `ffat`, LittleFS `model`, LittleFS `spiffs`, then memory only (clips are made again after power-off; the screen says "Sẵn sàng (tạm)"). The Serial Monitor lists the flash parts at start.
6. **Gemini key:** a key in `GEMINI_KEY` is saved to flash (Preferences namespace `gsk10`, key `gkey`); later sketches with `""` keep using it. It can also be typed on the phone setup page. The voice row shows exactly what is missing ("Chưa có khóa", "Khóa sai", "Chờ Wi-Fi"…).
7. **Two tasks share the history and account texts:** take `histLock` around any change to `hist`, `pairCode`/`pairUrl`/`deviceToken`/`accountName`; the screen code uses `signedIn` and `accountText()`. Only one TLS connection at a time (`tlsLock`): two at once do not fit next to Bluetooth.
8. **Gemini TTS** uses the Interactions API (`POST /v1beta/interactions`, model `gemini-3.8-flash-lite-tts` then `gemini-3.8-flash-tts`, input as a `user_input` step, `response_format` WAV 16 kHz). The answer's audio is the longest `"data"` string. Both models are on the free tier.
9. **Wi-Fi setup by QR:** stop the saved Wi-Fi's auto-reconnect while the setup network is up, or the radio hops channels and phones cannot join.

## 6. What the sketch does (25 October 2026)

- **Sign-in first.** Until the device is linked to an account, every screen leads to "Đăng nhập": step 1 Wi-Fi (A opens the phone setup), then a QR code and an 8-character code. Scanning opens `GENESENSE_URL/#ket-noi-may?ma=CODE`; the person, signed in to GeneSense on the phone, taps "Kết nối" (or types the code in Hồ sơ → Máy đo GeneSense). The device asks every 5 s, gets its own token, saves it with the account name (Preferences `dtok`, `dname`) and shows "Xin chào, <name>". A new code comes every 10 minutes, or with A.
- **Sync.** A background task (`cloudTask`, core 0) sends each finished, non-mock reading to `POST /api/devices/readings` (Bearer token, `X-Requested-With: HealthPredict`). History flags: `REC_MOCK` 1, `REC_SENT` 2, `REC_LOCAL` 4 (taken before this account was linked, or without a clock and not just measured). The id is the same SHA-256 as the app's device link, so a reading also saved through the QR link counts once. It checks the account every 30 minutes (`GET /api/devices/me`); a 401 forgets it and goes back to sign-in. Menu → Đăng xuất (press A twice) tells the server (`DELETE /api/devices/me`) and forgets the account. One TLS connection at a time (`tlsLock`, shared with the voice task); the voice waits while the sign-in screen is up.
- Guided 30 s measurement (8 s settle, outlier rejection, restart when the board moves), result cards with the app's range bars and status shapes, emergency screen ("Gọi cấp cứu 115") with the app's limits. "Đã lưu vào hồ sơ GeneSense" appears when the reading reached the profile.
- Home screen rows: Cảm biến, Bluetooth ("Đã kết nối" / "Chưa kết nối"), Wi-Fi (the network name, or "Chưa kết nối"), Tài khoản (the name), and Giọng nói only while the voice is not ready.
- Bluetooth: standard Heart Rate (0x180D) and Pulse Oximeter (0x1822); the final value is sent five times because the app averages five.
- History of the last 100 results in flash with two charts; QR link into the GeneSense app (`#nhap-may-do?hr=&spo2=&t=`); local results page; Wi-Fi setup from a phone by QR code (with an optional Gemini key field).
- **microSD:** every finished measurement goes to `/GeneSense/measurements.csv` (time, Unix time, heart rate, SpO₂, mock); voice clips live in `/GeneSense/voice` when a card is present (first choice of storage). The web page offers the CSV.
- **Reminders:** up to 3 daily times set on the device web page (`/settings`, Preferences `rem0`–`rem2`). At the time (within 30 minutes, needs the Wi-Fi clock): the "Đến giờ đo" screen, the voice up to 3 times a minute apart and a blue blinking LED; A measures, B snoozes 10 minutes; skipped if measured in the last hour.
- **Menu → Thông tin máy:** card, saved readings, account, sending status ("Cần hoàn thành hồ sơ" when the server answers 409), voice, reminder times, web address.
- In a dark room at night (light sensor) the voice and beeps play at half volume.
- Vietnamese voice made once by Gemini and saved; beeps until then.
- UI in the app's design language: light theme, Be Vietnam Pro, white cards, blue buttons, circle/triangle/octagon status marks, amber "THIẾT BỊ THỬ NGHIỆM" strip. The device web page uses the same light design.
- **Removed on the owner's request (25 October 2026):** body temperature (DS18B20) and room temperature/humidity (AHT20), with their Bluetooth services. Do not add them back without asking.
- Compiled and previewed on a PC; the sign-in and sync need the server change to be merged and deployed before they work on the device.

## 7. Shell (3D print)

Designed in Claude Design (OpenSCAD), printed in PLA on the owner's Anycubic Kobra S1 Combo with ACE Pro. The first fit test did not fit; the measured fixes (screen glass 49 × 69 mm starting 14 mm below the top edge, USB-C far edge 29 mm from the ESP32 side, Reset/Boot on the back, bosses outside the board outline, cable pockets lower) were sent back to Claude Design. Screws: M2.5 × 8 mm self-tapping for plastic.
