"""Separate browser/app cookies, verifier binding, expiration and single redemption."""
import asyncio
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient
from fastapi.responses import RedirectResponse

from backend.app import auth, main
from backend.app.models import AppLoginAttempt
from backend.tests.test_accounts import HEADERS, client


def enable_google(monkeypatch):
    monkeypatch.setattr(auth.settings, "google_client_id", "synthetic-client")
    monkeypatch.setattr(auth.settings, "google_client_secret", "synthetic-secret")
    monkeypatch.setattr(auth.settings, "session_secret", "s" * 48)


def test_browser_handoff_is_bound_to_app_and_consumed_once(client, monkeypatch):
    enable_google(monkeypatch)
    verifier = "a" * 64
    attempt = client.post("/api/auth/mobile/start", json={"challenge": auth.digest(verifier)}).json()
    payload = {"id": attempt["id"], "verifier": verifier}
    assert client.post("/api/auth/mobile/poll", json=payload).json() == {"status": "pending"}
    assert client.post("/api/auth/mobile/poll", json={**payload, "verifier": "b" * 64}).status_code == 400

    async def redirect(request, redirect_uri, **kwargs):
        return RedirectResponse("/synthetic-google")

    async def token(request):
        return {"userinfo": {"sub": "mobile-test", "email": "mobile@example.invalid",
                             "email_verified": True, "name": "App test"}}

    monkeypatch.setattr(auth.oauth.google, "authorize_redirect", redirect)
    monkeypatch.setattr(auth.oauth.google, "authorize_access_token", token)
    browser = TestClient(main.app, base_url="http://localhost:8000", headers=HEADERS)
    browser.get(attempt["url"], follow_redirects=False)
    result = browser.get("/api/auth/google/callback?code=synthetic", follow_redirects=False)
    assert "Quay lại" in result.text
    assert browser.get("/api/auth/me").status_code == 401
    assert client.get("/api/auth/me").status_code == 401
    assert client.post("/api/auth/mobile/poll", json=payload).json()["status"] == "authenticated"
    assert client.get("/api/auth/me").json()["provider"] == "google"
    assert client.post("/api/auth/mobile/poll", json=payload).status_code == 400
    browser.close()


def test_mobile_attempt_expiration_and_configuration(client, monkeypatch):
    monkeypatch.setattr(auth.settings, "google_client_id", "")
    assert client.post("/api/auth/mobile/start", json={"challenge": "a" * 64}).status_code == 503
    enable_google(monkeypatch)
    verifier = "a" * 64
    attempt = client.post("/api/auth/mobile/start", json={"challenge": auth.digest(verifier)}).json()

    async def expire():
        async with client.db_factory() as session:
            row = await session.get(AppLoginAttempt, attempt["id"])
            row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
            await session.commit()

    asyncio.run(expire())
    assert client.post("/api/auth/mobile/poll", json={"id": attempt["id"], "verifier": verifier}).status_code == 400
    assert client.get(attempt["url"], follow_redirects=False).status_code == 400
    assert client.get("/api/auth/me").status_code == 401
