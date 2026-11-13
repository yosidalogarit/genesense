# GS1 integration

This branch adds the GS1 assistant and mobile refinements to the current GeneSense code.
Existing device pairing, QR scanning and hardware integrations stay available.

## Platform UI

- `frontend/assets/styles.css` holds shared layout and components.
- `frontend/assets/ios.css` holds the iPhone/iPad appearance.
- `frontend/assets/android.css` holds the Android appearance.
- `frontend/js/platform.js` selects the platform before styles load.
- Native projects remain in `ios/` and `android-apk/`.

The two platforms share the API, user accounts and business logic.

## Google sign-in

Web uses the existing Google OIDC flow with state, nonce and PKCE.
Native apps initiate a five-minute handoff, then open the system browser for Google sign-in.
After completion the user switches back to the app. The app redeems the handoff with its
private random verifier and receives the existing HttpOnly session cookie.
The handoff is consumed atomically and cannot be redeemed a second time.
The verifier and application session are never included in a redirect URL.

Set these variables in the existing **Gene Sense / genesense** Vercel project before use:

| Variable | Value |
| --- | --- |
| `GOOGLE_CLIENT_ID` | Web OAuth client from Google Cloud |
| `GOOGLE_CLIENT_SECRET` | Secret from that OAuth client |
| `SESSION_SECRET` | Stable random server secret, at least 32 characters |
| `APP_BASE_URL` | `https://genesense-five.vercel.app` |
| `APP_ENV` | `production` |

The OAuth client's authorized redirect URI must include
`https://genesense-five.vercel.app/api/auth/google/callback`.
Keep credentials in Vercel environment settings. Redeploy after changing them.
The server creates the `app_login_attempts` table through the existing startup migrations.

The current production project reports `google_enabled=false`.
Merging this code alone will not enable Google without the server credentials.

## Validation

- 59 backend tests passed, including isolated browser/app cookies, verifier mismatch,
  expiry, single redemption, account isolation and assistant consent.
- Android debug APK 0.4.0 builds and its signature verifies.
- JavaScript syntax checks passed.
- Local onboarding page loads with the split stylesheets.
- Real-device OAuth, iOS compilation and signed-in native UI remain to be checked.

Windows build command: `powershell -ExecutionPolicy Bypass -File android-apk/build.ps1`.
Use the existing signing key for installed-app updates.
