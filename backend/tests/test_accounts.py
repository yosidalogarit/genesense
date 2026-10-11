"""Tests use disposable databases and synthetic identities. No Google network calls."""
import asyncio
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, inspect, select, text, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app import auth
from backend.app import main
from backend.app.database import get_session
from backend.app.migrations import migrate_schema
from backend.app.models import Assessment, LoginSession, MedicationIntake, User
from backend.app.schemas import MedicalDocumentAnalysis

HEADERS = {"X-Requested-With": "HealthPredict", "Origin": "http://localhost:8000"}
PROFILE = {
    "display_name": "Người thử nghiệm",
    "profile": {"age": 35, "sex": "female", "height_cm": 165, "weight_kg": 60,
                "activity_minutes_week": 180, "known_conditions": []},
    "family_history": [
        {"member_id": "father", "relation": "father", "knowledge": "known", "conditions": ["hypertension"]},
        {"member_id": "maternal-grandmother", "relation": "grandmother", "side": "maternal", "knowledge": "unknown"},
    ],
    "personal_notes": "Ghi chú riêng", "paternal_notes": "Gia đình phía bố",
    "maternal_notes": "Gia đình phía mẹ", "health_consent": True, "ai_consent": False,
}
MEASUREMENT = {"vitals": {"heart_rate": 72, "systolic": 118, "diastolic": 76, "spo2": 98}, "source": "manual"}


@pytest.fixture
def client(tmp_path, monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///" + str(tmp_path / "account-test.db"))
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def session_override():
        async with factory() as session:
            yield session

    monkeypatch.setattr(main, "engine", engine)
    monkeypatch.setattr(auth.settings, "app_env", "development")
    monkeypatch.setattr(auth.settings, "enable_demo_login", True)
    monkeypatch.setattr(auth.settings, "app_base_url", "http://localhost:8000")
    main.app.dependency_overrides[get_session] = session_override
    with TestClient(main.app, base_url="http://localhost:8000", headers=HEADERS) as test_client:
        test_client.db_factory = factory
        yield test_client
    main.app.dependency_overrides.clear()


def login(client):
    response = client.post("/api/auth/demo")
    assert response.status_code == 200
    return response.json()


def test_private_routes_require_login_and_do_not_cache(client):
    for path in ("/api/profile", "/api/assessments", "/api/assessments/unknown", "/api/medical-records"):
        response = client.get(path)
        assert response.status_code == 401
        assert response.headers["cache-control"] == "no-store"
    assert client.post("/api/assessments", json=MEASUREMENT).status_code == 401
    assert client.post("/api/feedback", json={"rating": 5}).status_code == 401
    assert client.get("/.env").status_code == 404
    assert client.get("/api/not-a-route").status_code == 404


def test_page_sends_a_strict_content_security_policy(client):
    policy = client.get("/").headers["content-security-policy"]
    assert "default-src 'self'" in policy and "frame-ancestors 'none'" in policy
    assert "unsafe-inline" not in policy and "unsafe-eval" not in policy
    # Only the page carries it: the development API pages load their scripts from a CDN.
    assert "content-security-policy" not in client.get("/docs").headers
    assert "content-security-policy" not in client.get("/api/health").headers
    # The policy refuses inline scripts, inline handlers and style attributes, so the frontend must not rely on any.
    frontend = Path(main.FRONTEND_DIR)
    for path in [frontend / "index.html", *sorted((frontend / "js").glob("*.js"))]:
        text = path.read_text(encoding="utf-8")
        assert "style=" not in text and "<style" not in text, path.name
    page = (frontend / "index.html").read_text(encoding="utf-8")
    assert not re.search(r"<script(?![^>]*\bsrc=)", page) and not re.search(r"\son[a-z]+=", page)


def test_first_login_onboarding_and_profile_survives_reload(client):
    user = login(client)
    assert user["onboarding_completed"] is False
    assert client.get("/api/profile").json()["health"] is None
    assert client.post("/api/assessments", json=MEASUREMENT).status_code == 409
    saved = client.put("/api/profile", json=PROFILE)
    assert saved.status_code == 200
    assert saved.json()["user"]["onboarding_completed"] is True
    assert client.get("/api/auth/me").json()["id"] == user["id"]
    health = client.get("/api/profile").json()["health"]
    assert health["personal_notes"] == PROFILE["personal_notes"]
    assert health["family_history"][1]["side"] == "maternal"
    assert health["family_history"][1]["knowledge"] == "unknown"


def test_account_isolation_including_feedback_and_revoked_cookie(client):
    first = login(client)
    client.put("/api/profile", json=PROFILE)
    record = client.post("/api/assessments", json=MEASUREMENT)
    assert record.status_code == 201
    record_id = record.json()["id"]
    assert len(client.get("/api/assessments").json()) == 1
    raw = client.cookies.get(auth.COOKIE_NAME)
    assert client.post("/api/auth/logout").status_code == 200
    second = login(client)
    assert second["id"] != first["id"]
    assert client.get("/api/profile").json()["health"] is None
    assert client.get("/api/assessments").json() == []
    assert client.get("/api/assessments/" + record_id).status_code == 404
    assert client.post("/api/feedback", json={"rating": 3, "assessment_id": record_id}).status_code == 404
    client.cookies.clear()
    client.cookies.set(auth.COOKIE_NAME, raw)
    assert client.get("/api/auth/me").status_code == 401


def test_profile_picture_is_validated_and_account_scoped(client):
    jpeg = b"\xff\xd8\xff\xe0" + b"0" * 100
    assert client.get("/api/avatar").status_code == 401
    login(client)
    assert client.get("/api/avatar").status_code == 204
    assert client.put("/api/avatar", content=b"<svg onload=alert(1)>").status_code == 422
    assert client.put("/api/avatar", content=jpeg + b"0" * main.MAX_AVATAR_BYTES).status_code == 413
    assert client.put("/api/avatar", content=jpeg).status_code == 204
    assert client.put("/api/avatar", content=jpeg + b"1").status_code == 204  # replaces the first
    response = client.get("/api/avatar")
    assert response.content == jpeg + b"1" and response.headers["content-type"] == "image/jpeg"
    assert response.headers["cache-control"] == "no-store" and response.headers["x-content-type-options"] == "nosniff"
    owner = client.cookies.get(auth.COOKIE_NAME)
    client.cookies.clear()
    login(client)
    assert client.get("/api/avatar").status_code == 204  # another account never sees it
    client.cookies.clear()
    client.cookies.set(auth.COOKIE_NAME, owner)
    assert client.delete("/api/avatar").status_code == 204
    assert client.get("/api/avatar").status_code == 204


def test_assessment_delete_is_account_scoped(client):
    login(client)
    client.put("/api/profile", json=PROFILE)
    record_id = client.post("/api/assessments", json=MEASUREMENT).json()["id"]
    client.post("/api/auth/logout")
    login(client)
    client.put("/api/profile", json=PROFILE)
    assert client.delete("/api/assessments/" + record_id).status_code == 404
    own_id = client.post("/api/assessments", json=MEASUREMENT).json()["id"]
    assert client.delete("/api/assessments/" + own_id).status_code == 204
    assert client.get("/api/assessments").json() == []
    assert client.get("/api/assessments/" + own_id).status_code == 404


def test_cross_origin_writes_and_missing_custom_header_rejected(client):
    assert client.post("/api/auth/demo", headers={"Origin": "https://untrusted.example"}).status_code == 403
    assert client.post("/api/auth/demo", headers={"X-Requested-With": ""}).status_code == 403
    assert client.get("/api/auth/google/callback?code=forged&state=forged", follow_redirects=False).status_code == 303


def test_profile_validation_and_partial_measurements(client):
    login(client)
    assert client.put("/api/profile", json=PROFILE | {"health_consent": False}).status_code == 422
    assert client.put("/api/profile", json=PROFILE | {"display_name": "   "}).status_code == 422
    client.put("/api/profile", json=PROFILE)
    assert client.post("/api/assessments", json={"vitals": {}}).status_code == 422
    assert client.post("/api/assessments", json={"vitals": {"systolic": 120}}).status_code == 422
    assert client.post("/api/assessments", json={"vitals": {"systolic": 80, "diastolic": 120}}).status_code == 422
    response = client.post("/api/assessments", json={"vitals": {"heart_rate": 72}})
    assert response.status_code == 201
    assert response.json()["measured_vitals"]["spo2"] is None
    emergency = client.post("/api/assessments", json={"vitals": {"spo2": 85}})
    assert emergency.json()["risk_level"] == "alert"
    # Blood sugar keeps when it was measured; the context is dropped when there is no blood sugar.
    fasting = client.post("/api/assessments", json={"vitals": {"glucose": 110, "glucose_context": "fasting"}})
    assert fasting.json()["measured_vitals"]["glucose_context"] == "fasting"
    assert client.get("/api/assessments").json()[0]["vitals"]["glucose_context"] == "fasting"
    alone = client.post("/api/assessments", json={"vitals": {"heart_rate": 70, "glucose_context": "after_meal"}})
    assert alone.json()["measured_vitals"]["glucose_context"] is None
    assert client.post("/api/assessments", json={"vitals": {"glucose": 110, "glucose_context": "bedtime"}}).status_code == 422


def test_idempotent_manual_sync_and_seven_day_bp_groups(client):
    login(client)
    client.put("/api/profile", json=PROFILE)
    client_id = str(uuid4())
    body = {"source": "manual", "client_id": client_id,
            "vitals": {"heart_rate": 72, "timestamp": datetime.now(timezone.utc).isoformat()}}
    first = client.post("/api/assessments", json=body)
    retry = client.post("/api/assessments", json=body)
    assert first.status_code == 201 and retry.status_code == 201
    assert retry.json()["id"] == first.json()["id"]
    assert len(client.get("/api/assessments").json()) == 1

    offset = -420  # device local time is UTC+07:00
    local_tz = timezone(timedelta(minutes=-offset))
    now = datetime.now(local_tz)

    def past_local(hour):
        moment = now.replace(hour=hour, minute=0, second=0, microsecond=0)
        return moment - timedelta(days=1) if moment > now else moment

    for hour, systolic, diastolic in ((8, 120, 80), (9, 130, 82), (19, 140, 90)):
        payload = {"source": "manual", "client_id": str(uuid4()),
                   "vitals": {"systolic": systolic, "diastolic": diastolic, "timestamp": past_local(hour).isoformat()}}
        assert client.post("/api/assessments", json=payload).status_code == 201

    summary = client.get(f"/api/assessments/weekly-bp?timezone_offset={offset}").json()
    assert summary["days"] == 7
    assert summary["morning"] == {"count": 2, "systolic": 125.0, "diastolic": 81.0}
    assert summary["evening"] == {"count": 1, "systolic": 140.0, "diastolic": 90.0}


def test_medication_intake_is_account_scoped_idempotent_and_deleted_with_medicine(client):
    login(client)
    today = datetime.now(timezone.utc).date()
    medication = client.post("/api/medications", json={
        "name": "Thuốc thử", "start_date": today.isoformat(), "days": 3, "morning": True,
    })
    assert medication.status_code == 201
    medication_id = medication.json()["id"]
    url = f"/api/medications/{medication_id}/intakes/morning"
    payload = {"scheduled_on": today.isoformat(), "taken": True}
    first = client.put(url, json=payload)
    retry = client.put(url, json=payload)
    assert first.status_code == retry.status_code == 200
    assert first.json()["taken"] is True and retry.json()["taken_at"] == first.json()["taken_at"]
    assert len(client.get(f"/api/medications/intakes?scheduled_on={today.isoformat()}").json()) == 1
    assert client.put(f"/api/medications/{medication_id}/intakes/noon", json=payload).status_code == 422
    outside_course = {"scheduled_on": (today + timedelta(days=3)).isoformat(), "taken": True}
    assert client.put(url, json=outside_course).status_code == 422

    owner = client.cookies.get(auth.COOKIE_NAME)
    client.cookies.clear()
    login(client)
    assert client.get(f"/api/medications/intakes?scheduled_on={today.isoformat()}").json() == []
    client.cookies.clear()
    client.cookies.set(auth.COOKIE_NAME, owner)
    assert client.delete("/api/medications/" + medication_id).status_code == 204
    assert client.get(f"/api/medications/intakes?scheduled_on={today.isoformat()}").json() == []


def test_demo_and_no_consent_never_call_ai(client, monkeypatch):
    calls = []

    async def fake_ai(*args):
        calls.append(True)
        return args[-1].insight

    monkeypatch.setattr(main.ai_service, "enrich", fake_ai)
    login(client)
    client.put("/api/profile", json=PROFILE | {"ai_consent": True})
    client.post("/api/assessments", json=MEASUREMENT)
    assert calls == []


def test_expired_sessions_rejected(client):
    login(client)
    raw = client.cookies.get(auth.COOKIE_NAME)

    async def expire():
        async with client.db_factory() as session:
            row = await session.get(LoginSession, auth.digest(raw))
            row.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
            await session.commit()

    asyncio.run(expire())
    assert client.get("/api/auth/me").status_code == 401


def test_google_callback_creates_one_account_and_remembers_onboarding(client, monkeypatch):
    monkeypatch.setattr(auth.settings, "google_client_id", "synthetic-client")
    monkeypatch.setattr(auth.settings, "google_client_secret", "synthetic-secret")
    monkeypatch.setattr(auth.settings, "session_secret", "s" * 48)

    async def verified_token(request):
        return {"userinfo": {"sub": "synthetic-subject", "email": "test@example.invalid", "email_verified": True, "name": "Test Google"}}

    monkeypatch.setattr(auth.oauth.google, "authorize_access_token", verified_token)
    response = client.get("/api/auth/google/callback?code=synthetic", follow_redirects=False)
    assert response.status_code == 303
    assert "HttpOnly" in response.headers["set-cookie"]
    first = client.get("/api/auth/me").json()
    assert first["onboarding_completed"] is False and first["is_demo"] is False
    assert first["provider"] == "google"
    client.put("/api/profile", json=PROFILE)
    client.post("/api/auth/logout")
    client.get("/api/auth/google/callback?code=synthetic", follow_redirects=False)
    returning = client.get("/api/auth/me").json()
    assert first["id"] == returning["id"]
    assert returning["onboarding_completed"] is True
    assert returning["display_name"] == PROFILE["display_name"]


def test_google_failure_does_not_create_session(client, monkeypatch):
    monkeypatch.setattr(auth.settings, "google_client_id", "synthetic-client")
    monkeypatch.setattr(auth.settings, "google_client_secret", "synthetic-secret")
    monkeypatch.setattr(auth.settings, "session_secret", "s" * 48)
    # Actual Authlib state validation: no matching signed OAuth state exists.
    response = client.get("/api/auth/google/callback?code=forged&state=forged", follow_redirects=False)
    assert response.headers["location"] == "/?auth_error=signin"
    assert client.get("/api/auth/me").status_code == 401


def test_demo_login_disabled_outside_development(client, monkeypatch):
    monkeypatch.setattr(auth.settings, "app_env", "production")
    assert client.get("/api/auth/config").json()["demo_enabled"] is False
    assert client.post("/api/auth/demo").status_code == 404


def test_public_trial_login_is_capped_per_hour(client, monkeypatch):
    monkeypatch.setattr(auth.settings, "app_env", "production")
    monkeypatch.setattr(auth.settings, "app_base_url", "https://demo.example")
    monkeypatch.setattr(auth.settings, "demo_public", True)
    monkeypatch.setattr(auth.settings, "demo_accounts_per_hour", 6)
    monkeypatch.setattr(auth.settings, "demo_retention_days", 3)
    assert client.get("/api/auth/config").json()["demo_enabled"] is True
    for _ in range(6):
        client.cookies.clear()
        assert client.post("/api/auth/demo").status_code == 200
    client.cookies.clear()
    blocked = client.post("/api/auth/demo")
    assert blocked.status_code == 429 and "dùng thử" in blocked.json()["detail"]

    async def age_accounts():
        async with client.db_factory() as session:
            await session.execute(update(User).values(created_at=datetime.now(timezone.utc) - timedelta(hours=2)))
            await session.commit()
    asyncio.run(age_accounts())
    created = client.post("/api/auth/demo")
    assert created.status_code == 200  # the hour has passed

    # After the retention period the old trial accounts and their data are removed; newer ones stay.
    fresh = created.json()["id"]
    _as(client, created.cookies[auth.COOKIE_NAME])  # the cookie is Secure, so the http test client needs it set by hand
    assert client.put("/api/profile", json=PROFILE).status_code == 200
    assert client.post("/api/assessments", json=MEASUREMENT).status_code == 201
    today = datetime.now(timezone.utc).date().isoformat()
    pill = client.post("/api/medications", json={"name": "Thuốc thử", "start_date": today, "morning": True})
    assert client.put(f"/api/medications/{pill.json()['id']}/intakes/morning", json={"scheduled_on": today, "taken": True}).status_code == 200

    async def intakes():
        async with client.db_factory() as session:
            return await session.scalar(select(func.count()).select_from(MedicationIntake))

    async def age_all_but(keep_id, **delta):
        async with client.db_factory() as session:
            await session.execute(update(User).where(User.id != keep_id).values(created_at=datetime.now(timezone.utc) - timedelta(**delta)))
            await session.commit()

    async def counts():
        async with client.db_factory() as session:
            return (await session.scalar(select(func.count()).select_from(User)),
                    await session.scalar(select(func.count()).select_from(Assessment)))
    asyncio.run(age_all_but(fresh, days=4))
    assert asyncio.run(counts()) == (7, 1)
    client.cookies.clear()
    assert client.post("/api/auth/demo").status_code == 200
    assert asyncio.run(counts()) == (2, 1)  # the fresh account with its reading, plus the one just created
    asyncio.run(age_all_but("", days=4))
    client.cookies.clear()
    assert client.post("/api/auth/demo").status_code == 200
    assert asyncio.run(counts()) == (1, 0)  # the aged account's reading went with it
    assert asyncio.run(intakes()) == 0  # and its "Đã uống" ticks, which would otherwise block deleting its medicines
    # The switch alone decides: without it, a non-local deployment offers no trial login.
    monkeypatch.setattr(auth.settings, "demo_public", False)
    assert client.post("/api/auth/demo").status_code == 404


def test_medical_document_requires_review_then_is_account_scoped(client, monkeypatch):
    login(client)
    client.put("/api/profile", json=PROFILE)
    analysis = MedicalDocumentAnalysis(
        document_type="lab_result",
        document_date="2026-09-20",
        provider="Phòng xét nghiệm mẫu",
        title="Kết quả xét nghiệm giả định",
        summary="Tài liệu giả định dùng để kiểm thử.",
        metrics=[{"name": "Glucose", "value": "99", "unit": "mg/dL", "reference_range": "70-99", "flag": "normal"}],
        conditions=[], medications=[], recommendations=["Đối chiếu với bản gốc."], warnings=[],
        confidence="high", review_required=True, source="ai",
        disclaimer="AI chỉ hỗ trợ trích xuất; cần kiểm tra lại với bản gốc.",
    )

    async def fake_analysis(*_args):
        return analysis

    monkeypatch.setattr(main.ai_service, "analyze_document", fake_analysis)
    image = b"\x89PNG\r\n\x1a\nsynthetic-image"
    analyzed = client.post(
        "/api/medical-records/analyze",
        files={"file": ("synthetic.png", image, "image/png")},
        data={"consent": "true"},
    )
    assert analyzed.status_code == 200
    assert analyzed.json()["analysis"]["review_required"] is True
    assert "không được ghi" in analyzed.json()["privacy_note"]
    assert analyzed.json()["analysis"]["vitals"]["systolic"] is None  # nothing invented when the AI found none
    assert client.get("/api/medical-records").json() == []

    saved = client.post("/api/medical-records", json={
        "analysis": analyzed.json()["analysis"],
        "document_hash": analyzed.json()["document_hash"],
        "health_consent": True,
    })
    assert saved.status_code == 201
    record_id = saved.json()["id"]
    assert len(client.get("/api/medical-records").json()) == 1
    assert client.post("/api/medical-records", json={
        "analysis": analyzed.json()["analysis"],
        "document_hash": analyzed.json()["document_hash"],
        "health_consent": True,
    }).json()["id"] == record_id
    assert client.delete("/api/medical-records/" + record_id).status_code == 204
    assert client.get("/api/medical-records").json() == []
    record_id = client.post("/api/medical-records", json={
        "analysis": analyzed.json()["analysis"],
        "document_hash": analyzed.json()["document_hash"],
        "health_consent": True,
    }).json()["id"]

    client.post("/api/auth/logout")
    login(client)
    assert client.get("/api/medical-records").json() == []
    assert client.delete("/api/medical-records/" + record_id).status_code == 404


def test_document_reading_is_dated_history_and_never_the_current_state(client):
    login(client)
    client.put("/api/profile", json=PROFILE)
    home = client.post("/api/assessments", json=MEASUREMENT).json()
    risk_before = client.get("/api/risk").json()
    dangerous = {"vitals": {"systolic": 190, "diastolic": 125}, "source": "document", "measured_on": "2024-03-15"}
    saved = client.post("/api/assessments", json=dangerous)
    assert saved.status_code == 201
    assert saved.json()["measurement_source"] == "document" and saved.json()["created_at"].startswith("2024-03-15T12:00")
    history = client.get("/api/assessments").json()
    assert [row["id"] for row in history] == [home["id"], saved.json()["id"]]  # sorted by the printed date
    assert history[1]["vitals"]["source"] == "document"
    # Without a printed date it is stored as of now, and still does not replace the home reading in the live score.
    assert client.post("/api/assessments", json=dangerous | {"measured_on": None}).status_code == 201
    assert client.get("/api/risk").json()["scores"] == risk_before["scores"]
    assert client.post("/api/assessments", json=dangerous | {"measured_on": "2999-01-01"}).status_code == 422
    assert client.post("/api/assessments", json=MEASUREMENT | {"measured_on": "2024-03-15"}).status_code == 422


def test_document_analysis_keeps_only_known_structured_values():
    from backend.app.services.ai_service import MEDICAL_DOCUMENT_SCHEMA, _gemini_schema, _medical_analysis_from_json
    import json
    analysis = _medical_analysis_from_json(json.dumps({
        "document_type": "discharge_note", "document_date": "", "provider": "", "title": "Giấy ra viện", "summary": "Tóm tắt",
        "metrics": [], "conditions": ["Tăng huyết áp"], "medications": [], "recommendations": [], "warnings": [],
        "confidence": "medium", "review_required": True, "source": "ai", "disclaimer": "",
        "vitals": {"systolic": 150, "diastolic": 95, "heart_rate": 0, "spo2": None, "glucose": "cao"},
        "own_conditions": ["hypertension", "hypertension", "flu"],
        "family_conditions": [{"member": "father", "condition": "stroke"}, {"member": "uncle", "condition": "stroke"}],
    }))
    assert analysis.vitals.model_dump() == {"systolic": 150, "diastolic": 95, "heart_rate": None, "spo2": None, "glucose": None}
    assert analysis.own_conditions == ["hypertension"]
    assert [(item.member, item.condition) for item in analysis.family_conditions] == [("father", "stroke")]
    assert _gemini_schema(MEDICAL_DOCUMENT_SCHEMA)["properties"]["vitals"]["properties"]["systolic"]["type"] == "number"
    assert "YYYY-MM-DD" in _gemini_schema(MEDICAL_DOCUMENT_SCHEMA)["properties"]["document_date"]["description"]


def test_document_analysis_survives_answers_outside_the_limits():
    """Gemini is not told the formats and lengths, so a day-first date or a long sentence must not fail the scan."""
    from backend.app.services.ai_service import _document_date, _medical_analysis_from_json
    import json
    answer = {
        "document_type": "other", "document_date": "01/10/2026", "provider": "x" * 500, "title": "Phiếu kết quả",
        "summary": "y" * 5000, "metrics": [{"name": "Nhịp tim", "value": "76", "unit": "lần/phút", "reference_range": "60-100", "flag": "normal"},
                                           {"name": "Trống", "value": "", "unit": "", "reference_range": "", "flag": "unknown"}],
        "conditions": [], "medications": [{"name": " ", "dose": "5 mg", "frequency": ""}, {"name": "Amlodipin", "dose": "5 mg", "frequency": ""}],
        "recommendations": ["z" * 900], "warnings": [], "confidence": "high",
        "review_required": True, "source": "ai", "disclaimer": "Đối chiếu bản gốc.", "note_from_model": "bỏ qua",
        "vitals": {"systolic": 128, "diastolic": 82, "heart_rate": 76, "spo2": 97, "glucose": 104},
        "own_conditions": [], "family_conditions": [],
    }
    analysis = _medical_analysis_from_json(json.dumps(answer))
    assert analysis.document_date == "2026-10-01" and analysis.vitals.systolic == 128
    assert len(analysis.provider) == 180 and len(analysis.summary) == 1200 and len(analysis.recommendations[0]) == 300
    assert [metric.name for metric in analysis.metrics] == ["Nhịp tim"]
    assert [medication.name for medication in analysis.medications] == ["Amlodipin"]
    assert _document_date("Ngày 01 tháng 10 năm 2026") == "2026-10-01" and _document_date("2026-10-01T07:15") == "2026-10-01"
    assert _document_date("2026/10/01") == "2026-10-01" and _document_date("01-10-2026-05-10-2026") == "2026-10-01"
    assert _document_date("Từ 01/10/2026 đến 05/10/2026") == "2026-10-01"
    assert _document_date("31/02/2026") is None and _document_date("không rõ") is None and _document_date(None) is None


def test_medication_schedule_is_validated_and_account_scoped(client):
    pill = {"name": " Paracetamol ", "strength": "500 mg", "amount": "1 viên", "morning": True, "evening": True,
            "meal": "after", "start_date": "2026-10-02", "days": 5}
    assert client.get("/api/medications").status_code == 401
    login(client)
    assert client.get("/api/medications").json() == []
    assert client.post("/api/medications", json=pill | {"name": "  "}).status_code == 422
    assert client.post("/api/medications", json=pill | {"meal": "unknown"}).status_code == 422
    assert client.post("/api/medications", json=pill | {"days": 0}).status_code == 422
    saved = client.post("/api/medications", json=pill)
    assert saved.status_code == 201 and saved.json()["name"] == "Paracetamol" and saved.json()["noon"] is False
    assert "as_needed" not in saved.json()
    medication_id = saved.json()["id"]
    # "Khi cần" must be chosen on purpose: no time of day without it, and never both.
    when_needed = {"name": "Paracetamol", "start_date": "2026-10-02"}
    assert client.put("/api/medications/" + medication_id, json=when_needed).status_code == 422
    assert client.post("/api/medications", json=pill | {"as_needed": True}).status_code == 422
    # No slot and no end date is allowed: a medicine taken when needed, for as long as the user keeps it.
    changed = client.put("/api/medications/" + medication_id, json=when_needed | {"as_needed": True})
    assert changed.status_code == 200 and changed.json()["days"] is None and changed.json()["morning"] is False
    assert [row["id"] for row in client.get("/api/medications").json()] == [medication_id]
    owner = client.cookies.get(auth.COOKIE_NAME)
    client.cookies.clear()
    login(client)
    assert client.get("/api/medications").json() == []
    assert client.put("/api/medications/" + medication_id, json=pill).status_code == 404
    assert client.delete("/api/medications/" + medication_id).status_code == 404
    client.cookies.clear()
    client.cookies.set(auth.COOKIE_NAME, owner)
    assert client.delete("/api/medications/" + medication_id).status_code == 204
    assert client.get("/api/medications").json() == []


def test_medicine_times_come_only_from_wording_the_code_can_trust():
    from backend.app.services.ai_service import _medical_analysis_from_json, medication_slots
    import json

    def slots(text):
        return "".join(letter if on else "-" for letter, on in zip("SMCT", medication_slots(text).values()))

    assert slots("1-0-1") == "S--T" and slots("0 - 0 - 1") == "---T" and slots("1-1-1-1") == "SMCT" and slots("½-0-½") == "S--T"
    assert slots("Sáng 1 viên, tối 1 viên") == "S--T" and slots("uống trưa và chiều") == "-MC-"
    # Not a dose pattern: dates, "1 x 2", "ngày 2 lần" and English leave every box empty for the user.
    assert slots("01-10-2026") == "----" and slots("1 x 2") == "----" and slots("ngày 2 lần") == "----"
    assert slots("once a day, before dinner") == "----" and slots("") == "----"
    assert slots("ngày 3 lần, tối đa 4 viên") == "----" and slots("uống tối, tối đa 2 viên, tránh ánh sáng") == "---T"
    answer = {
        "document_type": "prescription", "document_date": "02/10/2026", "provider": "", "title": "Đơn thuốc", "summary": "Đơn thuốc.",
        "metrics": [], "conditions": [], "recommendations": [], "warnings": [], "confidence": "medium", "review_required": True,
        "source": "ai", "disclaimer": "Đối chiếu bản gốc.", "vitals": {}, "own_conditions": [], "family_conditions": [],
        "medications": [
            {"name": "Rosuvastatin", "dose": "1 viên", "frequency": "0-0-1", "strength": "5 mg", "meal": "after", "days": 30.0, "unsure": True,
             "morning": True},
            {"name": "Lanol ER", "dose": "Unknown", "frequency": "4 to 6 hrly if >100F", "strength": "không rõ", "meal": "sometimes", "days": 9999, "unsure": "yes"},
        ],
    }
    first, second = _medical_analysis_from_json(json.dumps(answer)).medications
    assert (first.morning, first.evening, first.days, first.meal, first.unsure) == (False, True, 30, "after", True)
    assert (second.morning, second.noon, second.afternoon, second.evening) == (False, False, False, False)
    assert (second.days, second.meal, second.unsure, second.dose, second.strength) == (0, "unknown", False, "", "")


def test_medical_document_validation(client):
    login(client)
    client.put("/api/profile", json=PROFILE)
    image = b"\x89PNG\r\n\x1a\nsynthetic-image"
    no_consent = client.post(
        "/api/medical-records/analyze",
        files={"file": ("synthetic.png", image, "image/png")},
        data={"consent": "false"},
    )
    assert no_consent.status_code == 422
    wrong_type = client.post(
        "/api/medical-records/analyze",
        files={"file": ("synthetic.txt", b"not-an-image", "text/plain")},
        data={"consent": "true"},
    )
    assert wrong_type.status_code == 415


def test_legacy_migration_preserves_unowned_rows(tmp_path):
    engine = create_engine("sqlite:///" + str(tmp_path / "legacy.db"))
    with engine.begin() as conn:
        for table in ("assessments", "feedback"):
            conn.execute(text(f"CREATE TABLE {table} (id VARCHAR(36) PRIMARY KEY)"))
            conn.execute(text(f"INSERT INTO {table} (id) VALUES ('legacy-record')"))
        migrate_schema(conn)
        migrate_schema(conn)  # A second startup is safe.
        for table in ("assessments", "feedback"):
            assert "user_id" in {col["name"] for col in inspect(conn).get_columns(table)}
            assert conn.execute(text(f"SELECT id, user_id FROM {table}")).first() == ("legacy-record", None)
    engine.dispose()


def _demo_with_profile(client):
    user = login(client)
    client.put("/api/profile", json=PROFILE)
    return user, client.cookies.get(auth.COOKIE_NAME)


def _as(client, cookie):
    client.cookies.clear()
    client.cookies.set(auth.COOKIE_NAME, cookie)


def test_care_link_grants_read_only_access_until_revoked(client):
    patient, patient_cookie = _demo_with_profile(client)
    reading_id = client.post("/api/assessments", json=MEASUREMENT).json()["id"]
    code = client.post("/api/care/invites").json()["code"]
    assert client.post("/api/care/links", json={"code": code}).status_code == 400  # own code

    client.cookies.clear()  # keep the patient's session alive for later
    _, caregiver_cookie = _demo_with_profile(client)
    base = "/api/care/patients/" + patient["id"]
    assert client.get(base + "/assessments").status_code == 404  # no link yet
    linked = client.post("/api/care/links", json={"code": code.lower()})
    assert linked.status_code == 201 and linked.json()["patient_id"] == patient["id"]
    assert client.post("/api/care/links", json={"code": code}).status_code == 404  # single use

    assert [row["id"] for row in client.get(base + "/assessments").json()] == [reading_id]
    assert client.get(base + "/assessments/" + reading_id).status_code == 200
    shared = client.get(base + "/profile").json()["health"]
    assert set(shared) == {"display_name", "profile", "family_history"}
    risk = client.get(base + "/risk").json()
    assert risk["scores"]["vitals"] is not None and len(risk["conditions"]) == 7
    listed = client.get("/api/care/links").json()
    assert listed["patients"][0]["latest"]["risk_level"] == "safe" and listed["caregivers"] == []
    # Read-only: the caregiver cannot delete or reach the patient's own-account routes.
    assert client.delete("/api/assessments/" + reading_id).status_code == 404
    assert client.get("/api/assessments/" + reading_id).status_code == 404

    _as(client, patient_cookie)
    links = client.get("/api/care/links").json()
    assert len(links["caregivers"]) == 1 and links["patients"] == []
    assert client.delete("/api/care/links/" + links["caregivers"][0]["link_id"]).status_code == 204
    _as(client, caregiver_cookie)
    assert client.get(base + "/assessments").status_code == 404  # revoked at once
    assert client.get(base + "/profile").status_code == 404
    assert client.get(base + "/risk").status_code == 404
    assert client.get("/api/risk").json()["scores"]["vitals"] is None  # the caregiver has no reading of their own


def test_caregiver_sees_medicines_only_after_explicit_opt_in(client):
    patient, patient_cookie = _demo_with_profile(client)
    today = datetime.now(timezone.utc).date().isoformat()
    medication = client.post("/api/medications", json={
        "name": "Thuốc riêng", "start_date": today, "morning": True,
    }).json()
    code = client.post("/api/care/invites").json()["code"]
    client.cookies.clear()
    _, caregiver_cookie = _demo_with_profile(client)
    base = "/api/care/patients/" + patient["id"]
    assert client.post("/api/care/links", json={"code": code}).status_code == 201
    hidden = client.get(f"{base}/medications?scheduled_on={today}").json()
    assert hidden == {"shared": False, "medications": [], "intakes": []}

    _as(client, patient_cookie)
    assert client.put("/api/profile", json=PROFILE | {"share_medications": True}).status_code == 200
    _as(client, caregiver_cookie)
    shared = client.get(f"{base}/medications?scheduled_on={today}").json()
    assert shared["shared"] is True and [row["id"] for row in shared["medications"]] == [medication["id"]]

    _as(client, patient_cookie)
    assert client.put("/api/profile", json=PROFILE | {"share_medications": False}).status_code == 200
    _as(client, caregiver_cookie)
    hidden_again = client.get(f"{base}/medications?scheduled_on={today}").json()
    assert hidden_again == {"shared": False, "medications": [], "intakes": []}


def test_care_invite_expiry_replacement_and_rate_limit(client):
    from backend.app import care
    _, patient_cookie = _demo_with_profile(client)
    first = client.post("/api/care/invites").json()["code"]
    second = client.post("/api/care/invites").json()["code"]
    client.post("/api/auth/logout")
    _demo_with_profile(client)
    assert client.post("/api/care/links", json={"code": first}).status_code == 404  # replaced by the newer code

    async def expire():
        async with client.db_factory() as session:
            invite = await session.get(care.CareInvite, care._digest(second))
            invite.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
            await session.commit()
    asyncio.run(expire())
    assert client.post("/api/care/links", json={"code": second}).status_code == 404  # expired
    for _ in range(3):
        assert client.post("/api/care/links", json={"code": "WRONGCODE"}).status_code == 404
    assert client.post("/api/care/links", json={"code": "WRONGCODE"}).status_code == 429
