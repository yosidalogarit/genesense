/*
  GeneSense K10 - máy đo THỬ NGHIỆM nhịp tim + SpO2 cho UNIHIKER K10

  - Đo THẬT bằng cảm biến DFRobot SEN0518 (MAX30102) cắm vào cổng I2C.
    Không thấy cảm biến thì dùng số GIẢ LẬP và ghi rõ trên màn hình.
  - Bluetooth: dịch vụ chuẩn Heart Rate (0x180D) + Pulse Oximeter (0x1822),
    ứng dụng GeneSense đọc được ngay, không cần sửa ứng dụng.
  - Wi-Fi 2.4 GHz (không bắt buộc): giờ Việt Nam, trang web xem kết quả,
    tạo giọng nói tiếng Việt bằng Gemini MỘT LẦN rồi lưu lại trong máy (sau đó không cần mạng).
  - Nút xanh hoặc nút A: bắt đầu đo.  Nút B: menu / gửi sang điện thoại / hủy.
  - Menu: lịch sử đo, mã QR xem kết quả trên điện thoại, cài Wi-Fi bằng mã QR.
    A+B ở màn hình chính (chỉ khi giả lập): bật/tắt "thử oxy thấp" để trình diễn màn hình cấp cứu.
  - Ngưỡng giống ứng dụng: SpO2 < 90% hoặc nhịp tim < 40 / > 150 = nguy hiểm -> "Gọi cấp cứu 115".

  Đây KHÔNG phải thiết bị y tế và không dùng để chẩn đoán.
*/

#include "unihiker_k10.h"
#include <Adafruit_GFX.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLE2902.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <FFat.h>
#include <LittleFS.h>
#include <esp_partition.h>
#include <time.h>
#include <Preferences.h>
#include <DNSServer.h>
#include "qrcode.h"
#include "gs_fonts.h"                      // Be Vietnam Pro, the app's font (in this folder)

// ================= SETTINGS (change these) =================
const char* WIFI_NAME     = "";              // optional: 2.4 GHz Wi-Fi name. Easier: Menu > Cài Wi-Fi on the device
const char* WIFI_PASSWORD = "";
const char* GEMINI_KEY    = "";              // free Gemini key, only to make the voice. Saved in the device, so later
                                             // sketches can leave it "". Or type it on the phone: Menu > Cài Wi-Fi
const char* DEVICE_NAME   = "GeneSense-K10"; // Bluetooth name the phone sees
const int   MEASURE_SECONDS = 30;            // one measurement with the real sensor (it gives a new value every 4 s)
const int   SETTLE_SECONDS = 8;              // real sensor: ignore the first readings while the finger settles
const int   MOCK_SECONDS  = 15;              // one measurement with mock values
const int   MOVE_LIMIT    = 150;             // how much moving restarts the count (1000 = 1 g). Bigger = less strict
const float VOICE_VOLUME  = 0.6;             // 0.1 quiet .. 1.0 loud
const float BEEP_VOLUME   = 0.25;
#define USE_SEN0518 1                        // 1 = look for the SEN0518 sensor (switch on the sensor set to I2C)
#define LED_BUTTON_PIN 1                     // green LED button = power switch: port P0 = 1, P1 = 2, no button = -1
#define GREEN_ON_LEVEL 1                     // what the button sends when it is latched ON (lit). If on/off is the wrong way round, use 0
#define TEMP_PIN 2                           // DS18B20 temperature probe (KIT0021): port P1 = 2, none = -1
const char* SETUP_WIFI_NAME = "GeneSense-K10";   // the Wi-Fi the device makes while you set it up
const char* GENESENSE_URL = "https://genesense-five.vercel.app";   // where "Xem trên GeneSense" leads

const char* TTS_MODELS[] = {"gemini-3.8-flash-lite-tts", "gemini-3.8-flash-tts"};
const char* VOICE        = "Kore";
const char* SPEECH_STYLE = "Calm, warm and clear, a little slow, speaking kindly to an older person; natural standard Vietnamese pronunciation.";
// ============================================================

const uint8_t OXI_ADDR = 0x57;               // I2C address of the SEN0518

// ---------- types (kept above the first function, Arduino needs that) ----------
enum Screen { S_IDLE, S_PLACE, S_MEASURE, S_RESULT, S_EMERGENCY, S_MENU, S_HISTORY, S_QR, S_WIFISETUP, S_TEMP };
struct Rec { uint32_t t; uint8_t hr, spo2, flags, pad; };   // one saved measurement (flags: 1 = mock)
enum Level { SAFE, ATTN, ALERT };
enum Clip { V_WELCOME, V_PLACE, V_START, V_HOLD, V_DONE, V_CHECK, V_SENT, V_NOPHONE, V_EMERGENCY, V_NOFINGER, V_UNSTABLE, V_TEMP, CLIP_COUNT };
enum Sound { SND_BEEP = -1, SND_OK = -2, SND_ALARM = -3, SND_TICK = -4, SND_ERR = -5 };

const char* CLIP_TEXT[CLIP_COUNT] = {
  "Xin chào. Bấm nút A để bắt đầu đo.",
  "Hãy đeo cảm biến vào đầu ngón tay, rồi giữ yên tay.",
  "Bắt đầu đo. Hãy giữ yên tay và thở đều.",
  "Giữ yên tay nhé. Máy sẽ đo lại từ đầu.",
  "Đo xong rồi. Bấm nút B để gửi kết quả sang điện thoại.",
  "Có chỉ số cần chú ý. Hãy ngồi nghỉ rồi đo lại.",
  "Đã gửi kết quả sang điện thoại.",
  "Máy chưa nối với điện thoại. Hãy mở ứng dụng GeneSense và bấm kết nối.",
  "Chỉ số ở mức nguy hiểm. Hãy đo lại ngay. Nếu thấy khó thở hoặc mệt lả, hãy gọi cấp cứu một một năm.",
  "Chưa đọc được ngón tay. Hãy đeo lại cảm biến cho vừa khít.",
  "Số đo chưa ổn định. Hãy ngồi yên, thả lỏng tay, rồi đo lại.",
  "Kẹp đầu cảm biến nhiệt vào giữa nách, rồi khép chặt tay lại. Giữ yên khoảng ba phút.",
};

struct ModelState {
  unsigned long busyUntil = 0;               // skip this model until this millis()
  bool plainRequest = false;                 // the model refused the WAV format option
};

// ---------- colours (RGB565): the GeneSense app's colours ----------
#define C565(r, g, b) ((((r) & 0xF8) << 8) | (((g) & 0xFC) << 3) | ((b) >> 3))
#define HEX565(h) C565(((h) >> 16) & 255, ((h) >> 8) & 255, (h) & 255)
const uint16_t C_BG        = HEX565(0xf4f8ff);   // page
const uint16_t C_SURF      = HEX565(0xffffff);   // cards
const uint16_t C_LINE      = HEX565(0xdbe5f1);
const uint16_t C_LINE2     = HEX565(0xb7c7dc);
const uint16_t C_INK       = HEX565(0x10264b);   // text
const uint16_t C_INK2      = HEX565(0x52627a);   // quieter text
const uint16_t C_NAVY      = HEX565(0x0d2c69);
const uint16_t C_LOGO      = HEX565(0x0d2c54);
const uint16_t C_PULSE     = HEX565(0x9cc3ef);
const uint16_t C_BLUE      = HEX565(0x0756ce);   // buttons, progress
const uint16_t C_BLUE_SOFT = HEX565(0xeaf3ff);
const uint16_t C_CHART     = HEX565(0x0b57a4);
const uint16_t C_GREEN     = HEX565(0x17663a);   // status: safe
const uint16_t C_GREEN_BG  = HEX565(0xe5f2ea);
const uint16_t C_AMBER     = HEX565(0x7a4d00);   // status: attention
const uint16_t C_AMBER_BG  = HEX565(0xfcf1d6);
const uint16_t C_AMBER_LINE= HEX565(0xefd083);
const uint16_t C_RED       = HEX565(0xa8201a);   // status: danger
const uint16_t C_RED_BG    = HEX565(0xfbe9e8);
const uint16_t C_RED_SOLID = HEX565(0xb3261e);   // emergency screen
const uint16_t C_ZONE_SAFE = HEX565(0xb5d9c2);   // range bar zones
const uint16_t C_ZONE_ATTN = HEX565(0xefd083);
const uint16_t C_ZONE_ALERT= HEX565(0xeaa9a4);
const uint16_t C_BLACK     = 0x0000;
const uint16_t C_SKIN      = C565(240, 190, 150);
const uint16_t C_NAIL      = C565(250, 220, 205);

const int W = 240, H = 320;

// ---------- screen ----------
TFT_eSPI screen;
GFXcanvas16* cv = nullptr;                   // whole frame, drawn here then sent to the screen

UNIHIKER_K10 k10;

// ---------- app state ----------
Screen screenNow = S_IDLE;
unsigned long stateSince = 0;
bool dirty = true;                           // redraw now
int resultHR = 0, resultSpO2 = 0;
bool haveResult = false, resultMock = true, resultSent = false;
String resultTime;
uint32_t resultEpoch = 0;                    // Unix time of the result, 0 = clock not set
unsigned long resultAtMs = 0;
bool qrToGeneSense = true;                   // QR screen: GeneSense link, or this device's own page
bool demoLow = false;                        // demo: make the next mock reading low oxygen
String toastText;
uint16_t toastColor = C_GREEN;
unsigned long toastUntil = 0;

// measuring
long measureStart = 0;                       // millis() when the countdown started (can be in the future)
unsigned long holdUntil = 0;                 // showing "Giữ yên tay nhé" until then
unsigned long baselineAt = 0;                // take the still position at this time
bool haveBaseline = false;
int baseX = 0, baseY = 0, baseZ = 0, restarts = 0;
float liveHR = 0;
float hrSamples[120], spSamples[120];
int hrCount = 0, spCount = 0;
int lastBeepSecond = -1;
float wave[200];
int waveHead = 0, waveCount = 0;

// mock sensor
float mockHR = 74, mockSpO2 = 97.6, mockPhase = 0;
unsigned long lastMockSample = 0, lastMockWave = 0;
bool sensorOk = false;

// real sensor (SEN0518)
int liveSpO2 = 0;                            // last good values from the sensor
int goodStreak = 0, badStreak = 0, ioErrors = 0;
unsigned long lastOxiPoll = 0, lastOxiSample = 0;

// buttons
bool anyHeld = false, heldA = false, heldB = false;
int greenRaw = -1, greenStable = -1;         // green LED button: it latches; ON = device on, OFF = device sleeps
unsigned long greenChangedAt = 0;

// menu + history
const char* MENU_ITEMS[] = {"Đo nhiệt độ", "Lịch sử đo", "Xem bằng QR", "Cài Wi-Fi", "Xóa lịch sử", "Quay lại"};
const int MENU_COUNT = 6;
const int MENU_CLEAR = 4;                    // "Xóa lịch sử"

// body temperature (DS18B20 on P1)
enum TempState { T_NOPROBE, T_WAIT, T_DONE };
TempState tempState = T_NOPROBE;
float tempNow = 0, tempResult = 0;           // °C
float tempLog[40];                           // one reading a second, newest last
int tempLogN = 0;
unsigned long tempStart = 0, tempConvAt = 0;
bool tempConverting = false;
const int TEMP_MAX_SECONDS = 300;            // give up waiting for a steady value after 5 minutes
int menuSel = 0;
unsigned long clearConfirmUntil = 0;
const int HIST_MAX = 100;
Rec hist[HIST_MAX];                          // oldest first
int histCount = 0;
Preferences prefs;

// QR code (cached modules)
uint8_t qrMods[64 * 64];
int qrSize = 0;
String qrText;

// Wi-Fi setup by phone
String wifiSsid, wifiPass;                   // saved Wi-Fi (or the one in the settings above)
DNSServer dns;
bool setupActive = false;
int setupStep = 0;                           // 0 scanning, 1 join device Wi-Fi, 2 open page, 3 connecting, 4 done, 5 failed
String setupPass, setupNetworks;
unsigned long setupTimer = 0;

// LEDs
uint32_t ledNow[3] = {1, 1, 1};

// Bluetooth
BLECharacteristic* hrChar = nullptr;
BLECharacteristic* plxChar = nullptr;
volatile bool bleConnected = false;
bool bleWasConnected = false;

// Wi-Fi
WebServer web(80);
bool wifiWasUp = false, webStarted = false;

// sound + voice
QueueHandle_t audioQ = nullptr;
volatile bool audioStop = false, audioBusy = false;
volatile bool voiceReady[CLIP_COUNT];
bool fsOk = false;                           // somewhere to keep the voice clips (flash, or memory until power-off)
fs::FS* store = nullptr;                     // the flash file system in use, nullptr = memory only
const char* storeName = "";
uint8_t* ramClip[CLIP_COUNT];                // memory-only mode: one clip each (lost at power-off)
size_t ramLen[CLIP_COUNT];
volatile bool voiceTaskRunning = false;
volatile int voiceProblem = 0;               // last problem making the voice: HTTP code, -1 network, -2 no answer
String geminiKey;                            // GEMINI_KEY, or the one saved in the device
const int TTS_COUNT = sizeof(TTS_MODELS) / sizeof(TTS_MODELS[0]);
ModelState ttsState[TTS_COUNT];
const char* HOST = "generativelanguage.googleapis.com";
const size_t AUDIO_MAX = 700000;             // longest voice clip we accept (~14 s)
uint8_t* audioA = nullptr;
uint8_t* audioB = nullptr;
WiFiClientSecure* tls = nullptr;

// Root certificates of Google Trust Services, so the board only talks to the real Google.
const char GOOGLE_ROOTS[] =
"-----BEGIN CERTIFICATE-----\n"
"MIIFVzCCAz+gAwIBAgINAgPlk28xsBNJiGuiFzANBgkqhkiG9w0BAQwFADBHMQsw\n"
"CQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEU\n"
"MBIGA1UEAxMLR1RTIFJvb3QgUjEwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAw\n"
"MDAwWjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZp\n"
"Y2VzIExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjEwggIiMA0GCSqGSIb3DQEBAQUA\n"
"A4ICDwAwggIKAoICAQC2EQKLHuOhd5s73L+UPreVp0A8of2C+X0yBoJx9vaMf/vo\n"
"27xqLpeXo4xL+Sv2sfnOhB2x+cWX3u+58qPpvBKJXqeqUqv4IyfLpLGcY9vXmX7w\n"
"Cl7raKb0xlpHDU0QM+NOsROjyBhsS+z8CZDfnWQpJSMHobTSPS5g4M/SCYe7zUjw\n"
"TcLCeoiKu7rPWRnWr4+wB7CeMfGCwcDfLqZtbBkOtdh+JhpFAz2weaSUKK0Pfybl\n"
"qAj+lug8aJRT7oM6iCsVlgmy4HqMLnXWnOunVmSPlk9orj2XwoSPwLxAwAtcvfaH\n"
"szVsrBhQf4TgTM2S0yDpM7xSma8ytSmzJSq0SPly4cpk9+aCEI3oncKKiPo4Zor8\n"
"Y/kB+Xj9e1x3+naH+uzfsQ55lVe0vSbv1gHR6xYKu44LtcXFilWr06zqkUspzBmk\n"
"MiVOKvFlRNACzqrOSbTqn3yDsEB750Orp2yjj32JgfpMpf/VjsPOS+C12LOORc92\n"
"wO1AK/1TD7Cn1TsNsYqiA94xrcx36m97PtbfkSIS5r762DL8EGMUUXLeXdYWk70p\n"
"aDPvOmbsB4om3xPXV2V4J95eSRQAogB/mqghtqmxlbCluQ0WEdrHbEg8QOB+DVrN\n"
"VjzRlwW5y0vtOUucxD/SVRNuJLDWcfr0wbrM7Rv1/oFB2ACYPTrIrnqYNxgFlQID\n"
"AQABo0IwQDAOBgNVHQ8BAf8EBAMCAYYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4E\n"
"FgQU5K8rJnEaK0gnhS9SZizv8IkTcT4wDQYJKoZIhvcNAQEMBQADggIBAJ+qQibb\n"
"C5u+/x6Wki4+omVKapi6Ist9wTrYggoGxval3sBOh2Z5ofmmWJyq+bXmYOfg6LEe\n"
"QkEzCzc9zolwFcq1JKjPa7XSQCGYzyI0zzvFIoTgxQ6KfF2I5DUkzps+GlQebtuy\n"
"h6f88/qBVRRiClmpIgUxPoLW7ttXNLwzldMXG+gnoot7TiYaelpkttGsN/H9oPM4\n"
"7HLwEXWdyzRSjeZ2axfG34arJ45JK3VmgRAhpuo+9K4l/3wV3s6MJT/KYnAK9y8J\n"
"ZgfIPxz88NtFMN9iiMG1D53Dn0reWVlHxYciNuaCp+0KueIHoI17eko8cdLiA6Ef\n"
"MgfdG+RCzgwARWGAtQsgWSl4vflVy2PFPEz0tv/bal8xa5meLMFrUKTX5hgUvYU/\n"
"Z6tGn6D/Qqc6f1zLXbBwHSs09dR2CQzreExZBfMzQsNhFRAbd03OIozUhfJFfbdT\n"
"6u9AWpQKXCBfTkBdYiJ23//OYb2MI3jSNwLgjt7RETeJ9r/tSQdirpLsQBqvFAnZ\n"
"0E6yove+7u7Y/9waLd64NnHi/Hm3lCXRSHNboTXns5lndcEZOitHTtNCjv0xyBZm\n"
"2tIMPNuzjsmhDYAPexZ3FL//2wmUspO8IFgV6dtxQ/PeEMMA3KgqlbbC1j+Qa3bb\n"
"bP6MvPJwNQzcmRk13NfIRmPVNnGuV/u3gm3c\n"
"-----END CERTIFICATE-----\n"
"-----BEGIN CERTIFICATE-----\n"
"MIICCTCCAY6gAwIBAgINAgPluILrIPglJ209ZjAKBggqhkjOPQQDAzBHMQswCQYD\n"
"VQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIG\n"
"A1UEAxMLR1RTIFJvb3QgUjMwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAwMDAw\n"
"WjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2Vz\n"
"IExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjMwdjAQBgcqhkjOPQIBBgUrgQQAIgNi\n"
"AAQfTzOHMymKoYTey8chWEGJ6ladK0uFxh1MJ7x/JlFyb+Kf1qPKzEUURout736G\n"
"jOyxfi//qXGdGIRFBEFVbivqJn+7kAHjSxm65FSWRQmx1WyRRK2EE46ajA2ADDL2\n"
"4CejQjBAMA4GA1UdDwEB/wQEAwIBhjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQW\n"
"BBTB8Sa6oC2uhYHP0/EqEr24Cmf9vDAKBggqhkjOPQQDAwNpADBmAjEA9uEglRR7\n"
"VKOQFhG/hMjqb2sXnh5GmCCbn9MN2azTL818+FsuVbu/3ZL3pAzcMeGiAjEA/Jdm\n"
"ZuVDFhOD3cffL74UOO0BzrEXGhF16b0DjyZ+hOXJYKaV11RZt+cRLInUue4X\n"
"-----END CERTIFICATE-----\n"
"-----BEGIN CERTIFICATE-----\n"
"MIICCTCCAY6gAwIBAgINAgPlwGjvYxqccpBQUjAKBggqhkjOPQQDAzBHMQswCQYD\n"
"VQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2VzIExMQzEUMBIG\n"
"A1UEAxMLR1RTIFJvb3QgUjQwHhcNMTYwNjIyMDAwMDAwWhcNMzYwNjIyMDAwMDAw\n"
"WjBHMQswCQYDVQQGEwJVUzEiMCAGA1UEChMZR29vZ2xlIFRydXN0IFNlcnZpY2Vz\n"
"IExMQzEUMBIGA1UEAxMLR1RTIFJvb3QgUjQwdjAQBgcqhkjOPQIBBgUrgQQAIgNi\n"
"AATzdHOnaItgrkO4NcWBMHtLSZ37wWHO5t5GvWvVYRg1rkDdc/eJkTBa6zzuhXyi\n"
"QHY7qca4R9gq55KRanPpsXI5nymfopjTX15YhmUPoYRlBtHci8nHc8iMai/lxKvR\n"
"HYqjQjBAMA4GA1UdDwEB/wQEAwIBhjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQW\n"
"BBSATNbrdP9JNqPV2Py1PsVq8JQdjDAKBggqhkjOPQQDAwNpADBmAjEA6ED/g94D\n"
"9J+uHXqnLrmvT/aDHQ4thQEd0dlq7A/Cr8deVl5c1RxYIigL9zC2L7F8AjEA8GE8\n"
"p/SgguMh1YQdc4acLa/KNJvxn7kjNuK8YAOdgLOaVsjh4rsUecrNIdSUtUlD\n"
"-----END CERTIFICATE-----\n";

// Reads an HTTP response body: handles "chunked" replies and buffers the TLS stream.
struct HttpBody {
  WiFiClientSecure* c = nullptr;
  bool chunked = false, done = false;
  long left = -1;
  uint8_t buf[1024];
  int pos = 0, len = 0, refills = 0;
  unsigned long timeoutMs = 25000;

  int rawRead() {
    if (pos < len) return buf[pos++];
    unsigned long start = millis();
    for (;;) {
      int avail = c->available();
      if (avail > 0) {
        len = c->read(buf, min(avail, (int)sizeof(buf)));
        pos = 0;
        if (++refills % 32 == 0) delay(1);   // long downloads: let the other tasks run
        if (len > 0) return buf[pos++];
      } else if (!c->connected()) {
        return -1;
      }
      if (millis() - start > timeoutMs) return -1;
      delay(2);
    }
  }
  String rawLine() {
    String s;
    int ch;
    while ((ch = rawRead()) >= 0 && ch != '\n') if (ch != '\r') s += (char)ch;
    return s;
  }
  int read() {
    if (done) return -1;
    if (chunked && left == 0) {
      left = strtol(rawLine().c_str(), nullptr, 16);
      if (left <= 0) { done = true; return -1; }
    }
    if (!chunked && left == 0) { done = true; return -1; }
    int ch = rawRead();
    if (ch < 0) { done = true; return -1; }
    if (left > 0 && --left == 0 && chunked) { rawRead(); rawRead(); }
    return ch;
  }
};
HttpBody body;

// =====================================================================
// Small helpers
// =====================================================================
float randf(float a, float b) { return a + (b - a) * (esp_random() / 4294967295.0f); }

bool mockMode() { return !sensorOk; }
int measureSeconds() { return sensorOk ? MEASURE_SECONDS : MOCK_SECONDS; }

Level levelHR(int n) {                       // same words and limits as the GeneSense app
  if (n < 40 || n > 150) return ALERT;
  if (n < 50 || n > 110) return ATTN;
  return SAFE;
}
Level levelSpO2(int n) {
  if (n < 90) return ALERT;
  if (n < 95) return ATTN;
  return SAFE;
}
const char* levelWordHR(Level l) { return l == ALERT ? "Nguy hiểm" : l == ATTN ? "Cần chú ý" : "An toàn"; }
const char* levelWordSpO2(Level l) { return l == ALERT ? "Nguy hiểm" : l == ATTN ? "Thấp, cần chú ý" : "An toàn"; }
uint16_t levelColor(Level l) { return l == ALERT ? C_RED : l == ATTN ? C_AMBER : C_GREEN; }

String clockText() {
  struct tm t;
  if (!getLocalTime(&t, 0)) return "";
  char s[8];
  strftime(s, sizeof(s), "%H:%M", &t);
  return s;
}

String dateTimeText() {
  struct tm t;
  if (!getLocalTime(&t, 0)) return "";
  char s[24];
  strftime(s, sizeof(s), "%H:%M %d/%m/%Y", &t);
  return s;
}

float median(float* v, int n) {
  if (n <= 0) return 0;
  float tmp[120];
  n = min(n, 120);
  memcpy(tmp, v, n * sizeof(float));
  std::sort(tmp, tmp + n);
  return n % 2 ? tmp[n / 2] : (tmp[n / 2 - 1] + tmp[n / 2]) / 2;
}

void setLed(int i, uint8_t r, uint8_t g, uint8_t b) {
  uint32_t c = (uint32_t)r << 16 | g << 8 | b;
  if (ledNow[i] == c) return;                // the LED call is slow, only send changes
  ledNow[i] = c;
  k10.rgb->write(i, r, g, b);
}

void showToast(const String& s, uint16_t color) {
  toastText = s;
  toastColor = color;
  toastUntil = millis() + 3500;
  dirty = true;
}

// =====================================================================
// History: the last 100 measurements, kept in flash
// =====================================================================
void loadHistory() {
  size_t n = prefs.getBytesLength("hist");
  histCount = min((int)(n / sizeof(Rec)), HIST_MAX);
  if (histCount) prefs.getBytes("hist", hist, histCount * sizeof(Rec));
  Serial.printf("History: %d saved measurements\n", histCount);
}

void addHistory(int hr, int spo2, bool mock) {
  if (histCount == HIST_MAX) { memmove(hist, hist + 1, (HIST_MAX - 1) * sizeof(Rec)); histCount--; }
  time_t now = time(nullptr);
  Rec r;
  r.t = now > 1700000000 ? (uint32_t)now : 0;  // 0 = clock not set yet
  r.hr = hr;
  r.spo2 = spo2;
  r.flags = mock ? 1 : 0;
  r.pad = 0;
  hist[histCount++] = r;
  prefs.putBytes("hist", hist, histCount * sizeof(Rec));
}

void clearHistory() {
  histCount = 0;
  prefs.remove("hist");
}

String recTime(const Rec& r) {               // "16/10 08:15", or "" if the time was unknown
  if (!r.t) return "";
  time_t t = r.t;
  struct tm tmv;
  localtime_r(&t, &tmv);
  char s[16];
  strftime(s, sizeof(s), "%d/%m %H:%M", &tmv);
  return s;
}

// The GeneSense app reads "#nhap-may-do?hr=..&spo2=..&t=.." and asks before saving. Numbers only, no personal data.
String geneSenseLink(int hr, int spo2, uint32_t epoch) {
  String url = String(GENESENSE_URL) + "/#nhap-may-do?hr=" + String(hr) + "&spo2=" + String(spo2);
  if (epoch) url += "&t=" + String((unsigned long)epoch);
  return url;
}

// The reading to send: this power-on's result, or after a restart the last saved one.
// Mock values never go to GeneSense. Without a clock, only a fresh result goes (the app then records "just now").
bool shareReading(int& hr, int& spo2, uint32_t& epoch, bool& mock) {
  if (haveResult) {
    hr = resultHR; spo2 = resultSpO2; epoch = resultEpoch; mock = resultMock;
    return !mock && (epoch || millis() - resultAtMs <= 15 * 60000UL);
  }
  if (!histCount) { mock = false; return false; }
  const Rec& r = hist[histCount - 1];
  hr = r.hr; spo2 = r.spo2; epoch = r.t; mock = r.flags & 1;
  return !mock && epoch;                      // a saved reading needs its time
}

String latestLink() {
  int hr, spo2;
  uint32_t epoch;
  bool mock;
  return shareReading(hr, spo2, epoch, mock) ? geneSenseLink(hr, spo2, epoch) : "";
}

String htmlEscape(const String& in) {        // Wi-Fi names come from neighbours: never trust them in a web page
  String out;
  for (unsigned i = 0; i < in.length(); i++) {
    char c = in[i];
    if (c == '<') out += "&lt;";
    else if (c == '>') out += "&gt;";
    else if (c == '&') out += "&amp;";
    else if (c == '"') out += "&quot;";
    else if (c == '\'') out += "&#39;";
    else out += c;
  }
  return out;
}

void qrStore(esp_qrcode_handle_t q) {        // called by the QR maker: keep the black/white squares
  qrSize = esp_qrcode_get_size(q);
  if (qrSize > 64) { qrSize = 0; return; }
  for (int y = 0; y < qrSize; y++)
    for (int x = 0; x < qrSize; x++) qrMods[y * 64 + x] = esp_qrcode_get_module(q, x, y);
}

void makeQR(const String& text) {
  if (text == qrText && qrSize) return;
  qrText = text;
  qrSize = 0;
  esp_qrcode_config_t cfg;
  cfg.display_func = qrStore;
  cfg.max_qrcode_version = 10;
  cfg.qrcode_ecc_level = ESP_QRCODE_ECC_MED;
  esp_qrcode_generate(&cfg, text.c_str());
}

// =====================================================================
// Sound: beeps and saved voice clips, played by a background task
// =====================================================================
uint32_t fnv(const char* s, uint32_t h) {
  while (*s) { h ^= (uint8_t)*s++; h *= 16777619u; }
  return h;
}

String clipPath(int id) {                    // the name changes when the sentence or voice changes
  char s[24];
  snprintf(s, sizeof(s), "/gs_%08lx.pcm", (unsigned long)fnv(CLIP_TEXT[id], fnv(VOICE, 2166136261u)));
  return s;
}

void say(int item, bool cut) {               // item: a Clip, or a Sound (negative)
  if (!audioQ) return;
  if (cut) { audioStop = true; xQueueReset(audioQ); }
  xQueueSend(audioQ, &item, 0);
}

bool audioIdle() { return audioQ && !audioBusy && uxQueueMessagesWaiting(audioQ) == 0; }

void toneOut(float f, int ms, float vol) {   // one sine tone, soft start and end (16 kHz stereo)
  const int R = 16000;
  int n = R * ms / 1000, fade = R / 125;
  int16_t buf[256 * 2];
  float ph = 0, step = 2 * PI * f / R;
  for (int i = 0; i < n && !audioStop; ) {
    int k = min(256, n - i);
    for (int j = 0; j < k; j++, i++) {
      float env = min(1.0f, min(i, n - i) / (float)fade);
      int16_t v = f > 0 ? (int16_t)(sinf(ph) * 32767 * vol * env) : 0;
      ph += step;
      if (ph > 2 * PI) ph -= 2 * PI;
      buf[2 * j] = buf[2 * j + 1] = v;
    }
    size_t w;
    i2s_write(I2S_NUM_0, buf, k * 4, &w, portMAX_DELAY);
  }
}

void playSound(int s) {
  if (s == SND_BEEP) toneOut(880, 140, BEEP_VOLUME);
  else if (s == SND_TICK) toneOut(1400, 40, BEEP_VOLUME * 0.6);
  else if (s == SND_OK) { toneOut(660, 120, BEEP_VOLUME); toneOut(990, 200, BEEP_VOLUME); }
  else if (s == SND_ERR) { toneOut(520, 150, BEEP_VOLUME); toneOut(390, 250, BEEP_VOLUME); }
  else if (s == SND_ALARM) for (int i = 0; i < 3 && !audioStop; i++) { toneOut(1050, 260, BEEP_VOLUME * 1.4); toneOut(760, 260, BEEP_VOLUME * 1.4); }
}

void playPcm(const int16_t* in, size_t k) {
  int16_t out[512];
  for (size_t i = 0; i < k; i++) out[2 * i] = out[2 * i + 1] = (int16_t)(in[i] * VOICE_VOLUME);
  size_t w;
  i2s_write(I2S_NUM_0, out, k * 4, &w, portMAX_DELAY);
}

bool playClip(int id) {
  if (!fsOk || !voiceReady[id]) return false;
  if (!store) {                              // memory-only mode: "GSV1", rate, samples
    if (!ramClip[id] || ramLen[id] < 8) return false;
    uint32_t rate;
    memcpy(&rate, ramClip[id] + 4, 4);
    i2s_set_sample_rates(I2S_NUM_0, rate);
    const int16_t* pcm = (const int16_t*)(ramClip[id] + 8);
    size_t n = (ramLen[id] - 8) / 2;
    for (size_t i = 0; i < n && !audioStop; i += 256) playPcm(pcm + i, min((size_t)256, n - i));
    return true;
  }
  File f = store->open(clipPath(id), FILE_READ);
  if (!f) return false;
  char magic[4];
  uint32_t rate = 0;
  if (f.read((uint8_t*)magic, 4) != 4 || memcmp(magic, "GSV1", 4) != 0 || f.read((uint8_t*)&rate, 4) != 4 ||
      rate < 8000 || rate > 48000) {
    f.close();
    return false;
  }
  i2s_set_sample_rates(I2S_NUM_0, rate);
  int16_t in[256];
  while (!audioStop) {
    int got = f.read((uint8_t*)in, sizeof(in));
    if (got <= 1) break;
    playPcm(in, got / 2);
  }
  f.close();
  return true;
}

void audioTask(void*) {
  int item;
  for (;;) {
    if (xQueueReceive(audioQ, &item, portMAX_DELAY) != pdTRUE) continue;
    audioBusy = true;
    audioStop = false;
    xSemaphoreTake(xI2SMutex, portMAX_DELAY);
    if (item >= 0) {
      if (!playClip(item)) {                 // no voice yet: a beep that fits the message
        if (item == V_EMERGENCY) playSound(SND_ALARM);
        else if (item == V_DONE || item == V_SENT) playSound(SND_OK);
        else if (item == V_HOLD || item == V_NOPHONE || item == V_NOFINGER || item == V_CHECK) playSound(SND_ERR);
        else playSound(SND_BEEP);
      }
    } else {
      playSound(item);
    }
    i2s_zero_dma_buffer(I2S_NUM_0);
    i2s_set_sample_rates(I2S_NUM_0, 16000);
    xSemaphoreGive(xI2SMutex);
    vTaskDelay(pdMS_TO_TICKS(120));          // short pause between messages
    audioBusy = false;
  }
}

int voiceCount() {
  int n = 0;
  for (int i = 0; i < CLIP_COUNT; i++) if (voiceReady[i]) n++;
  return n;
}

int voiceNeeded() { return USE_SEN0518 ? CLIP_COUNT : CLIP_COUNT - 1; }    // "no finger" only with a real sensor

void listPartitions() {                      // for the Serial Monitor: what this board's flash holds
  Serial.println("Flash parts:");
  esp_partition_iterator_t it = esp_partition_find(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, nullptr);
  for (; it; it = esp_partition_next(it)) {
    const esp_partition_t* p = esp_partition_get(it);
    Serial.printf("  %-12s type %d sub 0x%02x at 0x%06x, %u KB\n", p->label, p->type, p->subtype, (unsigned)p->address, (unsigned)(p->size / 1024));
  }
  esp_partition_iterator_release(it);
}

bool hasPart(const char* label, esp_partition_subtype_t sub) {
  return esp_partition_find_first(ESP_PARTITION_TYPE_DATA, sub, label) != nullptr;
}

// Voice clips live in the board's flash. The K10's parts differ between board packages and
// "Partition Scheme" choices, so try each place in turn; with none, keep them in memory.
void startStorage() {
  listPartitions();
  struct { const char* label; bool fat; } tries[] = {{"voice_data", true}, {"ffat", true}, {"model", false}, {"spiffs", false}};
  for (auto& t : tries) {
    if (!hasPart(t.label, t.fat ? ESP_PARTITION_SUBTYPE_DATA_FAT : ESP_PARTITION_SUBTYPE_DATA_SPIFFS)) continue;
    Serial.printf("Voice storage: trying \"%s\" (first time it is formatted, this can take a minute)\n", t.label);
    if (t.fat ? FFat.begin(true, "/ffat", 3, t.label) : LittleFS.begin(true, "/littlefs", 3, t.label)) {
      store = t.fat ? (fs::FS*)&FFat : (fs::FS*)&LittleFS;
      storeName = t.label;
      break;
    }
    Serial.printf("Voice storage: \"%s\" did not work\n", t.label);
  }
  fsOk = true;
  if (!store) {
    Serial.println("Voice storage: no usable flash part, keeping the voice in memory (made again after power-off)");
    return;
  }
  for (int i = 0; i < CLIP_COUNT; i++) voiceReady[i] = store->exists(clipPath(i));
  // delete clips of sentences that were changed
  File root = store->open("/");
  std::vector<String> old;
  for (File f = root.openNextFile(); f; f = root.openNextFile()) {
    String name = String("/") + f.name();
    if (name.startsWith("/gs_")) {
      bool used = false;
      for (int i = 0; i < CLIP_COUNT; i++) if (name == clipPath(i)) used = true;
      if (!used) old.push_back(name);
    }
    f.close();
  }
  root.close();
  for (auto& n : old) store->remove(n);
  size_t total = store == (fs::FS*)&FFat ? FFat.totalBytes() : LittleFS.totalBytes();
  size_t used = store == (fs::FS*)&FFat ? FFat.usedBytes() : LittleFS.usedBytes();
  Serial.printf("Voice storage: \"%s\", clips saved %d/%d, free %u KB\n", storeName, voiceCount(), voiceNeeded(),
                (unsigned)((total - used) / 1024));
}

// ---------- Gemini text-to-speech (only used until every clip is saved) ----------
String jsonEscape(const char* s) {
  String out;
  for (; *s; s++) {
    if (*s == '"') out += "\\\"";
    else if (*s == '\\') out += "\\\\";
    else if ((uint8_t)*s < 0x20) out += ' ';
    else out += *s;
  }
  return out;
}

bool writeAll(const String& s) {
  const uint8_t* d = (const uint8_t*)s.c_str();
  size_t n = s.length();
  while (n) {
    size_t w = tls->write(d, min(n, (size_t)1024));
    if (w == 0) return false;
    d += w;
    n -= w;
  }
  return true;
}

bool startRequest(const String& path, size_t contentLength) {
  tls->stop();
  tls->setCACert(GOOGLE_ROOTS);
  tls->setHandshakeTimeout(30);
  if (!tls->connect(HOST, 443)) {
    char err[100];
    tls->lastError(err, sizeof(err));
    Serial.printf("HTTPS connect failed: %s (free RAM %u, biggest block %u)\n", err,
                  (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL), (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
    return false;
  }
  String h = "POST " + path + " HTTP/1.1\r\nHost: " + HOST + "\r\nx-goog-api-key: " + geminiKey +
             "\r\nContent-Type: application/json\r\nContent-Length: " + String((unsigned long)contentLength) +
             "\r\nConnection: close\r\n\r\n";
  return writeAll(h);
}

int readResponseHead() {
  body = HttpBody();
  body.c = tls;
  String status = body.rawLine();
  int code = status.length() > 12 ? status.substring(9, 12).toInt() : 0;
  for (;;) {
    String line = body.rawLine();
    if (line.length() == 0) break;
    line.toLowerCase();
    if (line.startsWith("transfer-encoding:") && line.indexOf("chunked") > 0) body.chunked = true;
    if (line.startsWith("content-length:")) body.left = line.substring(15).toInt();
  }
  if (body.chunked) body.left = 0;
  return code;
}

String printError() {                        // shows Google's error message in the Serial Monitor, and returns it
  String msg;
  for (int ch, n = 0; n < 1500 && (ch = body.read()) >= 0; n++) msg += (char)ch;
  int at = msg.indexOf("\"message\"");
  Serial.println("Gemini error: " + (at >= 0 ? msg.substring(at, min((int)msg.length(), at + 200)) : msg.substring(0, 200)));
  return msg;
}

// Finds the longest "data": "<base64>" in the reply (that is the audio) and decodes it.
size_t receiveAudio(uint8_t*& result) {
  static const char KEY[] = "\"data\"";
  uint8_t* best = audioA;
  uint8_t* cur = audioB;
  size_t bestLen = 0, curLen = 0;
  int match = 0, state = 0, q[4], qn = 0;
  for (int ch; (ch = body.read()) >= 0; ) {
    if (state == 0) {
      if (ch == KEY[match]) { if (++match == 6) { state = 1; match = 0; } }
      else match = (ch == '"') ? 1 : 0;
    } else if (state == 1 || state == 2) {
      if (ch == ' ' || ch == '\n' || ch == '\r' || ch == '\t') continue;
      if (state == 1 && ch == ':') state = 2;
      else if (state == 2 && ch == '"') { state = 3; curLen = 0; qn = 0; }
      else state = 0;
    } else if (ch == '"') {
      if (qn >= 2 && curLen < AUDIO_MAX) cur[curLen++] = (q[0] << 2) | (q[1] >> 4);
      if (qn == 3 && curLen < AUDIO_MAX) cur[curLen++] = (q[1] << 4) | (q[2] >> 2);
      if (curLen > bestLen) { std::swap(best, cur); bestLen = curLen; }
      state = 0;
    } else {
      int v = ch >= 'A' && ch <= 'Z' ? ch - 'A' : ch >= 'a' && ch <= 'z' ? ch - 'a' + 26 :
              ch >= '0' && ch <= '9' ? ch - '0' + 52 : ch == '+' ? 62 : ch == '/' ? 63 : -1;
      if (v < 0) continue;
      q[qn++] = v;
      if (qn == 4) {
        if (curLen + 3 <= AUDIO_MAX) {
          cur[curLen++] = (q[0] << 2) | (q[1] >> 4);
          cur[curLen++] = (q[1] << 4) | (q[2] >> 2);
          cur[curLen++] = (q[2] << 6) | q[3];
        }
        qn = 0;
      }
    }
  }
  result = best;
  return bestLen;
}

// Turns the downloaded audio (WAV or raw 16-bit) into a trimmed mono clip file.
bool saveClip(int id, uint8_t* a, size_t n) {
  uint32_t rate = 24000;
  int channels = 1;
  size_t start = 0, bytes = n;
  if (n > 44 && memcmp(a, "RIFF", 4) == 0) {
    size_t p = 12;
    bytes = 0;
    while (p + 8 <= n) {
      uint32_t size = a[p + 4] | a[p + 5] << 8 | a[p + 6] << 16 | (uint32_t)a[p + 7] << 24;
      if (memcmp(a + p, "fmt ", 4) == 0) {
        channels = a[p + 10] | a[p + 11] << 8;
        rate = a[p + 12] | a[p + 13] << 8 | a[p + 14] << 16 | (uint32_t)a[p + 15] << 24;
      } else if (memcmp(a + p, "data", 4) == 0) {
        start = p + 8;
        bytes = min((size_t)size, n - start);
        break;
      }
      p += 8 + size + (size & 1);
    }
  }
  if (rate < 8000 || rate > 48000) rate = 24000;
  if (channels < 1 || channels > 2) channels = 1;
  if (start & 1) { memmove(a, a + start, bytes); start = 0; }
  int16_t* pcm = (int16_t*)(a + start);
  size_t frames = bytes / 2 / channels;
  for (size_t i = 0; i < frames; i++) pcm[i] = pcm[i * channels];   // keep one channel
  size_t first = 0, last = frames;
  while (first < frames && abs(pcm[first]) < 300) first++;           // cut silence at both ends
  while (last > first && abs(pcm[last - 1]) < 300) last--;
  size_t pad = rate / 12;
  first = first > pad ? first - pad : 0;
  last = min(frames, last + pad);
  if (last <= first + rate / 4) return false;                         // shorter than 0.25 s: broken

  if (!store) {                              // memory-only mode
    size_t n = 8 + (last - first) * 2;
    uint8_t* m = (uint8_t*)ps_malloc(n);
    if (!m) return false;
    memcpy(m, "GSV1", 4);
    memcpy(m + 4, &rate, 4);
    memcpy(m + 8, pcm + first, (last - first) * 2);
    free(ramClip[id]);
    ramClip[id] = m;
    ramLen[id] = n;
    Serial.printf("Voice %d kept in memory: %.1f s\n", id, (last - first) / (float)rate);
    return true;
  }
  String tmp = "/tmp.pcm";
  File f = store->open(tmp, FILE_WRITE);
  if (!f) return false;
  bool ok = f.write((const uint8_t*)"GSV1", 4) == 4 && f.write((const uint8_t*)&rate, 4) == 4 &&
            f.write((const uint8_t*)(pcm + first), (last - first) * 2) == (last - first) * 2;
  f.close();
  if (!ok) { store->remove(tmp); Serial.println("Could not write the clip: flash full?"); return false; }
  store->remove(clipPath(id));
  if (!store->rename(tmp, clipPath(id))) return false;
  Serial.printf("Voice %d saved: %.1f s\n", id, (last - first) / (float)rate);
  return true;
}

bool makeClip(int id) {
  for (int m = 0; m < TTS_COUNT; m++) {
    if (ttsState[m].busyUntil && (long)(ttsState[m].busyUntil - millis()) > 0) continue;
    for (int attempt = 0; attempt < 2; attempt++) {
      String format = ttsState[m].plainRequest ? "{\"type\":\"audio\"}"
                    : "{\"type\":\"audio\",\"mime_type\":\"audio/wav\",\"sample_rate\":16000}";
      // same shape as Google's REST example for single-speaker speech
      String req = String("{\"model\":\"") + TTS_MODELS[m] + "\",\"store\":false,\"input\":[{\"type\":\"user_input\",\"content\":[{\"type\":\"text\",\"text\":\"" +
                   jsonEscape(CLIP_TEXT[id]) + "\",\"annotations\":[{\"type\":\"speech_metadata\",\"style\":\"" +
                   jsonEscape(SPEECH_STYLE) + "\"}]}]}],\"response_format\":" + format +
                   ",\"generation_config\":{\"speech_config\":[{\"voice\":\"" + VOICE + "\"}]}}";
      if (!startRequest("/v1beta/interactions", req.length()) || !writeAll(req)) { voiceProblem = -1; tls->stop(); return false; }
      int code = readResponseHead();
      Serial.printf("Voice %d with %s: HTTP %d\n", id, TTS_MODELS[m], code);
      if (code == 0) { Serial.println("Google did not answer in time"); tls->stop(); voiceProblem = -2; return false; }
      if (code == 200) {
        uint8_t* audio = nullptr;
        size_t n = receiveAudio(audio);
        tls->stop();
        Serial.printf("Voice %d: %u bytes of audio\n", id, (unsigned)n);
        if (n > 1000 && saveClip(id, audio, n)) { voiceProblem = 0; return true; }
        voiceProblem = -3;                   // answer without usable audio
        break;
      }
      String msg = printError();
      tls->stop();
      voiceProblem = code;
      if (msg.indexOf("API_KEY_INVALID") >= 0 || msg.indexOf("API key not valid") >= 0 || code == 401 || code == 403) {
        voiceProblem = 401;                  // wrong key: trying again will not help
        return false;
      }
      if (code == 400 && !ttsState[m].plainRequest) { ttsState[m].plainRequest = true; continue; }
      if (code != 400) {                     // busy or over the free limit: leave this model alone a while
        unsigned long minutes = code == 404 ? 600 : code == 429 ? 20 : 5;
        ttsState[m].busyUntil = millis() + minutes * 60000UL;
        if (ttsState[m].busyUntil == 0) ttsState[m].busyUntil = 1;
      }
      break;
    }
  }
  return false;
}

void voiceTask(void*) {
  audioA = (uint8_t*)ps_malloc(AUDIO_MAX);
  audioB = (uint8_t*)ps_malloc(AUDIO_MAX);
  tls = new WiFiClientSecure;
  if (audioA && audioB) {
    Serial.printf("Making the voice: %d of %d clips to go\n", voiceNeeded() - voiceCount(), voiceNeeded());
    for (int round = 0; round < 40 && voiceProblem != 401; round++) {
      bool missing = false;
      for (int id = 0; id < CLIP_COUNT && voiceProblem != 401; id++) {
        if (voiceReady[id] || (id == V_NOFINGER && !USE_SEN0518)) continue;
        missing = true;
        if (WiFi.status() != WL_CONNECTED) break;
        if (makeClip(id)) voiceReady[id] = true;
        dirty = true;
        vTaskDelay(pdMS_TO_TICKS(7000));     // free tier allows only a few requests per minute
      }
      if (!missing) break;
      if (voiceProblem != 401) vTaskDelay(pdMS_TO_TICKS(180000));   // try the missing ones again in 3 minutes
    }
    if (voiceProblem == 401) Serial.println("The Gemini key is wrong: check it, or type it again in Menu > Cài Wi-Fi");
    else if (voiceCount() >= voiceNeeded()) Serial.println("Voice ready: every clip is saved, no internet needed from now on");
  }
  delete tls;
  tls = nullptr;
  free(audioA);
  free(audioB);
  audioA = audioB = nullptr;
  voiceTaskRunning = false;
  dirty = true;
  vTaskDelete(NULL);
}

void startVoiceTask() {
  if (voiceTaskRunning || !fsOk || voiceCount() >= voiceNeeded()) return;
  if (!geminiKey.length()) { Serial.println("No Gemini key: beeps only. Put it in GEMINI_KEY, or Menu > Cài Wi-Fi"); return; }
  voiceProblem = 0;
  voiceTaskRunning = true;
  xTaskCreatePinnedToCore(voiceTask, "voice", 16 * 1024, nullptr, 1, nullptr, 0);
}

// =====================================================================
// Bluetooth: standard Heart Rate + Pulse Oximeter services (what GeneSense reads)
// =====================================================================
class ServerEvents : public BLEServerCallbacks {
  void onConnect(BLEServer*) { bleConnected = true; }
  void onDisconnect(BLEServer*) { bleConnected = false; }
};

uint16_t sfloat(float v) {                   // Bluetooth "SFLOAT": 12-bit number x 10^exponent
  int exponent = 0;
  float m = v;
  while (fabsf(m) > 2047 && exponent < 7) { m /= 10; exponent++; }
  while (fabsf(m - roundf(m)) > 0.001f && fabsf(m * 10) <= 2047 && exponent > -8) { m *= 10; exponent--; }
  int mant = (int)roundf(m);
  return (uint16_t)(((exponent & 0x0F) << 12) | (mant & 0x0FFF));
}

void startBluetooth() {
  BLEDevice::init(DEVICE_NAME);
  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new ServerEvents());

  BLEService* hr = server->createService(BLEUUID((uint16_t)0x180D));
  hrChar = hr->createCharacteristic(BLEUUID((uint16_t)0x2A37), BLECharacteristic::PROPERTY_NOTIFY);
  hrChar->addDescriptor(new BLE2902());
  BLECharacteristic* where = hr->createCharacteristic(BLEUUID((uint16_t)0x2A38), BLECharacteristic::PROPERTY_READ);
  uint8_t finger = 3;                        // body sensor location: finger
  where->setValue(&finger, 1);
  hr->start();

  BLEService* plx = server->createService(BLEUUID((uint16_t)0x1822));
  plxChar = plx->createCharacteristic(BLEUUID((uint16_t)0x2A5F), BLECharacteristic::PROPERTY_NOTIFY);
  plxChar->addDescriptor(new BLE2902());
  BLECharacteristic* features = plx->createCharacteristic(BLEUUID((uint16_t)0x2A60), BLECharacteristic::PROPERTY_READ);
  uint8_t none[2] = {0, 0};
  features->setValue(none, 2);
  plx->start();

  BLEService* info = server->createService(BLEUUID((uint16_t)0x180A));
  info->createCharacteristic(BLEUUID((uint16_t)0x2A29), BLECharacteristic::PROPERTY_READ)->setValue("GeneSense (thu nghiem)");
  info->createCharacteristic(BLEUUID((uint16_t)0x2A24), BLECharacteristic::PROPERTY_READ)->setValue(USE_SEN0518 ? "K10 + SEN0518" : "K10 gia lap");
  info->start();

  BLEAdvertising* adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(BLEUUID((uint16_t)0x180D));
  adv->addServiceUUID(BLEUUID((uint16_t)0x1822));
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.printf("Bluetooth ready as \"%s\"\n", DEVICE_NAME);
}

void notifyValues(int hr, int spo2) {
  uint8_t hrPacket[2] = {0x00, (uint8_t)constrain(hr, 0, 255)};   // flags 0 = 8-bit heart rate
  hrChar->setValue(hrPacket, 2);
  hrChar->notify();
  uint16_t s = sfloat(spo2), p = sfloat(hr);
  uint8_t plxPacket[5] = {0x00, (uint8_t)(s & 0xFF), (uint8_t)(s >> 8), (uint8_t)(p & 0xFF), (uint8_t)(p >> 8)};
  plxChar->setValue(plxPacket, 5);
  plxChar->notify();
}

// The app averages the last 5 values it got, so the same final value is sent 5 times:
// then the phone shows exactly the number on this screen, not a mix with an older reading.
bool sendResult(bool quiet) {
  if (!haveResult) return false;
  if (!bleConnected) {
    if (!quiet) { showToast("Chưa nối điện thoại", C_AMBER); say(V_NOPHONE, true); }
    return false;
  }
  for (int i = 0; i < 5; i++) { notifyValues(resultHR, resultSpO2); delay(150); }
  resultSent = true;
  Serial.printf("Sent to phone: %d bpm, SpO2 %d%%\n", resultHR, resultSpO2);
  showToast("Đã gửi sang điện thoại", C_GREEN);
  if (!quiet) say(V_SENT, true);
  return true;
}

// =====================================================================
// Wi-Fi: clock, web page, voice making
// =====================================================================
const char PAGE[] PROGMEM = R"html(<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>GeneSense K10</title>
<style>body{font-family:system-ui,sans-serif;background:#0a1226;color:#fff;margin:0;padding:16px;font-size:20px}
.card{background:#1c2e54;border-radius:14px;padding:16px;margin:12px 0}.big{font-size:56px;font-weight:700}
.tag{background:#ffd400;color:#000;padding:6px 10px;border-radius:8px;font-weight:700;display:inline-block}
.alert{background:#e11e23}.muted{color:#a5afc3;font-size:16px}
.gs{display:block;text-align:center;background:#28c85a;color:#000;font-weight:700;padding:16px;border-radius:14px;text-decoration:none;font-size:22px}
td a{color:#28c85a}</style></head><body>
<span class="tag">THIẾT BỊ THỬ NGHIỆM</span><h1>GeneSense K10</h1><div id="out">Đang tải...</div>
<h2>Lịch sử đo</h2><table style="width:100%;font-size:18px"><thead><tr><th align=left>Lúc</th><th align=left>Nhịp</th><th align=left>SpO2</th><th></th></tr></thead><tbody id="hist"></tbody></table>
<p class="muted">Không phải thiết bị y tế, không thay thế chẩn đoán của bác sĩ. Khi có dấu hiệu cấp cứu, gọi 115.</p>
<script>
async function load(){try{const r=await fetch('/api/latest');const d=await r.json();const o=document.getElementById('out');
if(!d.have){o.textContent='Chưa có lần đo nào. Bấm nút A trên máy để đo.';return}
o.innerHTML='';const add=(t,v,u,w)=>{const c=document.createElement('div');c.className='card';
c.innerHTML='<div></div><div class="big"></div><div></div>';c.children[0].textContent=t;c.children[1].textContent=v+' '+u;c.children[2].textContent=w;o.appendChild(c)};
if(d.emergency){const e=document.createElement('div');e.className='card alert';e.textContent='Chỉ số ở mức nguy hiểm. Đo lại ngay; nếu khó thở, gọi cấp cứu 115.';o.appendChild(e)}
add('Nhịp tim',d.heart_rate,'lần/phút',d.heart_rate_status);add('Oxy trong máu (SpO2)',d.spo2,'%',d.spo2_status);
const m=document.createElement('p');m.className='muted';m.textContent=(d.mock?'Số liệu giả lập. ':'')+(d.time?'Đo lúc '+d.time:'');o.appendChild(m);
if(d.link){const a=document.createElement('a');a.className='gs';a.href=d.link;a.textContent='Xem trên GeneSense';o.appendChild(a)}
else{const n=document.createElement('p');n.className='muted';n.textContent=d.mock?'Số liệu giả lập, không gửi sang GeneSense.':'Máy chưa có giờ và kết quả đã cũ, hãy đo lại để gửi sang GeneSense.';o.appendChild(n)}}catch(e){}
try{const h=await (await fetch('/api/history')).json();const t=document.getElementById('hist');t.innerHTML='';
h.forEach(r=>{const tr=document.createElement('tr');[r.t||'?',r.hr,r.spo2+'%'].forEach(v=>{const td=document.createElement('td');td.textContent=v;tr.appendChild(td)});
const td=document.createElement('td');if(r.link){const a=document.createElement('a');a.href=r.link;a.textContent='Lưu vào GeneSense';td.appendChild(a)}else td.textContent=r.mock?'giả lập':'';tr.appendChild(td);t.appendChild(tr)})}catch(e){}}
load();setInterval(load,3000);
</script></body></html>)html";

void handleLatest() {
  String j = "{\"have\":" + String(haveResult ? "true" : "false");
  if (haveResult) {
    Level lh = levelHR(resultHR), ls = levelSpO2(resultSpO2);
    j += ",\"heart_rate\":" + String(resultHR) + ",\"spo2\":" + String(resultSpO2) +
         ",\"heart_rate_status\":\"" + levelWordHR(lh) + "\",\"spo2_status\":\"" + levelWordSpO2(ls) + "\"" +
         ",\"emergency\":" + ((lh == ALERT || ls == ALERT) ? "true" : "false") +
         ",\"mock\":" + (resultMock ? "true" : "false") + ",\"time\":\"" + resultTime + "\"" +
         ",\"link\":\"" + latestLink() + "\"";
  }
  j += ",\"device\":\"" + String(DEVICE_NAME) + "\"}";
  web.send(200, "application/json", j);
}

void handleHistory() {                       // newest first
  String j = "[";
  for (int i = histCount - 1; i >= 0; i--) {
    const Rec& r = hist[i];
    if (i != histCount - 1) j += ",";
    String link = (r.flags & 1) || !r.t ? "" : geneSenseLink(r.hr, r.spo2, r.t);   // old readings need their time
    j += "{\"t\":\"" + recTime(r) + "\",\"hr\":" + String(r.hr) + ",\"spo2\":" + String(r.spo2) +
         ",\"mock\":" + String(r.flags & 1 ? "true" : "false") + ",\"link\":\"" + link + "\"}";
  }
  web.send(200, "application/json", j + "]");
}

const char SETUP_TOP[] PROGMEM = R"html(<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Cài Wi-Fi GeneSense</title>
<style>body{font-family:"Be Vietnam Pro",system-ui,sans-serif;background:#f4f8ff;color:#10264b;margin:0;padding:16px;font-size:20px;line-height:1.5}
h1{font-size:26px;color:#0d2c69}label{display:block;margin:16px 0 6px;font-weight:600}
select,input{width:100%;min-height:52px;font-size:20px;padding:10px 14px;border-radius:12px;border:1px solid #b7c7dc;background:#fff;color:#10264b;box-sizing:border-box}
button{width:100%;min-height:56px;margin-top:22px;padding:14px;font-size:22px;border:0;border-radius:12px;background:#0756ce;color:#fff;font-weight:700}
.muted{color:#52627a;font-size:17px}</style></head><body><h1>Cài Wi-Fi cho máy đo</h1>
<p class="muted">Chỉ dùng Wi-Fi 2.4 GHz. Mật khẩu chỉ lưu trong máy đo.</p>
<form method="post" action="/save"><label>Chọn Wi-Fi</label><select name="ssid">)html";

const char SETUP_BOTTOM[] PROGMEM = R"html(</select>
<label>Hoặc gõ tên Wi-Fi (nếu không có trong danh sách)</label><input name="ssid2" maxlength="32" autocomplete="off">
<label>Mật khẩu Wi-Fi</label><input name="pass" type="password" maxlength="63">
<label>Khóa Gemini (cho giọng nói, không bắt buộc)</label><input name="gkey" type="password" maxlength="60" autocomplete="off">)html";

const char SETUP_END[] PROGMEM = R"html(<button type="submit">Lưu và nối</button></form></body></html>)html";

void handleRoot() {
  if (!setupActive) { web.send_P(200, "text/html; charset=utf-8", PAGE); return; }
  String page = FPSTR(SETUP_TOP);
  page += setupNetworks;
  page += FPSTR(SETUP_BOTTOM);
  page += geminiKey.length() ? "<p class=\"muted\">Máy đã có khóa. Để trống để giữ khóa cũ.</p>"
                             : "<p class=\"muted\">Chưa có khóa: máy chỉ kêu bíp. Lấy khóa miễn phí tại aistudio.google.com.</p>";
  page += FPSTR(SETUP_END);
  web.send(200, "text/html; charset=utf-8", page);
  if (setupStep < 2) { setupStep = 2; dirty = true; }
}

void handleSave() {
  if (!setupActive) { web.send(403, "text/plain", "Setup is not running"); return; }
  String ssid = web.arg("ssid2");
  ssid.trim();
  if (!ssid.length()) ssid = web.arg("ssid");
  String pass = web.arg("pass");
  if (ssid.length() < 1 || ssid.length() > 32 || (pass.length() > 0 && pass.length() < 8) || pass.length() > 63) {
    web.send(400, "text/html; charset=utf-8", "<meta charset=utf-8><h2>Tên hoặc mật khẩu Wi-Fi không đúng dạng (mật khẩu 8-63 ký tự).</h2><a href=/>Quay lại</a>");
    return;
  }
  String key = web.arg("gkey");
  key.trim();
  if (key.length() && !keyLooksRight(key)) {
    web.send(400, "text/html; charset=utf-8", "<meta charset=utf-8><h2>Khóa Gemini không đúng dạng. Hãy chép lại cả khóa (bắt đầu bằng AIza).</h2><a href=/>Quay lại</a>");
    return;
  }
  if (key.length()) {
    geminiKey = key;
    prefs.putString("gkey", key);
    voiceProblem = 0;
    Serial.println("Gemini key saved");
  }
  wifiSsid = ssid;
  wifiPass = pass;
  prefs.putString("ssid", wifiSsid);
  prefs.putString("pass", wifiPass);
  web.send(200, "text/html; charset=utf-8", "<meta charset=utf-8><meta name=viewport content='width=device-width'>"
           "<body style='font-family:sans-serif;font-size:22px;padding:16px'><h2>Đã lưu.</h2>"
           "<p>Máy đo đang nối Wi-Fi <b>" + htmlEscape(ssid) + "</b>. Xem kết quả trên màn hình máy đo.</p></body>");
  Serial.printf("Wi-Fi saved: \"%s\", connecting\n", wifiSsid.c_str());
  WiFi.disconnect(false);
  WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
  setupStep = 3;
  setupTimer = millis();
  dirty = true;
}

void handleNotFound() {
  if (setupActive) {                         // phones look for the internet: send them to the setup page
    web.sendHeader("Location", "http://192.168.4.1/", true);
    web.send(302, "text/plain", "");
  } else {
    web.send(404, "text/plain", "Not found");
  }
}

void startWeb() {
  if (webStarted) return;
  web.on("/", handleRoot);
  web.on("/api/latest", handleLatest);
  web.on("/api/history", handleHistory);
  web.on("/save", HTTP_POST, handleSave);
  web.onNotFound(handleNotFound);
  web.begin();
  webStarted = true;
}

void loadGeminiKey() {                       // a key in the sketch wins and is saved; else the saved one
  String k = GEMINI_KEY;
  k.trim();
  if (k.length()) { if (prefs.getString("gkey", "") != k) prefs.putString("gkey", k); }
  else k = prefs.getString("gkey", "");
  geminiKey = k;
  Serial.println(geminiKey.length() ? "Gemini key: saved in the device" : "Gemini key: none (beeps only)");
}

bool keyLooksRight(const String& k) {        // Google keys: letters, digits, - and _
  if (k.length() < 30 || k.length() > 60) return false;
  for (unsigned i = 0; i < k.length(); i++) if (!isalnum((unsigned char)k[i]) && k[i] != '-' && k[i] != '_') return false;
  return true;
}

void startWifi() {
  loadGeminiKey();
  wifiSsid = prefs.getString("ssid", WIFI_NAME);
  wifiPass = prefs.getString("pass", WIFI_PASSWORD);
  if (!wifiSsid.length()) { Serial.println("No Wi-Fi set: use Menu > Cài Wi-Fi"); return; }
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
  Serial.printf("Connecting to Wi-Fi \"%s\" (must be 2.4 GHz)\n", wifiSsid.c_str());
}

// Wi-Fi setup: the device makes its own Wi-Fi, the phone joins it by QR code and fills in a form.
void startSetup() {
  setupActive = true;
  setupStep = 0;
  render();                                  // show "searching" while the scan runs
  // Stop trying the saved Wi-Fi first: while it keeps retrying, the radio hops between channels
  // and phones cannot join the setup Wi-Fi.
  WiFi.setAutoReconnect(false);
  WiFi.disconnect(false);
  delay(100);
  WiFi.mode(WIFI_AP_STA);                    // keep Wi-Fi modem sleep ON: with Bluetooth running, turning it off crashes the board
  int n = WiFi.scanNetworks();
  setupNetworks = "";
  int shown = 0;
  for (int i = 0; i < n && shown < 20; i++) {
    String name = WiFi.SSID(i);
    if (!name.length() || setupNetworks.indexOf(">" + htmlEscape(name) + "<") >= 0) continue;   // skip hidden and repeats
    setupNetworks += "<option value=\"" + htmlEscape(name) + "\"" + (name == wifiSsid ? " selected" : "") + ">" +
                     htmlEscape(name) + "</option>";
    shown++;
  }
  WiFi.scanDelete();
  if (!shown) setupNetworks = "<option value=\"\">(không thấy Wi-Fi nào, hãy gõ tên bên dưới)</option>";
  setupPass = "";
  for (int i = 0; i < 8; i++) setupPass += (char)('0' + esp_random() % 10);   // new password every time
  WiFi.softAP(SETUP_WIFI_NAME, setupPass.c_str(), 1, 0, 2);   // channel 1, visible, 2 phones at most
  delay(200);
  dns.start(53, "*", WiFi.softAPIP());
  startWeb();
  setupStep = 1;
  dirty = true;
  Serial.printf("Setup Wi-Fi \"%s\" started, %d networks found\n", SETUP_WIFI_NAME, shown);
}

void stopSetup() {
  if (!setupActive) return;
  setupActive = false;
  dns.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  if (WiFi.status() != WL_CONNECTED && wifiSsid.length()) WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
}

void wifiLoop() {
  if (setupActive) {
    dns.processNextRequest();
    if (setupStep == 1 && WiFi.softAPgetStationNum() > 0) { setupStep = 2; dirty = true; }   // phone joined
    if (setupStep == 3) {
      if (WiFi.status() == WL_CONNECTED) { setupStep = 4; setupTimer = millis(); dirty = true; }
      else if (millis() - setupTimer > 25000) {
        setupStep = 5;
        dirty = true;
        WiFi.disconnect(false);              // stop trying, so the phone can stay on the device's Wi-Fi
        Serial.println("Could not join the Wi-Fi");
      }
    }
    if (setupStep == 4 && millis() - setupTimer > 6000) {
      stopSetup();
      showToast("Đã nối Wi-Fi", C_GREEN);
      startVoiceTask();                      // a key may have been typed on the setup page
      goTo(S_IDLE);
    }
  }
  bool up = wifiSsid.length() && WiFi.status() == WL_CONNECTED;
  if (up && !wifiWasUp) {
    Serial.println("Wi-Fi connected, IP " + WiFi.localIP().toString());
    configTzTime("ICT-7", "pool.ntp.org", "time.google.com");   // Vietnam time
    startWeb();
    static bool mdnsStarted = false;
    if (!mdnsStarted && MDNS.begin("genesense-k10")) { MDNS.addService("http", "tcp", 80); mdnsStarted = true; }
    startVoiceTask();
    dirty = true;
  }
  if (!up && wifiWasUp) dirty = true;
  wifiWasUp = up;
  if (webStarted) web.handleClient();
}

// =====================================================================
// Drawing
// =====================================================================
// Light theme, same colours, words and status shapes as the GeneSense app.
// Everything is drawn anti-aliased straight into the frame buffer.
const int HEAD_H = 40;                       // header height
const int BTN_Y = H - 66, BTN_H = 38;        // A/B button hints
const int STRIP_Y = H - 22;                  // "test device" strip

inline uint16_t mix565(uint16_t bg, uint16_t fg, int a) {   // a = 0..256
  int rb = bg >> 11, gb = (bg >> 5) & 63, bb = bg & 31;
  int rf = fg >> 11, gf = (fg >> 5) & 63, bf = fg & 31;
  return ((rb + (((rf - rb) * a) >> 8)) << 11) | ((gb + (((gf - gb) * a) >> 8)) << 5) | (bb + (((bf - bb) * a) >> 8));
}

inline void plot(int x, int y, uint16_t c, int a) {
  if ((unsigned)x >= (unsigned)W || (unsigned)y >= (unsigned)H || a <= 0) return;
  uint16_t* p = cv->getBuffer() + y * W + x;
  *p = a >= 256 ? c : mix565(*p, c, a);
}

inline int cover(float outside) {            // distance outside the edge -> 0..256
  float a = 0.5f - outside;
  return a <= 0 ? 0 : a >= 1 ? 256 : (int)(a * 256);
}

void fillRR(int x, int y, int w, int h, int r, uint16_t c) {   // rounded rectangle
  r = min(r, min(w, h) / 2);
  if (r <= 0) { cv->fillRect(x, y, w, h, c); return; }
  cv->fillRect(x + r, y, w - 2 * r, h, c);
  cv->fillRect(x, y + r, r, h - 2 * r, c);
  cv->fillRect(x + w - r, y + r, r, h - 2 * r, c);
  for (int j = 0; j < r; j++)
    for (int i = 0; i < r; i++) {
      float dx = r - i - 0.5f, dy = r - j - 0.5f;
      int a = cover(sqrtf(dx * dx + dy * dy) - r);
      plot(x + i, y + j, c, a);
      plot(x + w - 1 - i, y + j, c, a);
      plot(x + i, y + h - 1 - j, c, a);
      plot(x + w - 1 - i, y + h - 1 - j, c, a);
    }
}

void card(int x, int y, int w, int h, int r, uint16_t fill, uint16_t border, int bw = 1) {
  fillRR(x, y, w, h, r, border);
  fillRR(x + bw, y + bw, w - 2 * bw, h - 2 * bw, r - bw, fill);
}

void disc(float cx, float cy, float r, uint16_t c) {
  for (int y = (int)(cy - r - 1); y <= (int)(cy + r + 1); y++)
    for (int x = (int)(cx - r - 1); x <= (int)(cx + r + 1); x++) {
      float dx = x + 0.5f - cx, dy = y + 0.5f - cy;
      plot(x, y, c, cover(sqrtf(dx * dx + dy * dy) - r));
    }
}

void line(float x0, float y0, float x1, float y1, float width, uint16_t c) {   // round ends
  float r = width / 2, vx = x1 - x0, vy = y1 - y0, len2 = vx * vx + vy * vy;
  for (int y = (int)(min(y0, y1) - r - 1); y <= (int)(max(y0, y1) + r + 1); y++)
    for (int x = (int)(min(x0, x1) - r - 1); x <= (int)(max(x0, x1) + r + 1); x++) {
      float px = x + 0.5f - x0, py = y + 0.5f - y0;
      float t = len2 > 0 ? constrain((px * vx + py * vy) / len2, 0.0f, 1.0f) : 0;
      float dx = px - t * vx, dy = py - t * vy;
      plot(x, y, c, cover(sqrtf(dx * dx + dy * dy) - r));
    }
}

void poly(const float* p, int n, uint16_t c) {   // convex polygon, points x0,y0,x1,y1...
  float lo = 1e9, hi = -1e9, top = 1e9, bot = -1e9, area = 0;
  for (int i = 0; i < n; i++) {
    lo = min(lo, p[2 * i]); hi = max(hi, p[2 * i]);
    top = min(top, p[2 * i + 1]); bot = max(bot, p[2 * i + 1]);
    int j = (i + 1) % n;
    area += p[2 * i] * p[2 * j + 1] - p[2 * j] * p[2 * i + 1];
  }
  float s = area > 0 ? 1 : -1;
  for (int y = (int)top - 1; y <= (int)bot + 1; y++)
    for (int x = (int)lo - 1; x <= (int)hi + 1; x++) {
      float out = -1e9, px = x + 0.5f, py = y + 0.5f;
      for (int i = 0; i < n; i++) {
        int j = (i + 1) % n;
        float ex = p[2 * j] - p[2 * i], ey = p[2 * j + 1] - p[2 * i + 1], len = sqrtf(ex * ex + ey * ey);
        if (len < 1e-3f) continue;
        out = max(out, s * ((px - p[2 * i]) * ey - (py - p[2 * i + 1]) * ex) / len);
      }
      plot(x, y, c, cover(out));
    }
}

// Part of a thick circle from 12 o'clock, clockwise, with round ends.
void ring(float cx, float cy, float r0, float r1, float frac, uint16_t c) {
  if (frac <= 0) return;
  float end = frac * 2 * PI;
  for (int y = (int)(cy - r1 - 1); y <= (int)(cy + r1 + 1); y++)
    for (int x = (int)(cx - r1 - 1); x <= (int)(cx + r1 + 1); x++) {
      float dx = x + 0.5f - cx, dy = y + 0.5f - cy, d = sqrtf(dx * dx + dy * dy);
      if (frac < 1) {
        float a = atan2f(dx, -dy);
        if (a < 0) a += 2 * PI;
        if (a > end) continue;
      }
      plot(x, y, c, cover(max(r0 - d, d - r1)));
    }
  if (frac < 1) {
    float rm = (r0 + r1) / 2, rc = (r1 - r0) / 2;
    disc(cx, cy - rm, rc, c);
    disc(cx + rm * sinf(end), cy - rm * cosf(end), rc, c);
  }
}

// ---------- text (Be Vietnam Pro, from gs_fonts.h) ----------
uint32_t nextChar(const char*& p) {          // UTF-8 -> code point
  uint8_t c = *p++;
  if (c < 0x80) return c;
  int n = c >= 0xF0 ? 3 : c >= 0xE0 ? 2 : 1;
  uint32_t cp = c & (0x3F >> n);
  while (n-- && (*p & 0xC0) == 0x80) cp = cp << 6 | (*p++ & 0x3F);
  return cp;
}

const GSGlyph* glyphOf(const GSFont& f, uint32_t cp) {
  int lo = 0, hi = f.n - 1;
  while (lo <= hi) {
    int m = (lo + hi) / 2;
    if (f.g[m].cp == cp) return &f.g[m];
    if (f.g[m].cp < cp) lo = m + 1; else hi = m - 1;
  }
  return cp == '?' ? &f.g[0] : glyphOf(f, '?');   // a missing letter shows as "?"
}

int textW(const String& s, const GSFont& f) {
  int pen = 0;
  for (const char* p = s.c_str(); *p;) pen += glyphOf(f, nextChar(p))->adv;
  return (pen + 8) / 16;
}

int text(int x, int base, const String& s, uint16_t c, const GSFont& f) {   // returns the x after the text
  int pen = x * 16;
  for (const char* p = s.c_str(); *p;) {
    const GSGlyph* g = glyphOf(f, nextChar(p));
    int gx = (pen + 8) / 16 + g->x, gy = base + g->y;
    const uint8_t* b = f.bmp + g->off;
    for (int i = 0; i < g->w * g->h; i++) {
      int a = i & 1 ? b[i >> 1] & 15 : b[i >> 1] >> 4;
      if (a) plot(gx + i % g->w, gy + i / g->w, c, a == 15 ? 256 : a * 17);
    }
    pen += g->adv;
  }
  return (pen + 8) / 16;
}

void textC(int cx, int base, const String& s, uint16_t c, const GSFont& f) { text(cx - textW(s, f) / 2, base, s, c, f); }
void textR(int right, int base, const String& s, uint16_t c, const GSFont& f) { text(right - textW(s, f), base, s, c, f); }

// Splits text into lines that fit maxW; returns how many lines.
int splitLines(const String& s, const GSFont& f, int maxW, String* out, int maxLines) {
  int n = 0;
  String line, word, rest = s + " ";
  for (unsigned i = 0; i < rest.length(); i++) {
    char ch = rest[i];
    if (ch != ' ') { word += ch; continue; }
    String test = line.length() ? line + " " + word : word;
    if (line.length() && textW(test, f) > maxW) {
      if (n < maxLines) out[n++] = line;
      line = word;
    } else {
      line = test;
    }
    word = "";
  }
  if (line.length() && n < maxLines) out[n++] = line;
  return n;
}

// Centred, word-wrapped text; returns the baseline of the next line.
int wrapC(int base, const String& s, uint16_t c, const GSFont& f, int maxW = W - 24) {
  String lines[5];
  int n = splitLines(s, f, maxW, lines, 5);
  for (int i = 0; i < n; i++) { textC(W / 2, base, lines[i], c, f); base += f.lineH; }
  return base;
}

// ---------- pieces ----------
void logo(int x, int y, int s) {             // the app's mark: navy square, white plus, pulse line
  float k = s / 64.0f;
  fillRR(x, y, s, s, (int)(12 * k + 0.5f), C_LOGO);
  line(x + 32 * k, y + 14 * k, x + 32 * k, y + 50 * k, 9 * k, C_SURF);
  line(x + 14 * k, y + 32 * k, x + 50 * k, y + 32 * k, 9 * k, C_SURF);
  const float pt[] = {20, 38, 27, 38, 31, 26, 36, 43, 40, 34, 47, 34};
  for (int i = 0; i < 5; i++)
    line(x + pt[2 * i] * k, y + pt[2 * i + 1] * k, x + pt[2 * i + 2] * k, y + pt[2 * i + 3] * k, max(1.4f, 3 * k), C_PULSE);
}

void heart(float x, float y, float s, uint16_t c) {   // centre x, y; s = half width
  disc(x - s / 2, y - s / 6, s / 2 + 0.5f, c);
  disc(x + s / 2, y - s / 6, s / 2 + 0.5f, c);
  const float p[] = {x - s - 0.3f, y + s / 10, x + s + 0.3f, y + s / 10, x, y + s};
  poly(p, 3, c);
}

// Status by shape AND word, never colour alone: circle = safe, triangle = attention, octagon = danger.
void mark(float x, float y, Level l, float s = 14, uint16_t c = 0) {   // top-left corner
  uint16_t col = c ? c : levelColor(l);
  if (l == SAFE) { disc(x + s / 2, y + s / 2, s / 2, col); return; }
  if (l == ATTN) { const float p[] = {x + s / 2, y, x + s, y + s, x, y + s}; poly(p, 3, col); return; }
  float a = s * 0.3f, b = s * 0.7f;
  const float p[] = {x + a, y, x + b, y, x + s, y + a, x + s, y + b, x + b, y + s, x + a, y + s, x, y + b, x, y + a};
  poly(p, 8, col);
}

void statusIcon(int cx, int cy, Level l) {   // big round icon: tick, or "!"
  if (l == SAFE) {
    disc(cx, cy, 22, C_GREEN);
    line(cx - 10, cy + 1, cx - 3, cy + 8, 4, C_SURF);
    line(cx - 3, cy + 8, cx + 10, cy - 7, 4, C_SURF);
    return;
  }
  uint16_t c = l == ATTN ? C_AMBER : C_RED;
  if (l == ATTN) { const float p[] = {(float)cx, cy - 22.0f, cx + 24.0f, cy + 19.0f, cx - 24.0f, cy + 19.0f}; poly(p, 3, c); }
  else mark(cx - 22, cy - 22, ALERT, 44);
  line(cx, cy - (l == ATTN ? 7 : 11), cx, cy + (l == ATTN ? 5 : 3), 4.5f, C_SURF);
  disc(cx, cy + (l == ATTN ? 12 : 11), 2.6f, C_SURF);
}

uint16_t levelBg(Level l) { return l == ALERT ? C_RED_BG : l == ATTN ? C_AMBER_BG : C_GREEN_BG; }

int tagW(const char* word, const GSFont& f) { return 30 + textW(word, f) + 10; }

void tag(int x, int y, Level l, const char* word, const GSFont& f = GS_BOLD) {   // like .tag in the app, 28 tall
  fillRR(x, y, tagW(word, f), 28, 6, levelBg(l));
  mark(x + 9, y + 7, l);
  text(x + 30, y + 20, word, levelColor(l), f);
}

void wifiIcon(int cx, int cy, uint16_t c) {  // three arcs and a dot
  for (int k = 0; k < 2; k++) {
    float r = 4.5f + k * 4.5f;
    for (int i = -4; i < 4; i++) {
      float a0 = i * 0.2f, a1 = (i + 1) * 0.2f;
      line(cx + r * sinf(a0), cy - r * cosf(a0), cx + r * sinf(a1), cy - r * cosf(a1), 1.8f, c);
    }
  }
  disc(cx, cy, 1.6f, c);
}

void btIcon(int cx, int cy, uint16_t c) {    // the Bluetooth rune
  line(cx, cy - 7, cx, cy + 7, 1.6f, c);
  line(cx, cy - 7, cx + 4, cy - 3.5f, 1.6f, c);
  line(cx + 4, cy - 3.5f, cx - 4, cy + 3.5f, 1.6f, c);
  line(cx, cy + 7, cx + 4, cy + 3.5f, 1.6f, c);
  line(cx + 4, cy + 3.5f, cx - 4, cy - 3.5f, 1.6f, c);
}

int chip(int right, bool on, bool wifi) {    // connected = filled blue; not = outline with a slash
  int x = right - 22, y = 9;
  if (on) fillRR(x, y, 22, 22, 7, C_BLUE);
  else card(x, y, 22, 22, 7, C_SURF, C_LINE2);
  uint16_t c = on ? C_SURF : C_INK2;
  if (wifi) wifiIcon(x + 11, y + 17, c); else btIcon(x + 11, y + 11, c);
  if (!on) line(x + 4, y + 18, x + 18, y + 4, 1.6f, C_INK2);
  return x - 3;
}

void topBar() {
  cv->fillRect(0, 0, W, HEAD_H, C_SURF);
  cv->drawFastHLine(0, HEAD_H, W, C_LINE);
  logo(6, 9, 22);
  text(34, 26, "GeneSense", C_NAVY, GS_BOLD);
  int x = chip(W - 6, bleConnected, false);
  if (wifiSsid.length()) x = chip(x, WiFi.status() == WL_CONNECTED, true);
  String t = clockText();
  if (t.length()) textR(x - 3, 26, t, C_INK2, GS_SMALL);
}

void bottomBanner() {
  cv->fillRect(0, STRIP_Y, W, H - STRIP_Y, C_AMBER_BG);
  cv->drawFastHLine(0, STRIP_Y, W, C_AMBER_LINE);
  textC(W / 2, H - 6, mockMode() ? "THỬ NGHIỆM · SỐ LIỆU GIẢ LẬP" : "THIẾT BỊ THỬ NGHIỆM", C_AMBER, GS_SMALL);
}

enum BtnStyle { BTN_MAIN, BTN_PLAIN, BTN_ON_RED };

void buttonHint(bool left, const char* label, BtnStyle st = BTN_PLAIN) {
  if (!label) return;
  int w = (W - 18) / 2, x = left ? 6 : W - 6 - w, y = BTN_Y;
  uint16_t fg = C_BLUE, badge = C_BLUE_SOFT, letter = C_BLUE;
  if (st == BTN_MAIN) { fillRR(x, y, w, BTN_H, 12, C_BLUE); fg = C_SURF; badge = C_SURF; }
  else if (st == BTN_ON_RED) { card(x, y, w, BTN_H, 12, C_RED_SOLID, C_SURF, 2); fg = C_SURF; badge = C_SURF; letter = C_RED_SOLID; }
  else card(x, y, w, BTN_H, 12, C_SURF, C_LINE2);
  disc(x + 17, y + BTN_H / 2.0f, 10, badge);   // the letter of the key to press
  textC(x + 17, y + BTN_H / 2 + 6, left ? "A" : "B", letter, GS_BOLD);
  const GSFont& f = textW(label, GS_BOLD) <= w - 34 ? GS_BOLD : GS_SMALL;
  textC(x + 30 + (w - 34) / 2, y + BTN_H / 2 + 6, label, fg, f);
}

void drawToast(bool top = false) {           // a short message for a few seconds
  if (!toastText.length() || millis() > toastUntil) return;
  Level l = toastColor == C_GREEN ? SAFE : toastColor == C_AMBER ? ATTN : ALERT;
  String lines[2];
  const GSFont* f = &GS_BOLD;
  int n = splitLines(toastText, *f, W - 66, lines, 2);
  if (n > 1) { f = &GS_BODY; n = splitLines(toastText, *f, W - 66, lines, 2); }
  int h = n > 1 ? 58 : 40, y = top ? 6 : BTN_Y - 8 - h;
  card(10, y, W - 20, h, 12, levelBg(l), mix565(levelBg(l), levelColor(l), 90));
  mark(22, y + h / 2 - 7, l);
  for (int i = 0; i < n; i++) text(46, y + 26 + i * 20 - (n > 1 ? 1 : 0), lines[i], levelColor(l), *f);
}

void drawWave(int x, int y, int w, int h) {  // mock pulse wave
  if (waveCount < 2) return;
  float lo = 1e9, hi = -1e9;
  for (int i = 0; i < waveCount; i++) { lo = min(lo, wave[i]); hi = max(hi, wave[i]); }
  if (hi - lo < 1e-6f) hi = lo + 1;
  int n = min(waveCount, 120);
  float px = 0, py = 0;
  for (int i = 0; i < n; i++) {
    float v = wave[(waveHead - n + i + 200) % 200];
    float xx = x + i * (w - 1) / 119.0f, yy = y + h - 3 - (v - lo) / (hi - lo) * (h - 6);
    if (i) line(px, py, xx, yy, 2, C_CHART);
    px = xx;
    py = yy;
  }
}

void screenStart() {
  cv->fillScreen(C_BG);
  topBar();
}

void title(const String& s, int base = 68) { text(12, base, s, C_INK, GS_TITLE); }

// ---------- screens ----------
void statusRow(int y, int h, const char* label, const String& value, bool last, int warn = 0) {   // warn: 1 = triangle
  text(22, y + h / 2 + 5, label, C_INK2, GS_SMALL);
  int r = W - 22, room = r - 22 - textW(label, GS_SMALL) - 10 - (warn ? 18 : 0);
  const GSFont& f = textW(value, GS_BOLD) <= room ? GS_BOLD : GS_SMALL;
  textR(r, y + h / 2 + 6, value, warn ? C_AMBER : C_INK, f);
  if (warn) mark(r - textW(value, f) - 18, y + h / 2 - 6, ATTN, 12);
  if (!last) cv->drawFastHLine(20, y + h, W - 40, C_LINE);
}

void drawIdle() {
  screenStart();
  card(8, 48, W - 16, 92, 16, C_SURF, C_LINE);
  textC(W / 2, 82, "Bấm nút A", C_INK, GS_BIG);
  textC(W / 2, 108, "để bắt đầu đo", C_INK2, GS_TITLE);
  if (haveResult) textC(W / 2, 130, "Lần trước: " + String(resultHR) + " lần/phút · " + String(resultSpO2) + "%", C_INK2, GS_SMALL);
  else {
    float beat = 0.5f + 0.5f * sinf(millis() / 300.0f);
    heart(W / 2, 124, 6 + beat, C_BLUE);
  }

  int need = voiceNeeded(), have = min(voiceCount(), need);
  bool vWarn = have < need && (!fsOk || !geminiKey.length() || voiceProblem == 401);
  String v = have >= need ? (store ? "Sẵn sàng" : "Sẵn sàng (tạm)")
           : !fsOk ? "Không có chỗ lưu"
           : !geminiKey.length() ? "Chưa có khóa"
           : voiceProblem == 401 ? "Khóa sai"
           : voiceTaskRunning && !voiceProblem ? "Đang tạo " + String(have) + "/" + String(need)
           : voiceProblem == 429 ? "Hết lượt, thử lại sau"
           : voiceProblem == -1 ? "Lỗi mạng, thử lại sau"
           : voiceProblem == -2 ? "Google chưa trả lời"
           : voiceProblem == -3 ? "Âm thanh hỏng, thử lại"
           : voiceProblem ? "Lỗi " + String(voiceProblem) + ", thử lại sau"
           : WiFi.status() != WL_CONNECTED ? "Chờ Wi-Fi"
           : have ? "Có " + String(have) + "/" + String(need) : "Chờ tạo";
  int rows = 3 + (USE_SEN0518 ? 1 : 0) + (mockMode() ? 1 : 0);
  int y = 144, h = rows > 4 ? 19 : 24;
  card(8, y, W - 16, rows * h + 8, 16, C_SURF, C_LINE);
  y += 4;
  int i = 0;
  if (USE_SEN0518) {
    if (!sensorOk) statusRow(y, h, "Cảm biến", "Không thấy", ++i == rows, 1);
    else if (ioErrors >= 3) statusRow(y, h, "Cảm biến", "Mất kết nối", ++i == rows, 1);
    else statusRow(y, h, "Cảm biến", "Đã nối", ++i == rows);
    y += h;
  }
  statusRow(y, h, "Bluetooth", bleConnected ? "Đã nối" : "Chờ điện thoại", ++i == rows);
  y += h;
  statusRow(y, h, "Wi-Fi", !wifiSsid.length() ? "Chưa cài (Menu)" : WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : "Đang nối...", ++i == rows);
  y += h;
  statusRow(y, h, "Giọng nói", v, ++i == rows, vWarn);
  y += h;
  if (mockMode()) statusRow(y, h, "Thử cấp cứu", demoLow ? "BẬT · A+B tắt" : "A+B để bật", ++i == rows, demoLow);
  buttonHint(true, "Bắt đầu", BTN_MAIN);
  buttonHint(false, "Menu");
  drawToast();
  bottomBanner();
}

void drawMenu() {
  screenStart();
  const int RH = min(40, (BTN_Y - 8 - 48 - 8) / MENU_COUNT);
  card(8, 48, W - 16, MENU_COUNT * RH + 8, 16, C_SURF, C_LINE);
  for (int i = 0; i < MENU_COUNT; i++) {
    int y = 52 + i * RH;
    bool sel = i == menuSel;
    uint16_t c = i == MENU_CLEAR ? C_RED : C_INK;
    if (sel) {
      fillRR(12, y + 2, W - 24, RH - 4, 10, C_BLUE_SOFT);
      const float p[] = {22, y + RH / 2.0f - 7, 22, y + RH / 2.0f + 7, 31, y + RH / 2.0f};   // arrow, not just colour
      poly(p, 3, C_BLUE);
    } else if (i && i - 1 != menuSel) {
      cv->drawFastHLine(20, y, W - 40, C_LINE);
    }
    text(40, y + RH / 2 + 6, MENU_ITEMS[i], c, sel ? GS_BOLD : GS_BODY);
  }
  buttonHint(true, "Chọn", BTN_MAIN);
  buttonHint(false, "Xuống");
  drawToast();
  bottomBanner();
}

void miniChart(int y, int h, const char* label, bool isHR) {   // last 14 measurements
  card(8, y, W - 16, h, 16, C_SURF, C_LINE);
  text(20, y + 22, label, C_INK2, GS_SMALL);
  int n = min(histCount, 14);
  if (!n) { textC(W / 2, y + h / 2 + 12, "Chưa có lần đo", C_INK2, GS_BODY); return; }
  const Rec& last = hist[histCount - 1];
  int lastV = isHR ? last.hr : last.spo2;
  textR(W - 20, y + 25, String(lastV) + (isHR ? "" : "%"), C_INK, GS_TITLE);
  float lo = isHR ? 50 : 90, hi = isHR ? 110 : 100;
  for (int i = histCount - n; i < histCount; i++) {
    float v = isHR ? hist[i].hr : hist[i].spo2;
    lo = min(lo, v - 3);
    hi = max(hi, v + 3);
  }
  if (!isHR) hi = min(hi, 101.0f);
  int x0 = 26, x1 = W - 26, y0 = y + 34, y1 = y + h - 10;
  auto py = [&](float v) { return y1 - (v - lo) / (hi - lo) * (y1 - y0); };
  float bandLo = isHR ? 50 : 95, bandHi = isHR ? 110 : 100;   // the "An toàn" range, same as the app
  int by0 = constrain((int)py(bandHi), y0, y1), by1 = constrain((int)py(bandLo), y0, y1);
  fillRR(x0 - 6, by0, x1 - x0 + 12, by1 - by0, 4, C_GREEN_BG);
  auto px = [&](int k) { return n == 1 ? (x0 + x1) / 2.0f : x0 + k * (x1 - x0) / (float)(n - 1); };
  for (int k = 1; k < n; k++) {
    const Rec &a = hist[histCount - n + k - 1], &b = hist[histCount - n + k];
    line(px(k - 1), py(isHR ? a.hr : a.spo2), px(k), py(isHR ? b.hr : b.spo2), 2, C_CHART);
  }
  for (int k = 0; k < n; k++) {
    const Rec& r = hist[histCount - n + k];
    Level l = isHR ? levelHR(r.hr) : levelSpO2(r.spo2);
    float cx = px(k), cy = py(isHR ? r.hr : r.spo2), s = l == SAFE ? 8 : 10;
    mark(cx - s / 2 - 1, cy - s / 2 - 1, l, s + 2, C_SURF);   // white edge
    mark(cx - s / 2, cy - s / 2, l, s);
    if (r.flags & 1) mark(cx - s / 4, cy - s / 4 + (l == ATTN ? 1 : 0), l, s / 2, C_SURF);   // hollow = mock value
  }
}

bool historyHasMock() {
  for (int i = max(0, histCount - 14); i < histCount; i++) if (hist[i].flags & 1) return true;
  return false;
}

void drawHistory() {
  screenStart();
  title("Lịch sử đo", 70);
  if (histCount) textR(W - 12, 70, String(histCount) + " lần", C_INK2, GS_SMALL);
  miniChart(78, 74, "Nhịp tim · lần/phút", true);
  miniChart(158, 74, "Oxy trong máu · %", false);
  if (histCount) {
    String t = recTime(hist[histCount - 1]);
    if (historyHasMock()) textC(W / 2, BTN_Y - 4, "Chấm rỗng = số giả lập", C_INK2, GS_SMALL);
    else if (t.length()) textC(W / 2, BTN_Y - 4, "Mới nhất " + t, C_INK2, GS_SMALL);
  }
  buttonHint(true, "Đo", BTN_MAIN);
  buttonHint(false, "Về");
  bottomBanner();
}

void drawQRCode(int y, int box) {            // the cached QR, centred on a white card
  if (!qrSize) { textC(W / 2, y + box / 2, "Không tạo được mã QR", C_AMBER, GS_BOLD); return; }
  int scale = max(1, box / (qrSize + 4));
  int full = (qrSize + 4) * scale, x0 = (W - full) / 2;
  card(x0 - 4, y - 4, full + 8, full + 8, 12, C_SURF, C_LINE);
  for (int yy = 0; yy < qrSize; yy++)
    for (int xx = 0; xx < qrSize; xx++)
      if (qrMods[yy * 64 + xx]) cv->fillRect(x0 + (xx + 2) * scale, y + (yy + 2) * scale, scale, scale, C_BLACK);
}

void drawQRScreen() {
  screenStart();
  if (qrToGeneSense) {                       // straight into the GeneSense app: the phone needs internet, not this Wi-Fi
    int hr = 0, spo2 = 0;
    uint32_t epoch = 0;
    bool mock = false;
    bool ok = shareReading(hr, spo2, epoch, mock);
    if (ok) {
      makeQR(geneSenseLink(hr, spo2, epoch));
      textC(W / 2, 68, "Nhịp " + String(hr) + " · SpO2 " + String(spo2) + "%", C_INK, GS_TITLE);
      textC(W / 2, 88, "Quét để lưu vào GeneSense", C_INK2, GS_SMALL);
      drawQRCode(98, 148);
    } else {
      title("Lưu vào GeneSense");
      statusIcon(W / 2, 122, ATTN);
      wrapC(176, !haveResult && !histCount ? "Chưa có kết quả đo. Hãy đo trước." : mock ? "Số liệu giả lập không gửi sang GeneSense."
            : "Kết quả đã cũ và máy chưa có giờ. Hãy đo lại.", C_INK, GS_BODY);
    }
    buttonHint(true, "Máy đo");
    buttonHint(false, "Về");
    bottomBanner();
    return;
  }
  if (wifiSsid.length() && WiFi.status() == WL_CONNECTED) {
    String url = "http://" + WiFi.localIP().toString() + "/";
    makeQR(url);
    textC(W / 2, 68, "Xem trên điện thoại", C_INK, GS_TITLE);
    textC(W / 2, 88, "Cùng Wi-Fi · " + WiFi.localIP().toString(), C_INK2, GS_SMALL);
    drawQRCode(98, 148);
  } else {
    title("Xem trên điện thoại");
    statusIcon(W / 2, 122, ATTN);
    textC(W / 2, 176, "Chưa có Wi-Fi", C_INK, GS_BOLD);
    wrapC(200, "Vào Menu, chọn Cài Wi-Fi trước. Điện thoại và máy đo cần dùng chung một Wi-Fi.", C_INK2, GS_SMALL);
  }
  buttonHint(true, "GeneSense");
  buttonHint(false, "Về");
  bottomBanner();
}

void stepTag(int n) {                        // "Bước 1/2" on the right of the title
  String s = "Bước " + String(n) + "/2";
  int w = textW(s, GS_BOLD) + 20;
  fillRR(W - 12 - w, 50, w, 26, 6, C_BLUE_SOFT);
  text(W - 2 - w, 69, s, C_BLUE, GS_BOLD);
}

void drawWifiSetup() {
  screenStart();
  title("Cài Wi-Fi");
  if (setupStep == 0) {
    ring(W / 2, 140, 22, 28, 1, C_LINE);
    float a = (millis() % 1200) / 1200.0f;
    for (int i = 0; i < 6; i++) disc(W / 2 + 25 * sinf((a + i * 0.04f) * 2 * PI), 140 - 25 * cosf((a + i * 0.04f) * 2 * PI), 3, C_BLUE);
    textC(W / 2, 200, "Đang tìm Wi-Fi...", C_INK2, GS_BODY);
  } else if (setupStep == 1) {
    stepTag(1);
    wrapC(96, "Quét mã để nối điện thoại vào máy đo", C_INK, GS_BODY, 200);
    makeQR("WIFI:T:WPA;S:" + String(SETUP_WIFI_NAME) + ";P:" + setupPass + ";;");
    drawQRCode(128, 104);
    textC(W / 2, BTN_Y - 8, String(SETUP_WIFI_NAME) + " / " + setupPass, C_INK2, GS_SMALL);
  } else if (setupStep == 2) {
    stepTag(2);
    wrapC(96, "Quét mã để mở trang cài đặt", C_INK, GS_BODY, 160);
    makeQR("http://192.168.4.1/");
    drawQRCode(128, 104);
    textC(W / 2, BTN_Y - 8, "hoặc mở 192.168.4.1", C_INK2, GS_SMALL);
  } else if (setupStep == 3) {
    float a = (millis() % 1200) / 1200.0f;
    ring(W / 2, 130, 22, 28, 1, C_LINE);
    ring(W / 2, 130, 22, 28, 0.3f, C_BLUE);
    (void)a;
    textC(W / 2, 192, "Đang nối Wi-Fi...", C_INK, GS_TITLE);
    textC(W / 2, 216, wifiSsid.substring(0, 26), C_INK2, GS_SMALL);
  } else if (setupStep == 4) {
    statusIcon(W / 2, 126, SAFE);
    textC(W / 2, 186, "Đã nối Wi-Fi!", C_GREEN, GS_TITLE);
    textC(W / 2, 212, WiFi.localIP().toString(), C_INK2, GS_BODY);
  } else {
    statusIcon(W / 2, 110, ATTN);
    textC(W / 2, 164, "Chưa nối được", C_AMBER, GS_TITLE);
    wrapC(190, "Sai mật khẩu, hoặc Wi-Fi 5 GHz. Bấm A để nhập lại.", C_INK2, GS_SMALL);
  }
  if (setupStep == 5) buttonHint(true, "Thử lại", BTN_MAIN);
  buttonHint(false, "Hủy");
  bottomBanner();
}

void drawPlace() {
  screenStart();
  wrapC(70, sensorOk ? "Đeo cảm biến vào ngón tay" : "Đặt ngón tay lên cảm biến", C_INK, GS_TITLE, W - 40);
  // the sensor with its red light, a finger slowly coming down onto it
  float t = (millis() % 2000) / 2000.0f;
  int fy = 98 + (int)(22 * (t < 0.6f ? t / 0.6f : 1.0f));
  fillRR(64, 182, 112, 30, 10, C_LOGO);
  fillRR(102, 188, 36, 18, 6, C565(40, 56, 90));
  disc(W / 2, 197, 9 + 3 * sinf(millis() / 150.0f), C565(255, 120, 110));
  disc(W / 2, 197, 5, C565(255, 60, 50));
  fillRR(98, fy, 44, 90, 22, C_SKIN);
  fillRR(106, fy + 56, 28, 26, 11, C_NAIL);
  int y = 218;
  String s;
  if (sensorOk && goodStreak == 0) s = "Đang chờ cảm biến... " + String((millis() - stateSince) / 1000) + "s";
  else if (sensorOk) s = "Đã thấy ngón tay, giữ yên";
  else s = "Giữ yên tay, thở đều";
  int w = textW(s, GS_BOLD) + 24;
  fillRR((W - w) / 2, y, w, 28, 8, C_BLUE_SOFT);
  textC(W / 2, y + 20, s, C_BLUE, GS_BOLD);
  buttonHint(false, "Hủy");
  drawToast();
  bottomBanner();
}

void drawMeasure() {
  screenStart();
  long elapsed = (long)millis() - measureStart;
  bool holding = millis() < holdUntil;
  if (holding) {
    card(8, 48, W - 16, 40, 12, C_AMBER_BG, C_AMBER_LINE);
    int w = textW("Giữ yên tay!", GS_TITLE) + 22;
    mark((W - w) / 2, 61, ATTN);
    text((W - w) / 2 + 22, 76, "Giữ yên tay!", C_AMBER, GS_TITLE);
  } else {
    textC(W / 2, 68, "Đang đo...", C_INK, GS_TITLE);
    if (sensorOk) textC(W / 2, 87, "Đã đọc " + String(hrCount) + " lần · số mới mỗi 4 s", C_INK2, GS_SMALL);
  }
  float frac = constrain(elapsed / (measureSeconds() * 1000.0f), 0.0f, 1.0f);
  int cy = 152;
  ring(W / 2, cy, 46, 56, 1, C_LINE);
  ring(W / 2, cy, 46, 56, frac, holding ? C_AMBER : C_BLUE);
  int left = elapsed < 0 ? measureSeconds() : max(0, measureSeconds() - (int)(elapsed / 1000));
  textC(W / 2, cy + 16, String(left), C_INK, GS_HUGE);
  textC(W / 2, cy + 34, "giây", C_INK2, GS_SMALL);
  card(8, 214, W - 16, 34, 12, C_SURF, C_LINE);
  String live = "";
  if (liveHR > 0 && !holding) {
    live = "Nhịp " + String((int)roundf(liveHR));
    if (sensorOk && liveSpO2 > 0) live += " · " + String(liveSpO2) + "%";
  }
  if (holding) textC(W / 2, 236, "Đo lại từ đầu", C_AMBER, GS_BOLD);
  else if (sensorOk) {                       // the sensor gives numbers only, no pulse wave: show what was read
    textC(W / 2, 237, live.length() ? live : String("Chờ số đầu tiên..."), live.length() ? C_INK : C_INK2, GS_BOLD);
  } else {
    drawWave(18, 218, live.length() ? 130 : W - 36, 26);
    if (live.length()) textR(W - 20, 237, live, C_INK, GS_BOLD);
  }
  buttonHint(false, "Hủy");
  bottomBanner();
}

// One value as a tile: name, number, the app's range bar, and the status tag.
void resultTile(int x, int y, int w, int h, const char* label, const char* unit, int value, Level l, const char* word,
                int scaleMin, int scaleMax, const int* edges, const Level* zones, int nz) {
  card(x, y, w, h, 16, C_SURF, C_LINE);
  text(x + 12, y + 26, label, C_INK, GS_BOLD);
  text(x + 12, y + 45, unit, C_INK2, GS_SMALL);
  textC(x + w / 2, y + 98, String(value), C_INK, GS_NUM);
  int bx = x + 12, bw = w - 24, by = y + 112;
  auto pos = [&](float v) { return bx + (constrain(v, (float)scaleMin, (float)scaleMax) - scaleMin) * bw / (scaleMax - scaleMin); };
  const uint16_t ZC[] = {C_ZONE_SAFE, C_ZONE_ATTN, C_ZONE_ALERT};
  for (int i = 0; i < nz; i++) {
    int a = (int)pos(edges[i]) + (i ? 1 : 0), b = (int)pos(edges[i + 1]);
    fillRR(a, by, max(2, b - a), 6, 3, ZC[zones[i]]);
  }
  float m = pos(value);
  fillRR((int)m - 4, by - 7, 8, 20, 3, C_SURF);
  fillRR((int)m - 2, by - 5, 4, 16, 2, C_INK);
  String lines[2];
  int n = splitLines(word, GS_SMALL, w - 46, lines, 2);
  int ty = y + 134, th = h - 142;
  fillRR(x + 8, ty, w - 16, th, 8, levelBg(l));
  mark(x + 16, ty + th / 2 - 7, l);
  for (int i = 0; i < n; i++) text(x + 36, ty + th / 2 + 5 + (i * 2 - (n - 1)) * 9, lines[i], levelColor(l), GS_SMALL);
}

void drawResult() {
  screenStart();
  title("Kết quả đo", 68);
  String t = clockText();
  if (t.length()) textR(W - 12, 68, t, C_INK2, GS_SMALL);
  Level lh = levelHR(resultHR), ls = levelSpO2(resultSpO2);
  static const int hrEdges[] = {30, 40, 50, 110, 150, 170}, spEdges[] = {85, 90, 95, 100};
  static const Level hrZones[] = {ALERT, ATTN, SAFE, ATTN, ALERT}, spZones[] = {ALERT, ATTN, SAFE};
  int w = (W - 22) / 2;
  resultTile(8, 78, w, 172, "Nhịp tim", "lần/phút", resultHR, lh, levelWordHR(lh), 30, 170, hrEdges, hrZones, 5);
  resultTile(W - 8 - w, 78, w, 172, "Oxy máu", "SpO2, %", resultSpO2, ls, levelWordSpO2(ls), 85, 100, spEdges, spZones, 3);
  buttonHint(true, "Đo lại");
  buttonHint(false, resultSent ? "Gửi lại" : "Gửi", BTN_MAIN);
  drawToast();
  bottomBanner();
}

void drawEmergency() {
  bool flash = (millis() / 500) % 2;
  cv->fillScreen(C_RED_SOLID);
  if (flash) for (int i = 0; i < 4; i++) cv->drawRect(i, i, W - 2 * i, H - 2 * i, C_SURF);
  mark(W / 2 - 22, 14, ALERT, 44, C_SURF);   // octagon = danger, same as the app
  line(W / 2, 25, W / 2, 39, 4.5f, C_RED_SOLID);
  disc(W / 2, 47, 2.6f, C_RED_SOLID);
  textC(W / 2, 88, "NGUY HIỂM", C_SURF, GS_BIG);
  fillRR(14, 98, W - 28, 98, 16, C_SURF);
  textC(W / 2, 127, "Gọi cấp cứu", C_RED_SOLID, GS_TITLE);
  textC(W / 2, 185, "115", C_RED_SOLID, GS_HUGE);
  int y = 220;
  if (levelSpO2(resultSpO2) == ALERT) { textC(W / 2, y, "Oxy trong máu: " + String(resultSpO2) + "%", C_SURF, GS_BOLD); y += 20; }
  if (levelHR(resultHR) == ALERT) { textC(W / 2, y, "Nhịp tim: " + String(resultHR) + " lần/phút", C_SURF, GS_BOLD); y += 20; }
  if (y < 240) textC(W / 2, y, "Đo lại ngay. Khó thở: gọi 115", C_SURF, GS_SMALL);
  buttonHint(true, "Đo lại", BTN_ON_RED);
  buttonHint(false, resultSent ? "Đã gửi" : "Gửi", BTN_ON_RED);
  drawToast(true);                           // at the top, so the numbers stay readable
  bottomBanner();
}

void drawTemp() {
  screenStart();
  title("Nhiệt độ cơ thể");
  if (tempState == T_NOPROBE) {
    statusIcon(W / 2, 122, ATTN);
    textC(W / 2, 176, "Chưa thấy cảm biến nhiệt", C_INK, GS_BOLD);
    wrapC(200, "Cắm cảm biến DS18B20 vào cổng P1, rồi bấm A để thử lại.", C_INK2, GS_SMALL);
    buttonHint(true, "Thử lại", BTN_MAIN);
    buttonHint(false, "Về");
    bottomBanner();
    return;
  }
  bool done = tempState == T_DONE;
  float t = done ? tempResult : tempNow;
  card(8, 80, W - 16, 120, 16, C_SURF, C_LINE);
  if (t > 0) {
    char s[8];
    snprintf(s, sizeof(s), "%.1f", t);
    int w = textW(s, GS_HUGE), u = textW("°C", GS_TITLE);
    int x = (W - w - u - 4) / 2;
    text(x, 150, s, done || t >= 34 ? C_INK : C_INK2, GS_HUGE);
    text(x + w + 4, 120, "°C", C_INK2, GS_TITLE);
  } else {
    textC(W / 2, 140, "Đang đọc...", C_INK2, GS_BODY);
  }
  if (done) {
    Level l = levelTemp(t);
    const char* word = levelWordTemp(t);
    tag((W - tagW(word, GS_BOLD)) / 2, 162, l, word);
    textC(W / 2, 222, "Đo ở nách", C_INK2, GS_SMALL);
    textC(W / 2, 242, "Sốt từ 37,5 · sốt cao từ 39", C_INK2, GS_SMALL);
  } else {
    unsigned long secs = (millis() - tempStart) / 1000;
    char m[8];
    snprintf(m, sizeof(m), "%lu:%02lu", secs / 60, secs % 60);
    textC(W / 2, 182, t > 0 && t < 34 ? "Kẹp vào nách, khép tay lại" : String("Chờ số đứng yên · ") + m, C_INK2, GS_SMALL);
    float frac = min(1.0f, secs / 180.0f);   // about 3 minutes in the armpit
    fillRR(20, 210, W - 40, 8, 4, C_LINE);
    if (frac > 0) fillRR(20, 210, max(8, (int)((W - 40) * frac)), 8, 4, C_BLUE);
    textC(W / 2, 240, "Giữ yên tay, máy sẽ báo", C_INK2, GS_SMALL);
  }
  buttonHint(true, done ? "Đo lại" : nullptr, BTN_MAIN);
  buttonHint(false, "Về");
  drawToast();
  bottomBanner();
}

void drawBoot() {
  cv->fillScreen(C_BG);
  logo(W / 2 - 32, 92, 64);
  textC(W / 2, 192, "GeneSense", C_NAVY, GS_BIG);
  textC(W / 2, 218, "Đang khởi động...", C_INK2, GS_BODY);
}

void render() {
  switch (screenNow) {
    case S_IDLE: drawIdle(); break;
    case S_PLACE: drawPlace(); break;
    case S_MEASURE: drawMeasure(); break;
    case S_RESULT: drawResult(); break;
    case S_EMERGENCY: drawEmergency(); break;
    case S_MENU: drawMenu(); break;
    case S_HISTORY: drawHistory(); break;
    case S_QR: drawQRScreen(); break;
    case S_WIFISETUP: drawWifiSetup(); break;
    case S_TEMP: drawTemp(); break;
  }
  screen.pushImage(0, 0, W, H, cv->getBuffer());
}

// =====================================================================
// Body temperature: DS18B20 probe (1-Wire, one data wire with a pull-up on its adapter board)
// =====================================================================
portMUX_TYPE owMux = portMUX_INITIALIZER_UNLOCKED;

void owLow() { gpio_set_level((gpio_num_t)TEMP_PIN, 0); }
void owRelease() { gpio_set_level((gpio_num_t)TEMP_PIN, 1); }   // open drain: the pull-up makes it high
int owRead() { return gpio_get_level((gpio_num_t)TEMP_PIN); }

bool owReset() {                             // true = a probe answered
  if (TEMP_PIN < 0) return false;
  gpio_set_direction((gpio_num_t)TEMP_PIN, GPIO_MODE_INPUT_OUTPUT_OD);
  owLow();
  delayMicroseconds(480);
  portENTER_CRITICAL(&owMux);
  owRelease();
  delayMicroseconds(70);
  bool there = owRead() == 0;
  portEXIT_CRITICAL(&owMux);
  delayMicroseconds(410);
  return there;
}

void owWriteBit(int b) {
  portENTER_CRITICAL(&owMux);
  owLow();
  delayMicroseconds(b ? 6 : 60);
  owRelease();
  delayMicroseconds(b ? 64 : 10);
  portEXIT_CRITICAL(&owMux);
}

int owReadBit() {
  portENTER_CRITICAL(&owMux);
  owLow();
  delayMicroseconds(3);
  owRelease();
  delayMicroseconds(10);
  int b = owRead();
  portEXIT_CRITICAL(&owMux);
  delayMicroseconds(53);
  return b;
}

void owWrite(uint8_t v) { for (int i = 0; i < 8; i++) owWriteBit((v >> i) & 1); }
uint8_t owReadByte() { uint8_t v = 0; for (int i = 0; i < 8; i++) v |= owReadBit() << i; return v; }

uint8_t crc8(const uint8_t* d, int n) {      // Dallas/Maxim CRC, to throw away bad reads
  uint8_t c = 0;
  for (int i = 0; i < n; i++)
    for (uint8_t b = d[i], k = 0; k < 8; k++, b >>= 1) { uint8_t mix = (c ^ b) & 1; c >>= 1; if (mix) c ^= 0x8C; }
  return c;
}

bool tempProbeThere() { return owReset(); }

bool tempStartConversion() {
  if (!owReset()) return false;
  owWrite(0xCC);                             // the only probe on the wire
  owWrite(0x44);                             // measure (takes up to 750 ms at 12 bits)
  return true;
}

bool tempReadResult(float& c) {
  if (!owReset()) return false;
  owWrite(0xCC);
  owWrite(0xBE);                             // read its memory
  uint8_t d[9];
  for (int i = 0; i < 9; i++) d[i] = owReadByte();
  if (crc8(d, 8) != d[8]) return false;
  int16_t raw = d[1] << 8 | d[0];
  c = raw / 16.0f;
  return c > -50 && c < 120 && !(raw == 0x0550);   // 85.0 °C = the power-on value, not a reading
}

Level levelTemp(float t) {                   // underarm temperature
  if (t < 35.0f || t >= 39.0f) return ALERT;
  if (t >= 37.5f) return ATTN;
  return SAFE;
}
const char* levelWordTemp(float t) {
  return t < 35.0f ? "Thân nhiệt thấp" : t >= 39.0f ? "Sốt cao" : t >= 37.5f ? "Sốt" : "Bình thường";
}

// One reading a second. Done when it has stopped rising: at least 60 s, and the last 30 s within 0.1 °C.
void tempLoop() {
  if (screenNow != S_TEMP || tempState != T_WAIT) return;
  unsigned long now = millis();
  if (!tempConverting) {
    if (now - tempConvAt < 1000) return;
    if (!tempStartConversion()) { tempState = T_NOPROBE; dirty = true; return; }
    tempConverting = true;
    tempConvAt = now;
    return;
  }
  if (now - tempConvAt < 800) return;
  tempConverting = false;
  float c;
  if (!tempReadResult(c)) return;            // a bad read: try again next second
  tempNow = c;
  if (tempLogN == 40) { memmove(tempLog, tempLog + 1, sizeof(float) * 39); tempLogN--; }
  tempLog[tempLogN++] = c;
  Serial.printf("Temperature %.2f C\n", c);
  dirty = true;
  unsigned long secs = (now - tempStart) / 1000;
  bool steady = false;
  if (tempLogN >= 30 && secs >= 60 && c >= 34.0f) {
    float lo = 1e9, hi = -1e9;
    for (int i = tempLogN - 30; i < tempLogN; i++) { lo = min(lo, tempLog[i]); hi = max(hi, tempLog[i]); }
    steady = hi - lo <= 0.1f;
  }
  if (steady || secs >= TEMP_MAX_SECONDS) {
    tempResult = roundf(c * 10) / 10;
    tempState = T_DONE;
    say(levelTemp(tempResult) == SAFE ? SND_OK : SND_ERR, true);
  }
}

// =====================================================================
// Measuring
// =====================================================================
void pushWave(float v) {
  wave[waveHead] = v;
  waveHead = (waveHead + 1) % 200;
  if (waveCount < 200) waveCount++;
}

void clearMeasurement() {
  hrCount = spCount = 0;
  liveHR = 0;
  liveSpO2 = 0;
  waveCount = waveHead = 0;
  lastBeepSecond = -1;
}

void goTo(Screen s) {
  screenNow = s;
  stateSince = millis();
  dirty = true;
  if (s == S_TEMP) {
    tempLogN = 0;
    tempNow = 0;
    tempStart = millis();
    tempState = tempProbeThere() ? T_WAIT : T_NOPROBE;
    if (tempState == T_WAIT) say(V_TEMP, true);
    else say(SND_ERR, true);
  }
  if (s == S_PLACE) {
    clearMeasurement();
    goodStreak = 0;
    if (sensorOk) oxiStart();                // (re)start the sensor's measuring
    say(V_PLACE, true);
  } else if (s == S_MEASURE) {
    clearMeasurement();
    restarts = 0;
    holdUntil = 0;
    measureStart = millis() + 800;            // pressing the button shakes the board: wait a moment
    baselineAt = millis() + 700;
    haveBaseline = false;
    say(V_START, false);
  }
}

// Mock "sensor": a believable heartbeat wave and slowly drifting numbers.
void mockLoop() {
  unsigned long now = millis();
  if (now - lastMockWave >= 20) {
    float dt = (now - lastMockWave) / 1000.0f;
    lastMockWave = now;
    mockPhase += dt * mockHR / 60.0f;
    if (mockPhase >= 1) mockPhase -= 1;
    float p = mockPhase;
    float v = expf(-sq((p - 0.12f) / 0.06f)) + 0.4f * expf(-sq((p - 0.42f) / 0.09f)) + randf(-0.02f, 0.02f);
    pushWave(v);
  }
  if (now - lastMockSample >= 500) {
    lastMockSample = now;
    float hrTarget = demoLow ? 104 : 74, spTarget = demoLow ? 86.5f : 97.6f;
    mockHR += (hrTarget - mockHR) * 0.08f + randf(-0.8f, 0.8f);
    mockSpO2 += (spTarget - mockSpO2) * 0.15f + randf(-0.15f, 0.15f);
    mockSpO2 = constrain(mockSpO2, 80.0f, 100.0f);
    if (screenNow == S_MEASURE && (long)now - measureStart > 2000 && now >= holdUntil) {
      liveHR = mockHR;
      if (hrCount < 120) hrSamples[hrCount++] = mockHR;
      if (spCount < 120) spSamples[spCount++] = mockSpO2;
    }
  }
}

// ---------- SEN0518: its own chip works out heart rate and SpO2, we just read the numbers ----------
bool oxiStart() {                            // true = sensor answered
  Wire.beginTransmission(OXI_ADDR);
  if (Wire.endTransmission() != 0) return false;
  Wire.beginTransmission(OXI_ADDR);
  Wire.write(0x20);                          // "start measuring"
  Wire.write(0x00);
  Wire.write(0x01);
  return Wire.endTransmission() == 0;
}

bool oxiRead(int& spo2, int& hr) {           // false = no answer on the wires
  Wire.beginTransmission(OXI_ADDR);
  Wire.write(0x0C);
  if (Wire.endTransmission() != 0) return false;
  if (Wire.requestFrom((uint8_t)OXI_ADDR, (uint8_t)8) != 8) return false;
  uint8_t b[8];
  for (int i = 0; i < 8; i++) b[i] = Wire.read();
  spo2 = b[0];                               // 0 = no reading yet / no finger
  hr = (int)((uint32_t)b[2] << 24 | (uint32_t)b[3] << 16 | (uint32_t)b[4] << 8 | b[5]);
  return true;
}

void sensorLoop() {                          // asks the sensor once a second
  unsigned long now = millis();
  if (now - lastOxiPoll < 1000) return;
  lastOxiPoll = now;
  int sp = 0, hr = 0;
  bool answered = oxiRead(sp, hr);
  if (answered) ioErrors = 0;
  else if (++ioErrors == 3) { Serial.println("Sensor stopped answering: check the cable"); dirty = true; }
  bool good = answered && sp >= 70 && sp <= 100 && hr >= 30 && hr <= 220;
  if (good) { goodStreak++; badStreak = 0; liveHR = hr; liveSpO2 = sp; }
  else { badStreak++; goodStreak = 0; }
  if (screenNow == S_PLACE || screenNow == S_MEASURE)
    Serial.printf("Sensor: SpO2 %d, heart rate %d%s\n", sp, hr, good ? "" : " (not valid)");
  // one sample every 4 s (the sensor's own update time) while the countdown runs
  bool counting = screenNow == S_MEASURE && (long)now - measureStart > SETTLE_SECONDS * 1000L && now >= holdUntil;
  if (counting && good && now - lastOxiSample >= 4000) {
    lastOxiSample = now;
    if (hrCount < 120) hrSamples[hrCount++] = hr;
    if (spCount < 120) spSamples[spCount++] = sp;
    dirty = true;
  }
}

void findSensor() {
  if (!USE_SEN0518) return;
  bool was = sensorOk;
  sensorOk = oxiStart();
  ioErrors = 0;
  Serial.println(sensorOk ? "SEN0518 sensor found" : "SEN0518 NOT found: using mock values");
  if (sensorOk && !was && millis() > 5000) showToast("Đã thấy cảm biến", C_GREEN);
  dirty = true;
}

bool fingerPresent() {
  if (sensorOk) return badStreak < 4;        // 4 s without a good reading = finger off
  return true;
}

// Keeps only the readings close to the middle value; returns how many are left.
int keepNear(float* v, int n, float tolerance) {
  float m = median(v, n);
  int k = 0;
  for (int i = 0; i < n; i++) if (fabsf(v[i] - m) <= tolerance) v[k++] = v[i];
  return k;
}

void finishMeasurement() {
  if (hrCount < 3 || spCount < 3) {
    showToast("Chưa đo được, thử lại", C_AMBER);
    say(SND_ERR, true);
    goTo(S_IDLE);
    return;
  }
  Serial.print("Readings HR:");
  for (int i = 0; i < hrCount; i++) Serial.printf(" %.0f", hrSamples[i]);
  Serial.print("  SpO2:");
  for (int i = 0; i < spCount; i++) Serial.printf(" %.0f", spSamples[i]);
  Serial.println();
  if (!mockMode()) {
    // throw away odd readings (a twitch, a bad moment); if too many are odd, do not show a number
    int hrAll = hrCount, spAll = spCount;
    hrCount = keepNear(hrSamples, hrCount, 12);   // within 12 beats per minute of the middle
    spCount = keepNear(spSamples, spCount, 3);    // within 3 % of the middle
    Serial.printf("Kept %d/%d heart rate and %d/%d SpO2 readings\n", hrCount, hrAll, spCount, spAll);
    if (hrCount < 3 || spCount < 3 || hrCount * 3 < hrAll * 2 || spCount * 3 < spAll * 2) {
      showToast("Số đo chưa ổn định, đo lại", C_AMBER);
      say(V_UNSTABLE, true);
      goTo(S_IDLE);
      return;
    }
  }
  resultHR = (int)roundf(median(hrSamples, hrCount));
  resultSpO2 = (int)roundf(median(spSamples, spCount));
  haveResult = true;
  resultMock = mockMode();
  resultSent = false;
  resultTime = dateTimeText();
  { time_t now = time(nullptr); resultEpoch = now > 1700000000 ? (uint32_t)now : 0; }
  resultAtMs = millis();
  addHistory(resultHR, resultSpO2, resultMock);
  Level lh = levelHR(resultHR), ls = levelSpO2(resultSpO2);
  Serial.printf("Result: %d bpm (%s), SpO2 %d%% (%s)%s\n", resultHR, levelWordHR(lh), resultSpO2, levelWordSpO2(ls),
                resultMock ? " [mock]" : "");
  if (lh == ALERT || ls == ALERT) {
    goTo(S_EMERGENCY);
    say(SND_ALARM, true);
    say(V_EMERGENCY, false);                 // spoken warning, twice
    say(V_EMERGENCY, false);
    sendResult(true);                        // phone shows the emergency too, if it is connected
  } else {
    goTo(S_RESULT);
    say(SND_OK, true);
    if (lh == ATTN || ls == ATTN) say(V_CHECK, false);
    say(V_DONE, false);
  }
}

void measureLoop() {
  unsigned long now = millis();
  if (screenNow == S_PLACE) {
    bool ready;
    if (sensorOk) {
      ready = goodStreak >= 2 && now - stateSince > 2500;   // two good readings in a row
      if (!ready && now - stateSince > 45000) {             // nothing for 45 s
        showToast("Chưa đọc được, đeo lại cảm biến", C_AMBER);
        say(V_NOFINGER, true);
        goTo(S_IDLE);
        return;
      }
    } else {
      ready = now - stateSince > 3000 && audioIdle();      // mock: pretend the finger is placed
    }
    if (ready) { lastOxiSample = 0; goTo(S_MEASURE); }
    return;
  }
  if (screenNow != S_MEASURE) return;

  if (!fingerPresent()) {                    // finger lifted
    goTo(S_PLACE);
    say(V_NOFINGER, true);
    return;
  }
  // hold still: compare the accelerometer with the position at the start
  int ax = k10.getAccelerometerX(), ay = k10.getAccelerometerY(), az = k10.getAccelerometerZ();
  if (!haveBaseline) {
    if (now >= baselineAt) { baseX = ax; baseY = ay; baseZ = az; haveBaseline = true; }
  } else if (now >= holdUntil) {
    int moved = max(abs(ax - baseX), max(abs(ay - baseY), abs(az - baseZ)));
    if (moved > MOVE_LIMIT) {
      Serial.printf("Moved by %d (limit %d): restarting\n", moved, MOVE_LIMIT);
      if (++restarts > 5) {
        showToast("Tay cử động nhiều, thử lại", C_AMBER);
        say(SND_ERR, true);
        goTo(S_IDLE);
        return;
      }
      say(V_HOLD, true);
      holdUntil = now + 2500;
      measureStart = now + 2500;
      baselineAt = now + 2300;
      haveBaseline = false;
      hrCount = spCount = 0;
      lastBeepSecond = -1;
      return;
    }
  }
  long elapsed = (long)now - measureStart;
  int left = measureSeconds() - (int)(elapsed / 1000);
  if (elapsed > 0 && left <= 3 && left >= 1 && left != lastBeepSecond) { lastBeepSecond = left; say(SND_TICK, false); }
  if (elapsed >= measureSeconds() * 1000L) finishMeasurement();
}

// =====================================================================
// Buttons: act when released, A+B together = both were held
// =====================================================================
void startMeasuring() {
  if (!sensorOk) findSensor();
  goTo(S_PLACE);
}

void menuChoose() {
  switch (menuSel) {
    case 0: goTo(S_TEMP); break;
    case 1: goTo(S_HISTORY); break;
    case 2: qrToGeneSense = true; goTo(S_QR); break;
    case 3: goTo(S_WIFISETUP); startSetup(); break;
    case MENU_CLEAR:
      if (millis() < clearConfirmUntil) {
        clearHistory();
        clearConfirmUntil = 0;
        showToast("Đã xóa lịch sử", C_GREEN);
      } else {
        clearConfirmUntil = millis() + 3500;   // ask once more before deleting
        showToast("Bấm A lần nữa để xóa", C_AMBER);
        say(SND_BEEP, true);
      }
      break;
    default: goTo(S_IDLE); break;
  }
}

void onButton(int which) {                   // 1 = A, 2 = B, 3 = A+B
  Serial.printf("Button %s\n", which == 1 ? "A" : which == 2 ? "B" : "A+B");
  switch (screenNow) {
    case S_IDLE:
      if (which == 1) startMeasuring();
      else if (which == 2) { menuSel = 0; clearConfirmUntil = 0; goTo(S_MENU); }
      else if (which == 3 && mockMode()) {
        demoLow = !demoLow;
        showToast(demoLow ? "Lần đo tới: oxy thấp (thử)" : "Đã tắt chế độ thử", C_AMBER);
        say(SND_BEEP, true);
      }
      break;
    case S_PLACE:
    case S_MEASURE:
      if (which == 2) { say(SND_BEEP, true); goTo(S_IDLE); }
      break;
    case S_RESULT:
    case S_EMERGENCY:
      if (which == 1) goTo(S_PLACE);
      else if (which == 2) sendResult(false);
      break;
    case S_MENU:
      if (which == 1) menuChoose();
      else if (which == 2) { menuSel = (menuSel + 1) % MENU_COUNT; clearConfirmUntil = 0; }
      else goTo(S_IDLE);
      break;
    case S_HISTORY:
      if (which == 1) startMeasuring();
      else goTo(S_IDLE);
      break;
    case S_QR:
      if (which == 1) qrToGeneSense = !qrToGeneSense;
      else if (which == 2) goTo(S_IDLE);
      break;
    case S_TEMP:
      if (which == 1) goTo(S_TEMP);          // measure again
      else if (which == 2) goTo(S_IDLE);
      break;
    case S_WIFISETUP:
      if (which == 2) { stopSetup(); goTo(S_IDLE); }
      else if (which == 1 && setupStep == 5) { setupStep = 1; dirty = true; }   // join again, then the page
      break;
  }
  dirty = true;
}

// Power off = standby: screen, sound, radios and lights off; switching the button on restarts the program.
// The button's own light shows the state: lit = on. Unplug the power to switch the board off completely.
void powerOff() {
  Serial.printf("Green button reads %d (ON = %d): going to sleep\n", digitalRead(LED_BUTTON_PIN), GREEN_ON_LEVEL);
  audioStop = true;
  cv->fillScreen(C_BG);
  logo(W / 2 - 24, 110, 48);
  textC(W / 2, 196, "Đang tắt...", C_INK2, GS_BODY);
  screen.pushImage(0, 0, W, H, cv->getBuffer());
  delay(600);
  for (int i = 0; i < 3; i++) setLed(i, 0, 0, 0);
  xSemaphoreTake(xI2SMutex, pdMS_TO_TICKS(500));   // let any sound finish, then silence the speaker
  i2s_zero_dma_buffer(I2S_NUM_0);
  i2s_stop(I2S_NUM_0);
  digital_write(eAmp_Gain, 0);               // speaker amplifier off, or it amplifies noise while asleep
  digital_write(eLCD_BLK, 0);                // screen light off
  screen.fillScreen(TFT_BLACK);
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  btStop();
  // No Serial.flush() here: with no computer on the USB port (power bank, batteries) it waits forever.
  // Wait in a slow, quiet loop instead of deep sleep: waking from deep sleep was unreliable on
  // power banks, and the small current this draws also stops many power banks switching off.
  setCpuFrequencyMhz(80);
  for (int on = 0; on < 3; ) {               // 3 readings in a row = really switched on
    delay(40);
    on = digitalRead(LED_BUTTON_PIN) == GREEN_ON_LEVEL ? on + 1 : 0;
  }
  esp_restart();                             // switched on: start again from the beginning
}

bool greenIsOn() {                           // read a few times, so a bounce does not count
  int on = 0;
  for (int i = 0; i < 5; i++) { on += digitalRead(LED_BUTTON_PIN) == GREEN_ON_LEVEL; delay(4); }
  return on >= 3;
}

void greenLoop() {
  if (LED_BUTTON_PIN < 0) return;
  int v = digitalRead(LED_BUTTON_PIN);
  if (v != greenRaw) { greenRaw = v; greenChangedAt = millis(); return; }
  if (millis() - greenChangedAt > 80 && v != greenStable) {   // steady for 80 ms
    greenStable = v;
    if (v != GREEN_ON_LEVEL) powerOff();
  }
}

void buttonLoop() {
  bool a = k10.buttonA->isPressed(), b = k10.buttonB->isPressed();
  if (a || b) {
    if (!anyHeld) { anyHeld = true; heldA = heldB = false; }
    heldA |= a;
    heldB |= b;
  } else if (anyHeld) {
    anyHeld = false;
    onButton(heldA && heldB ? 3 : heldA ? 1 : 2);
  }
}

// =====================================================================
void ledLoop() {
  setLed(0, 0, 0, bleConnected ? 60 : 0);
  setLed(1, 0, wifiSsid.length() && WiFi.status() == WL_CONNECTED ? 40 : 0, 0);
  if (screenNow == S_EMERGENCY) {
    bool on = (millis() / 300) % 2;
    setLed(2, on ? 120 : 0, 0, 0);
  } else if (screenNow == S_MEASURE) {
    setLed(2, waveCount && wave[(waveHead + 199) % 200] > 0.6f && mockMode() ? 60 : 8, 0, 0);
  } else {
    setLed(2, 0, 0, 0);
  }
}

void setup() {
  Serial.begin(115200);
  k10.begin();
  screen.begin();
  screen.setRotation(2);
  screen.setSwapBytes(true);
  screen.fillScreen(C_BG);
  digital_write(eLCD_BLK, 1);
  cv = new GFXcanvas16(W, H);
  if (!cv || !cv->getBuffer()) {
    screen.setTextColor(TFT_WHITE);
    screen.drawString("Out of memory: Tools > PSRAM > OPI", 4, 150, 2);
    for (;;) delay(1000);
  }
  drawBoot();
  screen.pushImage(0, 0, W, H, cv->getBuffer());

  findSensor();
  if (LED_BUTTON_PIN >= 0) {
    pinMode(LED_BUTTON_PIN, GREEN_ON_LEVEL ? INPUT_PULLDOWN : INPUT_PULLUP);
    if (!greenIsOn()) powerOff();            // switched off: sleep straight away
  }
  prefs.begin("gsk10", false);
  loadHistory();

  startStorage();
  audioQ = xQueueCreate(8, sizeof(int));
  xTaskCreatePinnedToCore(audioTask, "audio", 6144, nullptr, 3, nullptr, 0);
  startBluetooth();
  startWifi();
  goTo(S_IDLE);
  say(V_WELCOME, false);
}

void loop() {
  static unsigned long lastFrame = 0;
  buttonLoop();
  greenLoop();
  if (sensorOk) sensorLoop(); else mockLoop();
  measureLoop();
  tempLoop();
  wifiLoop();
  ledLoop();
  if (bleWasConnected && !bleConnected) { delay(300); BLEDevice::startAdvertising(); }   // let the phone find it again
  if (bleWasConnected != bleConnected) { dirty = true; Serial.println(bleConnected ? "Phone connected" : "Phone disconnected"); }
  bleWasConnected = bleConnected;

  bool fast = screenNow == S_TEMP || screenNow == S_PLACE || screenNow == S_MEASURE || screenNow == S_EMERGENCY;
  if (dirty || millis() - lastFrame >= (fast ? 40UL : 200UL)) {
    dirty = false;
    lastFrame = millis();
    render();
  }
  delay(2);
}
