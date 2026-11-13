// Google sign-in. The website uses the normal redirect. The apps cannot (Google blocks sign-in inside a web view), so:
// the app makes a random verifier, the server sends Google's result back as genesense://auth?code=..., and only
// the code plus this app's verifier gives a session. iOS gets that link from its sign-in sheet (gsNative.authSession);
// Android reopens the app at "#app-login?code=...". The verifier waits in localStorage, so Android survives the
// app being closed while the browser is open.
const android = () => /GeneSenseAndroid\//.test(navigator.userAgent);
const nativeApp = () => android() || document.documentElement.classList.contains("ios-app");
const storageKey = "genesense-app-login";
const RETURN_ROUTE = "#app-login?";

async function post(path, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch("/api/auth/mobile/" + path, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Requested-With": "HealthPredict" },
      body: JSON.stringify(body), signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "Không thể đăng nhập. Hãy thử lại.");
    return data;
  } finally { clearTimeout(timeout); }
}

function takeVerifier() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(storageKey) || "null"); localStorage.removeItem(storageKey); } catch {}
  return saved && Date.now() < saved.expires ? saved.verifier : null;
}

// The query part of genesense://auth?... : redeem the code with this app's verifier, then reload signed in.
async function finish(query, showMessage) {
  const params = new URLSearchParams(query);
  const verifier = takeVerifier();
  if (params.get("error") || !params.get("code") || !verifier) throw new Error("Phiên đăng nhập đã hết hạn. Hãy thử lại.");
  showMessage("Đang đăng nhập…");
  await post("redeem", { code: params.get("code"), verifier });
  location.reload();
}

// Android comes back to the app at "#app-login?code=...".
export async function resumeGoogleLogin(showMessage) {
  if (!location.hash.startsWith(RETURN_ROUTE)) return;
  const query = location.hash.slice(RETURN_ROUTE.length);
  window.history.replaceState(null, "", location.pathname + location.search);
  try { await finish(query, showMessage); } catch (error) { showMessage(error.message); }
}

export async function loginWithGoogle(showMessage) {
  if (!nativeApp()) { location.assign("/api/auth/google"); return; }
  const ios = !android();
  if (ios && !window.gsNative?.authSession) { showMessage("Hãy cập nhật ứng dụng GeneSense để đăng nhập bằng Google."); return; }
  try {
    const verifier = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
    const data = await post("start", { challenge });
    localStorage.setItem(storageKey, JSON.stringify({ verifier, expires: Date.now() + 300000 }));
    if (!ios) { location.assign(data.url); return; }   // Android opens the browser, then reopens the app
    const back = await window.gsNative.authSession(data.url);
    if (!back) { takeVerifier(); return; }            // closed the sign-in sheet
    await finish(back.slice(back.indexOf("?") + 1), showMessage);
  } catch (error) { showMessage(error.message); }
}
