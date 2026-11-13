const nativeApp = () => /GeneSenseAndroid\//.test(navigator.userAgent) || document.documentElement.classList.contains("ios-app");
const storageKey = "genesense-app-login";
let polling = false;

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

export async function resumeGoogleLogin(showMessage) {
  if (!nativeApp() || polling) return;
  const saved = sessionStorage.getItem(storageKey);
  if (!saved) return;
  let attempt;
  try { attempt = JSON.parse(saved); } catch { sessionStorage.removeItem(storageKey); return; }
  polling = true;
  showMessage("Hoàn tất đăng nhập trong trình duyệt, rồi quay lại GeneSense.");
  try {
    while (Date.now() < attempt.expires) {
      // Returning to the app resumes this loop without exposing a session in a URL.
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (document.hidden) continue;
      const data = await post("poll", { id: attempt.id, verifier: attempt.verifier });
      if (data.status === "authenticated") {
        sessionStorage.removeItem(storageKey);
        location.reload();
        return;
      }
    }
    throw new Error("Phiên đăng nhập đã hết hạn. Hãy thử lại.");
  } catch (error) {
    showMessage(error.message);
    sessionStorage.removeItem(storageKey);
  } finally { polling = false; }
}

export async function loginWithGoogle(showMessage) {
  if (!nativeApp()) { location.assign("/api/auth/google"); return; }
  if (polling) { showMessage("Hãy hoàn tất đăng nhập trong trình duyệt rồi quay lại app."); return; }
  try {
    const verifier = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("");
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
    const data = await post("start", { challenge });
    sessionStorage.setItem(storageKey, JSON.stringify({ id: data.id, verifier, expires: Date.now() + 300000 }));
    location.assign(data.url);
    void resumeGoogleLogin(showMessage);
  } catch (error) { showMessage(error.message); }
}
