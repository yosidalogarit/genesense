# Handoff: GeneSense K10 measuring device

Written 25 October 2026 for the next Claude agent. The owner confirmed on 25 October 2026 that **everything in this folder works on the real device**. Read section 5 before changing power, Wi-Fi or sleep code: each item there broke the device once.

## 1. What this is

A home measuring device for GeneSense on a DFRobot **UNIHIKER K10** (ESP32-S3 N16R8, 240×320 screen, speaker, buttons A/B, RGB LEDs, accelerometer, AHT20 temperature/humidity, LTR303 light sensor, microphones, camera, microSD slot). It measures heart rate and SpO₂ with a real sensor, guides older Vietnamese users by screen and voice, and hands readings to the GeneSense app over Bluetooth or a QR link. **It is a test device, not a medical device**; the screen says so on every page.

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
| DS18B20 waterproof probe (KIT0021 adapter) | **P1** (GPIO2), `TEMP_PIN` | Body temperature, own 1-Wire driver in the sketch (no library). Underarm, finishes when steady. |
| 3×AA holder (FIT0619) | BAT IN | Use **alkaline** cells. Zinc "heavy duty" cells brown out and the board restarts or squeals. |

The screen and the microSD card share one SPI bus (MOSI 21, SCK 12; screen CS 14, SD CS 40). The K10 library guards it with `xSPIlMutex`.

## 4. Arduino setup

Board package "unihiker" (`https://downloadcd.dfrobot.com.cn/UNIHIKER/package_unihiker_index.json`), board **unihiker k10**, PSRAM **OPI PSRAM**, partition **16M Flash (3MB APP/9.9MB FATFS)**, **Model: None** (other Model choices overwrite flash data on every upload), **USB CDC On Boot: Enabled** (Serial Monitor). Libraries: Adafruit GFX (the K10 package brings TFT_eSPI). U8g2 is **no longer** needed.

## 5. Root causes found the hard way (do not reintroduce)

1. **`WiFi.setSleep(false)` restarts the board** whenever Bluetooth is on. The Wi-Fi library aborts with "Should enable WiFi modem sleep when both WiFi and Bluetooth are enabled". Leave modem sleep on.
2. **`Serial.flush()` hangs forever without a computer** on the USB port (USB CDC On Boot = Enabled; `HWCDC::flush` has no timeout). It froze the device on power banks and batteries. Never call it.
3. **Power off is a standby loop, not deep sleep.** The green button only sends a signal; it cannot cut power. "Off" turns off the screen light, speaker amplifier, LEDs, Wi-Fi and Bluetooth, drops the CPU to 80 MHz and polls the button; "on" calls `esp_restart()`. Deep sleep with an ext0 wake was unreliable.
4. **Turn the speaker amplifier off (`digital_write(eAmp_Gain, 0)`) before going quiet**, after stopping I2S. Otherwise it amplifies noise and screams.
5. **Saving voice clips:** the `voice_data` FAT partition does not exist with every board package or partition choice. Storage tries, in order: microSD (if added later), FAT `voice_data`, FAT `ffat`, LittleFS `model`, LittleFS `spiffs`, then memory only (clips are made again after power-off; the screen says "Sẵn sàng (tạm)"). The Serial Monitor lists the flash parts at start.
6. **Gemini key:** a key in `GEMINI_KEY` is saved to flash (Preferences namespace `gsk10`, key `gkey`); later sketches with `""` keep using it. It can also be typed on the phone setup page. The voice row shows exactly what is missing ("Chưa có khóa", "Khóa sai", "Chờ Wi-Fi"…).
7. **Gemini TTS** uses the Interactions API (`POST /v1beta/interactions`, model `gemini-3.8-flash-lite-tts` then `gemini-3.8-flash-tts`, input as a `user_input` step, `response_format` WAV 16 kHz). The answer's audio is the longest `"data"` string. Both models are on the free tier.
8. **Wi-Fi setup by QR:** stop the saved Wi-Fi's auto-reconnect while the setup network is up, or the radio hops channels and phones cannot join.

## 6. What the sketch does (25 October 2026)

- Guided 30 s measurement (8 s settle, outlier rejection, restart when the board moves), result cards with the app's range bars and status shapes, emergency screen ("Gọi cấp cứu 115") with the app's limits.
- Bluetooth: standard Heart Rate (0x180D) and Pulse Oximeter (0x1822); the final value is sent five times because the app averages five.
- History of the last 100 results in flash with two charts; QR link into the GeneSense app (`#nhap-may-do?hr=&spo2=&t=`); local results page; Wi-Fi setup from a phone by QR code (with an optional Gemini key field).
- Vietnamese voice made once by Gemini and saved; beeps until then.
- Body temperature (Menu → Đo nhiệt độ).
- UI in the app's design language: light theme, Be Vietnam Pro, white cards, blue buttons, circle/triangle/octagon status marks, amber "THIẾT BỊ THỬ NGHIỆM" strip.

## 7. Shell (3D print)

Designed in Claude Design (OpenSCAD), printed in PLA on the owner's Anycubic Kobra S1 Combo with ACE Pro. The first fit test did not fit; the measured fixes (screen glass 49 × 69 mm starting 14 mm below the top edge, USB-C far edge 29 mm from the ESP32 side, Reset/Boot on the back, bosses outside the board outline, cable pockets lower) were sent back to Claude Design. Screws: M2.5 × 8 mm self-tapping for plastic.
