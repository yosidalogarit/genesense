"""App sign-in: the code reaches only the app via genesense://, needs the app's verifier, and works once."""
import asyncio
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit

from fastapi.testclient import TestClient
from fastapi.responses import RedirectResponse

from backend.app import auth, main, mobile_auth
from backend.app.models import AppLoginAttempt
from backend.tests.test_accounts import HEADERS, client


def enable_google(monkeypatch):
    monkeypatch.setattr(auth.settings, "google_client_id", "synthetic-client")
    monkeypatch.setattr(auth.settings, "google_client_secret", "synthetic-secret")
    monkeypatch.setattr(auth.settings, "session_secret", "s" * 48)


def fake_google(monkeypatch, sub="mobile-test"):
    async def redirect(request, redirect_uri, **kwargs):
        return RedirectResponse("/synthetic-google")

    async def token(request):
        return {"userinfo": {"sub": sub, "email": "mobile@example.invalid", "email_verified": True, "name": "App test"}}

    monkeypatch.setattr(auth.oauth.google, "authorize_redirect", redirect)
    monkeypatch.setattr(auth.oauth.google, "authorize_access_token", token)


def google_in_browser(url):
    """Open the sign-in link in a separate browser and return where Google's callback sends it."""
    browser = TestClient(main.app, base_url="http://localhost:8000", headers=HEADERS)
    browser.get(urlsplit(url).path + "?" + urlsplit(url).query, follow_redirects=False)
    result = browser.get("/api/auth/google/callback?code=synthetic", follow_redirects=False)
    assert browser.get("/api/auth/me").status_code == 401  # the browser itself is not signed in
    browser.close()
    return result


def test_app_gets_a_one_time_code_bound_to_its_verifier(client, monkeypatch):
    enable_google(monkeypatch)
    fake_google(monkeypatch)
    verifier = "a" * 64
    start = client.post("/api/auth/mobile/start", json={"challenge": auth.digest(verifier)}).json()
    started_id = parse_qs(urlsplit(start["url"]).query)["mobile"][0]
    result = google_in_browser(start["url"])
    assert result.status_code == 303 and result.headers["location"].startswith("genesense://auth?code=")
    code = parse_qs(urlsplit(result.headers["location"]).query)["code"][0]
    assert code != started_id
    # Whoever started the attempt (the link's sender) cannot redeem with the id they know.
    assert client.post("/api/auth/mobile/redeem", json={"code": started_id, "verifier": verifier}).status_code == 400
    assert client.post("/api/auth/mobile/redeem", json={"code": code, "verifier": "b" * 64}).status_code == 400
    assert client.get("/api/auth/me").status_code == 401
    assert client.post("/api/auth/mobile/redeem", json={"code": code, "verifier": verifier}).json()["status"] == "authenticated"
    assert client.get("/api/auth/me").json()["provider"] == "google"
    assert client.post("/api/auth/mobile/redeem", json={"code": code, "verifier": verifier}).status_code == 400


def test_expired_attempt_and_configuration(client, monkeypatch):
    monkeypatch.setattr(auth.settings, "google_client_id", "")
    assert client.post("/api/auth/mobile/start", json={"challenge": "a" * 64}).status_code == 503
    enable_google(monkeypatch)
    fake_google(monkeypatch)
    verifier = "a" * 64
    start = client.post("/api/auth/mobile/start", json={"challenge": auth.digest(verifier)}).json()
    started_id = parse_qs(urlsplit(start["url"]).query)["mobile"][0]

    async def expire():
        async with client.db_factory() as session:
            row = await session.get(AppLoginAttempt, started_id)
            row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
            await session.commit()

    asyncio.run(expire())
    assert client.get("/api/auth/google?mobile=" + started_id, follow_redirects=False).status_code == 400
    assert client.get("/api/auth/me").status_code == 401


def test_live_attempts_are_capped(client, monkeypatch):
    enable_google(monkeypatch)
    monkeypatch.setattr(mobile_auth, "MAX_LIVE_ATTEMPTS", 2)
    for _ in range(2):
        assert client.post("/api/auth/mobile/start", json={"challenge": "a" * 64}).status_code == 200
    assert client.post("/api/auth/mobile/start", json={"challenge": "a" * 64}).status_code == 429
