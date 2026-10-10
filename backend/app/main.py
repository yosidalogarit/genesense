import hashlib
import secrets
from contextlib import asynccontextmanager
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.middleware.sessions import SessionMiddleware
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .auth import current_user, public_user, router as auth_router
from .care import current_vital_score, router as care_router, weekly_bp_summary
from .config import get_settings
from .database import engine, get_session
from .migrations import migrate_schema
from .models import Assessment, Avatar, Feedback, MedicalRecord, Medication, MedicationIntake, User
from .schemas import (AccountProfile, AssessmentCreate, AssessmentHistoryItem, AssessmentResult,
                      FeedbackCreate, FeedbackResult, MedicalDocumentAnalyzeResult,
                      MedicalRecordCreate, MedicalRecordResult, MeasurementCreate,
                      MedicationInput, MedicationIntakeResult, MedicationIntakeUpdate, MedicationResult,
                      WeeklyBloodPressureSummary)
from .services.ai_service import AIInsightService
from .services.risk_engine import calculate_risk, risk_overview

ROOT_DIR = Path(__file__).resolve().parents[2]
FRONTEND_DIR = ROOT_DIR / "frontend"
settings = get_settings()
ai_service = AIInsightService(settings)


@asynccontextmanager
async def lifespan(_: FastAPI):
    if settings.app_env != "development" and (len(settings.session_secret) < 32 or not settings.secure_cookies):
        raise RuntimeError("Production requires SESSION_SECRET (32+ characters) and HTTPS APP_BASE_URL")
    async with engine.begin() as connection:
        await connection.run_sync(migrate_schema)
    yield
    await engine.dispose()


# The interactive API pages are a development aid; a public deployment does not publish them.
api_pages = {} if settings.app_env == "development" else {"docs_url": None, "redoc_url": None, "openapi_url": None}
app = FastAPI(title=settings.app_name, version="2.0.0", lifespan=lifespan, **api_pages)
app.add_middleware(SessionMiddleware, secret_key=settings.session_secret or secrets.token_urlsafe(48),
                   session_cookie="healthpredict_oauth", max_age=600,
                   same_site="lax", https_only=settings.secure_cookies)
allowed_origins = {settings.app_base_url.rstrip("/")}
if settings.app_env == "development":
    allowed_origins.update(settings.allowed_origins)
app.add_middleware(CORSMiddleware, allow_origins=list(allowed_origins), allow_credentials=True,
                   allow_methods=["GET", "POST", "PUT", "DELETE"], allow_headers=["Content-Type", "X-Requested-With"])
allowed_hosts = [urlsplit(settings.app_base_url).hostname]
if settings.app_env == "development":
    allowed_hosts += ["localhost", "127.0.0.1", "testserver"]
app.add_middleware(TrustedHostMiddleware, allowed_hosts=allowed_hosts)


# Sent with the page ("/", the only HTML document the app serves). The page may load only its own
# scripts, styles and images, plus the web font from Google Fonts; inline scripts, inline event
# handlers and style attributes are refused, so text that slips into the page cannot run as code.
# New frontend code must therefore set styles through classes or element.style, never style="...".
CONTENT_SECURITY_POLICY = "; ".join([
    "default-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' blob:",  # blob: is the preview of a document photo before it is sent
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
])


@app.middleware("http")
async def privacy_and_csrf(request: Request, call_next):
    if request.method in {"POST", "PUT", "PATCH", "DELETE"}:
        origin = request.headers.get("origin")
        if request.headers.get("x-requested-with") != "HealthPredict" or (origin and origin not in allowed_origins):
            return JSONResponse({"detail": "Yêu cầu không hợp lệ. Vui lòng tải lại trang."}, status_code=403)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Frame-Options"] = "DENY"
    if request.url.path.startswith("/api/") or request.url.path in {"/", "/sw.js"}:
        response.headers["Cache-Control"] = "no-store"
    elif request.url.path.startswith(("/assets/", "/js/")):
        # Without this the browser guesses a lifetime and can pair a fresh page with a stale stylesheet or script.
        response.headers["Cache-Control"] = "no-cache"
    if request.url.path == "/":
        response.headers["Content-Security-Policy"] = CONTENT_SECURITY_POLICY
    return response


app.include_router(auth_router)
app.include_router(care_router)


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/profile")
async def get_profile(user: User = Depends(current_user)):
    return {"user": public_user(user), "health": user.health_profile}


@app.put("/api/profile")
async def save_profile(payload: AccountProfile, user: User = Depends(current_user),
                       session: AsyncSession = Depends(get_session)):
    user.health_profile = payload.model_dump(mode="json")
    user.display_name = payload.display_name
    user.onboarding_completed = True
    await session.commit()
    return {"user": public_user(user), "health": user.health_profile}


MAX_AVATAR_BYTES = 200 * 1024


@app.get("/api/avatar")
async def get_avatar(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    avatar = await session.get(Avatar, user.id)
    # 204 rather than 404: an account without a picture is normal and should not log an error in the browser.
    return Response(avatar.image, media_type="image/jpeg") if avatar else Response(status_code=204)


@app.put("/api/avatar", status_code=204)
async def save_avatar(request: Request, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    # The browser sends a 256px JPEG; anything else is refused instead of being converted here.
    if int(request.headers.get("content-length") or 0) > MAX_AVATAR_BYTES:
        raise HTTPException(413, "Ảnh quá lớn. Hãy chọn ảnh khác.")
    content = await request.body()
    if len(content) > MAX_AVATAR_BYTES:
        raise HTTPException(413, "Ảnh quá lớn. Hãy chọn ảnh khác.")
    if not content.startswith(b"\xff\xd8\xff"):
        raise HTTPException(422, "Tệp không phải ảnh hợp lệ.")
    await session.merge(Avatar(user_id=user.id, image=content))
    await session.commit()


@app.delete("/api/avatar", status_code=204)
async def delete_avatar(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    await session.execute(delete(Avatar).where(Avatar.user_id == user.id))
    await session.commit()


@app.get("/api/risk")
async def get_risk(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    if not user.onboarding_completed or not user.health_profile:
        raise HTTPException(409, "Hãy hoàn thành hồ sơ sức khỏe trước.")
    return risk_overview(AccountProfile.model_validate(user.health_profile), await current_vital_score(user.id, session))


@app.post("/api/assessments", response_model=AssessmentResult, status_code=201)
async def create_assessment(measurement: MeasurementCreate, user: User = Depends(current_user),
                            session: AsyncSession = Depends(get_session)):
    if not user.onboarding_completed or not user.health_profile:
        raise HTTPException(409, "Hãy hoàn thành hồ sơ sức khỏe trước lần theo dõi đầu tiên.")
    if measurement.client_id:
        existing = await session.scalar(select(Assessment).where(
            Assessment.user_id == user.id, Assessment.client_id == measurement.client_id
        ))
        if existing:
            return AssessmentResult.model_validate(existing.result | {"id": existing.id})
    profile = AccountProfile.model_validate(user.health_profile)
    payload = AssessmentCreate(profile=profile.profile, family_history=profile.family_history,
                               vitals=measurement.vitals, samples=measurement.samples)
    result = calculate_risk(payload).result
    if profile.ai_consent and not user.is_demo and measurement.source not in {"simulation", "document"}:
        result.insight = await ai_service.enrich(payload, result)
    result.measurement_source = measurement.source
    result.measured_vitals = measurement.vitals
    if measurement.measured_on:
        # Midday UTC keeps the printed date the same calendar day in Vietnam and nearby time zones.
        result.created_at = datetime.combine(measurement.measured_on, time(12), tzinfo=timezone.utc)
    elif measurement.vitals.timestamp:
        result.created_at = measurement.vitals.timestamp.astimezone(timezone.utc)
    record = Assessment(user_id=user.id, created_at=result.created_at, profile=payload.profile.model_dump(mode="json"),
                        client_id=measurement.client_id,
                        family_history=[item.model_dump(mode="json") for item in payload.family_history],
                        vitals=measurement.vitals.model_dump(mode="json") | {"source": measurement.source},
                        risk_level=result.risk_level, overall_score=result.scores.overall,
                        pgrs_score=result.scores.pgrs, brs_score=result.scores.brs, vital_score=result.scores.vitals,
                        result=result.model_dump(mode="json"))
    session.add(record)
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        if measurement.client_id:
            existing = await session.scalar(select(Assessment).where(
                Assessment.user_id == user.id, Assessment.client_id == measurement.client_id
            ))
            if existing:
                return AssessmentResult.model_validate(existing.result | {"id": existing.id})
        raise
    result.id = record.id
    return result


@app.get("/api/assessments", response_model=list[AssessmentHistoryItem])
async def list_assessments(limit: int = Query(default=30, ge=1, le=100),
                           user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    rows = await session.scalars(select(Assessment).where(Assessment.user_id == user.id)
                                .order_by(Assessment.created_at.desc()).limit(limit))
    return list(rows)


@app.get("/api/assessments/weekly-bp", response_model=WeeklyBloodPressureSummary)
async def weekly_blood_pressure(
    timezone_offset: int = Query(default=0, ge=-720, le=840),
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
):
    return await weekly_bp_summary(user.id, timezone_offset, session)


@app.get("/api/assessments/{assessment_id}", response_model=AssessmentResult)
async def get_assessment(assessment_id: str, user: User = Depends(current_user),
                         session: AsyncSession = Depends(get_session)):
    record = await session.scalar(select(Assessment).where(Assessment.id == assessment_id, Assessment.user_id == user.id))
    if not record:
        raise HTTPException(404, "Không tìm thấy lần theo dõi này.")
    return AssessmentResult.model_validate(record.result | {"id": record.id})


@app.delete("/api/assessments/{assessment_id}", status_code=204)
async def delete_assessment(assessment_id: str, user: User = Depends(current_user),
                            session: AsyncSession = Depends(get_session)):
    record = await session.scalar(select(Assessment).where(Assessment.id == assessment_id, Assessment.user_id == user.id))
    if not record:
        raise HTTPException(404, "Không tìm thấy lần theo dõi này.")
    await session.delete(record)
    await session.commit()
    return Response(status_code=204)


@app.post("/api/feedback", response_model=FeedbackResult, status_code=201)
async def create_feedback(payload: FeedbackCreate, user: User = Depends(current_user),
                          session: AsyncSession = Depends(get_session)):
    if payload.assessment_id:
        record = await session.scalar(select(Assessment).where(Assessment.id == payload.assessment_id,
                                                               Assessment.user_id == user.id))
        if not record:
            raise HTTPException(404, "Không tìm thấy lần theo dõi này.")
    record = Feedback(**payload.model_dump(), user_id=user.id)
    session.add(record)
    await session.commit()
    return FeedbackResult(id=record.id)


MAX_DOCUMENT_IMAGE_BYTES = 8 * 1024 * 1024
DOCUMENT_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}


def valid_image_signature(content: bytes, mime_type: str) -> bool:
    if mime_type == "image/jpeg":
        return content.startswith(b"\xff\xd8\xff")
    if mime_type == "image/png":
        return content.startswith(b"\x89PNG\r\n\x1a\n")
    if mime_type == "image/webp":
        return len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP"
    return False


@app.post("/api/medical-records/analyze", response_model=MedicalDocumentAnalyzeResult)
async def analyze_medical_record(
    file: UploadFile = File(...),
    consent: bool = Form(...),
    user: User = Depends(current_user),
):
    if not user.onboarding_completed or not user.health_profile:
        raise HTTPException(409, "Hãy hoàn thành hồ sơ sức khỏe trước khi thêm tài liệu.")
    if consent is not True:
        raise HTTPException(422, "Bạn cần đồng ý gửi ảnh đến AI cho lần phân tích này.")
    mime_type = (file.content_type or "").lower()
    if mime_type not in DOCUMENT_IMAGE_TYPES:
        raise HTTPException(415, "Chỉ hỗ trợ ảnh JPG, PNG hoặc WebP.")
    content = await file.read(MAX_DOCUMENT_IMAGE_BYTES + 1)
    await file.close()
    if not content:
        raise HTTPException(422, "Ảnh đang trống. Vui lòng chọn ảnh khác.")
    if len(content) > MAX_DOCUMENT_IMAGE_BYTES:
        raise HTTPException(413, "Ảnh vượt quá giới hạn 8 MB.")
    if not valid_image_signature(content, mime_type):
        raise HTTPException(415, "Nội dung tệp không khớp định dạng ảnh đã chọn.")
    safety_identifier = hashlib.sha256(f"healthpredict:{user.id}".encode()).hexdigest()
    try:
        analysis = await ai_service.analyze_document(content, mime_type, safety_identifier)
    except RuntimeError as error:
        raise HTTPException(503, str(error))
    return MedicalDocumentAnalyzeResult(
        analysis=analysis,
        document_hash=hashlib.sha256(content).hexdigest(),
        privacy_note="Ảnh gốc không được ghi vào hệ thống GeneSense. Khi bạn lưu, ảnh chỉ được giữ trên thiết bị này.",
    )


@app.post("/api/medical-records", response_model=MedicalRecordResult, status_code=201)
async def save_medical_record(
    payload: MedicalRecordCreate,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
):
    existing = await session.scalar(select(MedicalRecord).where(
        MedicalRecord.user_id == user.id, MedicalRecord.document_hash == payload.document_hash
    ))
    if existing:
        return MedicalRecordResult(id=existing.id, created_at=existing.created_at, analysis=existing.analysis)
    record = MedicalRecord(user_id=user.id, document_hash=payload.document_hash,
                           analysis=payload.analysis.model_dump(mode="json"))
    session.add(record)
    await session.commit()
    return MedicalRecordResult(id=record.id, created_at=record.created_at, analysis=record.analysis)


@app.get("/api/medical-records", response_model=list[MedicalRecordResult])
async def list_medical_records(
    limit: int = Query(default=30, ge=1, le=100),
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
):
    rows = await session.scalars(select(MedicalRecord).where(MedicalRecord.user_id == user.id)
                                 .order_by(MedicalRecord.created_at.desc()).limit(limit))
    return [MedicalRecordResult(id=row.id, created_at=row.created_at, analysis=row.analysis) for row in rows]


@app.delete("/api/medical-records/{record_id}", status_code=204)
async def delete_medical_record(
    record_id: str,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
):
    record = await session.scalar(select(MedicalRecord).where(
        MedicalRecord.id == record_id, MedicalRecord.user_id == user.id
    ))
    if not record:
        raise HTTPException(404, "Không tìm thấy hồ sơ sức khỏe này.")
    await session.delete(record)
    await session.commit()
    return Response(status_code=204)


MAX_MEDICATIONS = 60


async def own_medication(medication_id: str, user: User, session: AsyncSession) -> Medication:
    medication = await session.scalar(select(Medication).where(Medication.id == medication_id, Medication.user_id == user.id))
    if not medication:
        raise HTTPException(404, "Không tìm thấy thuốc này.")
    return medication


@app.get("/api/medications", response_model=list[MedicationResult])
async def list_medications(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    return list(await session.scalars(select(Medication).where(Medication.user_id == user.id).order_by(Medication.created_at)))


@app.get("/api/medications/intakes", response_model=list[MedicationIntakeResult])
async def list_medication_intakes(
    scheduled_on: date = Query(...),
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
):
    return list(await session.scalars(select(MedicationIntake).where(
        MedicationIntake.user_id == user.id, MedicationIntake.scheduled_on == scheduled_on.isoformat()
    )))


@app.put("/api/medications/{medication_id}/intakes/{slot}", response_model=MedicationIntakeResult)
async def set_medication_intake(
    medication_id: str,
    slot: Literal["morning", "noon", "afternoon", "evening"],
    payload: MedicationIntakeUpdate,
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
):
    medication = await own_medication(medication_id, user, session)
    if not getattr(medication, slot):
        raise HTTPException(422, "Buổi này không có trong lịch thuốc.")
    day = payload.scheduled_on.isoformat()
    if day < medication.start_date or (medication.days and payload.scheduled_on > date.fromisoformat(medication.start_date) + timedelta(days=medication.days - 1)):
        raise HTTPException(422, "Ngày này không nằm trong đợt dùng thuốc.")
    intake = await session.scalar(select(MedicationIntake).where(
        MedicationIntake.medication_id == medication.id,
        MedicationIntake.scheduled_on == day,
        MedicationIntake.slot == slot,
    ))
    if not payload.taken:
        if intake:
            await session.delete(intake)
            await session.commit()
        return MedicationIntakeResult(medication_id=medication.id, scheduled_on=payload.scheduled_on,
                                      slot=slot, taken=False)
    if not intake:
        intake = MedicationIntake(user_id=user.id, medication_id=medication.id, scheduled_on=day, slot=slot)
        session.add(intake)
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            intake = await session.scalar(select(MedicationIntake).where(
                MedicationIntake.medication_id == medication.id,
                MedicationIntake.scheduled_on == day,
                MedicationIntake.slot == slot,
            ))
    taken_at = intake.taken_at if intake else datetime.now(timezone.utc)
    if taken_at.tzinfo is None:  # SQLite drops the offset when a row is read back.
        taken_at = taken_at.replace(tzinfo=timezone.utc)
    return MedicationIntakeResult(medication_id=medication.id, scheduled_on=payload.scheduled_on,
                                  slot=slot, taken=True, taken_at=taken_at)


@app.post("/api/medications", response_model=MedicationResult, status_code=201)
async def add_medication(payload: MedicationInput, user: User = Depends(current_user),
                         session: AsyncSession = Depends(get_session)):
    count = len(list(await session.scalars(select(Medication.id).where(Medication.user_id == user.id))))
    if count >= MAX_MEDICATIONS:
        raise HTTPException(409, "Danh sách thuốc đã đầy. Hãy xóa thuốc không còn dùng.")
    medication = Medication(user_id=user.id, **payload.model_dump(mode="json"))
    session.add(medication)
    await session.commit()
    return medication


@app.put("/api/medications/{medication_id}", response_model=MedicationResult)
async def update_medication(medication_id: str, payload: MedicationInput, user: User = Depends(current_user),
                            session: AsyncSession = Depends(get_session)):
    medication = await own_medication(medication_id, user, session)
    for key, value in payload.model_dump(mode="json").items():
        setattr(medication, key, value)
    await session.commit()
    return medication


@app.delete("/api/medications/{medication_id}", status_code=204)
async def delete_medication(medication_id: str, user: User = Depends(current_user),
                            session: AsyncSession = Depends(get_session)):
    medication = await own_medication(medication_id, user, session)
    await session.execute(delete(MedicationIntake).where(MedicationIntake.medication_id == medication.id))
    await session.delete(medication)
    await session.commit()


app.mount("/assets", StaticFiles(directory=FRONTEND_DIR / "assets"), name="assets")
app.mount("/js", StaticFiles(directory=FRONTEND_DIR / "js"), name="js")


@app.get("/manifest.webmanifest", include_in_schema=False)
async def manifest():
    return FileResponse(FRONTEND_DIR / "manifest.webmanifest", media_type="application/manifest+json")


@app.get("/sw.js", include_in_schema=False)
async def service_worker():
    return FileResponse(FRONTEND_DIR / "sw.js", media_type="application/javascript")


@app.get("/", include_in_schema=False)
async def home():
    return FileResponse(FRONTEND_DIR / "index.html")
