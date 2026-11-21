# GeneSense Android APK

Current test build: **v0.4.3** (version code 8). Download it from the [GitHub release](https://github.com/yosidalogarit/genesense/releases/tag/v0.4.3). The APK uses the existing debug signing certificate so it can update v0.4.1/v0.4.2 in place. It loads the deployed website; publishing this APK does not deploy pending web/backend changes.

### Google login return fix (v0.4.3)

The old Android shell loaded only `#app-login?...` when Chrome reopened a running app. This was a same-document navigation, while the web page only redeemed the one-time code during startup. The user therefore returned to the login screen without getting an app session.

The APK now forces a fresh same-origin document on auth returns using a non-secret `app_return` query. This also works with the previous deployed web login module. WebView accepts first-party cookies explicitly and flushes them when paused. The web fix additionally consumes warm `hashchange` auth returns before regular routing and handles startup returns before checking an existing trial session. Code/verifier binding and single-use server redemption are unchanged; Chrome cookies are never copied into WebView.

Regression checks: `node --test frontend/tests/google-login.test.mjs` and `python -m pytest backend/tests -q`. Real Google account selection/consent still requires testing on the user's phone; synthetic session redemption is used in automated tests.

`GeneSense-debug.apk` is an installable test build of the GeneSense web app. It opens `https://genesense-five.vercel.app/` in an Android WebView. Build again with `powershell -ExecutionPolicy Bypass -File .\build.ps1` on Windows with Android SDK 34, Build Tools 36.1, and Android Studio's Java runtime installed.

The app supports web file selection and has a native menu item **Quyền Bluetooth**. On Android 12+, the menu asks for Nearby devices permissions (`BLUETOOTH_SCAN` and `BLUETOOTH_CONNECT`); on older supported versions it asks for location permission needed for scanning. It does not implement a BLE device protocol yet. Web Bluetooth APIs are not provided by Android WebView; a native bridge must be added for a specific device and data format.

This is a debug signed APK for testing, not a Play Store release. The web address is hard coded in `MainActivity.java`. The local development server at `127.0.0.1:8000` is not reachable from a phone. Any AI key belongs in the server environment and must never be packaged into the APK.
