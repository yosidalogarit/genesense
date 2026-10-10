"""Family sharing: a patient invites a relative with a one-time code; the relative gets read-only access."""
import hashlib
import secrets
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import current_user
from .database import get_session
from .models import Assessment, CareCodeFailure, CareInvite, CareLink, Medication, MedicationIntake, User
from .schemas import AccountProfile, AssessmentHistoryItem, AssessmentResult, BloodPressureAverage, WeeklyBloodPressureSummary
from .services.risk_engine import risk_overview

router = APIRouter(prefix="/api/care", tags=["care"])

# No 0/O/1/I/L, so a code read aloud or typed on a phone is not mistaken.
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 8
INVITE_HOURS = 24
MAX_FAILED_CODES = 5
FAILED_WINDOW_SECONDS = 15 * 60


class CareLinkCreate(BaseModel):
    code: str = Field(min_length=4, max_length=32)


def _digest(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


def _normalize(code: str) -> str:
    return "".join(ch for ch in code.upper() if ch.isalnum())


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def from_document(vitals: dict) -> bool:
    """Readings copied from a scanned document are history: they never count as the person's current state."""
    return (vitals or {}).get("source") == "document"


async def current_vital_score(user_id: str, session: AsyncSession) -> float | None:
    rows = await session.execute(select(Assessment.vital_score, Assessment.vitals).where(Assessment.user_id == user_id)
                                 .order_by(Assessment.created_at.desc()).limit(30))
    return next((score for score, vitals in rows if not from_document(vitals)), None)


async def weekly_bp_summary(user_id: str, timezone_offset: int, session: AsyncSession) -> WeeklyBloodPressureSummary:
    """Describe recorded seven-day averages by local clock time; this is not a diagnosis."""
    since = datetime.now(timezone.utc) - timedelta(days=7)
    rows = await session.execute(select(Assessment.created_at, Assessment.vitals).where(
        Assessment.user_id == user_id, Assessment.created_at >= since
    ).order_by(Assessment.created_at))
    groups: dict[str, list[tuple[float, float]]] = {"morning": [], "evening": []}
    for created_at, vitals in rows:
        if from_document(vitals):
            continue
        systolic, diastolic = (vitals or {}).get("systolic"), (vitals or {}).get("diastolic")
        if systolic is None or diastolic is None:
            continue
        aware = created_at if created_at.tzinfo else created_at.replace(tzinfo=timezone.utc)
        hour = (aware.astimezone(timezone.utc) - timedelta(minutes=timezone_offset)).hour
        group = "morning" if 5 <= hour < 12 else "evening" if hour >= 17 else None
        if group:
            groups[group].append((float(systolic), float(diastolic)))

    def average(values: list[tuple[float, float]]) -> BloodPressureAverage:
        if not values:
            return BloodPressureAverage(count=0, systolic=None, diastolic=None)
        return BloodPressureAverage(count=len(values),
                                    systolic=round(sum(value[0] for value in values) / len(values), 1),
                                    diastolic=round(sum(value[1] for value in values) / len(values), 1))

    return WeeklyBloodPressureSummary(morning=average(groups["morning"]), evening=average(groups["evening"]))


async def linked_patient(patient_id: str, user: User, session: AsyncSession) -> User:
    """Return the patient only when an active link gives this user access. 404 hides whether the id exists."""
    link = await session.scalar(select(CareLink).where(CareLink.patient_id == patient_id, CareLink.caregiver_id == user.id))
    patient = await session.get(User, patient_id) if link else None
    if not patient:
        raise HTTPException(404, "Không tìm thấy hồ sơ được chia sẻ.")
    return patient


@router.post("/invites", status_code=201)
async def create_invite(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    if not user.onboarding_completed or not user.health_profile:
        raise HTTPException(409, "Hãy hoàn thành hồ sơ sức khỏe trước khi chia sẻ.")
    # One live code per patient: a new code cancels the previous one.
    await session.execute(delete(CareInvite).where(CareInvite.patient_id == user.id))
    code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
    expires_at = datetime.now(timezone.utc) + timedelta(hours=INVITE_HOURS)
    session.add(CareInvite(code_hash=_digest(code), patient_id=user.id, expires_at=expires_at))
    await session.commit()
    return {"code": code, "expires_at": expires_at}


@router.post("/links", status_code=201)
async def accept_invite(payload: CareLinkCreate, user: User = Depends(current_user),
                        session: AsyncSession = Depends(get_session)):
    # Counted in the database so the limit holds across workers and serverless instances.
    since = datetime.now(timezone.utc) - timedelta(seconds=FAILED_WINDOW_SECONDS)
    failures = await session.scalar(select(func.count()).select_from(CareCodeFailure).where(
        CareCodeFailure.user_id == user.id, CareCodeFailure.created_at >= since))
    if failures >= MAX_FAILED_CODES:
        raise HTTPException(429, "Bạn đã nhập sai mã quá nhiều lần. Hãy thử lại sau 15 phút.")
    invite = await session.get(CareInvite, _digest(_normalize(payload.code)))
    if not invite or _aware(invite.expires_at) <= datetime.now(timezone.utc):
        session.add(CareCodeFailure(user_id=user.id))
        await session.commit()
        raise HTTPException(404, "Mã không đúng hoặc đã hết hạn. Hãy xin người thân tạo mã mới.")
    if invite.patient_id == user.id:
        raise HTTPException(400, "Đây là mã của chính bạn. Hãy gửi mã này cho người thân.")
    patient = await session.get(User, invite.patient_id)
    link = await session.scalar(select(CareLink).where(CareLink.patient_id == invite.patient_id,
                                                      CareLink.caregiver_id == user.id))
    if not link:
        link = CareLink(patient_id=invite.patient_id, caregiver_id=user.id)
        session.add(link)
    await session.delete(invite)  # single use
    await session.execute(delete(CareCodeFailure).where(CareCodeFailure.user_id == user.id))
    await session.flush()
    result = {"link_id": link.id, "patient_id": patient.id, "display_name": patient.display_name}
    await session.commit()
    return result


@router.get("/links")
async def list_links(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    links = list(await session.scalars(select(CareLink).where(
        or_(CareLink.patient_id == user.id, CareLink.caregiver_id == user.id)).order_by(CareLink.created_at)))
    since = datetime.now(timezone.utc) - timedelta(hours=24)
    patients, caregivers = [], []
    for link in links:
        if link.caregiver_id == user.id:
            patient = await session.get(User, link.patient_id)
            rows = [row for row in await session.scalars(select(Assessment).where(Assessment.user_id == patient.id)
                                                         .order_by(Assessment.created_at.desc()).limit(30))
                    if not from_document(row.vitals)]
            danger = next((row for row in rows if _aware(row.created_at) >= since
                           and any(alert.get("severity") == "alert" for alert in row.result.get("alerts", []))), None)
            latest = rows[0] if rows else None
            patients.append({
                "link_id": link.id, "patient_id": patient.id, "display_name": patient.display_name,
                "latest": latest and {"created_at": latest.created_at, "risk_level": latest.risk_level, "vitals": latest.vitals},
                "recent_emergency_at": danger and danger.created_at,
            })
        else:
            caregiver = await session.get(User, link.caregiver_id)
            caregivers.append({"link_id": link.id, "display_name": caregiver.display_name, "created_at": link.created_at})
    return {"patients": patients, "caregivers": caregivers}


@router.delete("/links/{link_id}", status_code=204)
async def remove_link(link_id: str, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    link = await session.get(CareLink, link_id)
    if not link or user.id not in (link.patient_id, link.caregiver_id):
        raise HTTPException(404, "Không tìm thấy liên kết này.")
    await session.delete(link)
    await session.commit()
    return Response(status_code=204)


@router.get("/patients/{patient_id}/profile")
async def patient_profile(patient_id: str, user: User = Depends(current_user),
                          session: AsyncSession = Depends(get_session)):
    patient = await linked_patient(patient_id, user, session)
    health = patient.health_profile or {}
    # Shared: profile and family tree. Not shared: email, free-text notes, consents, scanned documents.
    return {"display_name": patient.display_name,
            "health": {"display_name": patient.display_name, "profile": health.get("profile"),
                       "family_history": health.get("family_history", [])}}


@router.get("/patients/{patient_id}/medications")
async def patient_medications(
    patient_id: str,
    scheduled_on: date = Query(...),
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
):
    patient = await linked_patient(patient_id, user, session)
    health = patient.health_profile or {}
    if not health.get("share_medications", False):
        return {"shared": False, "medications": [], "intakes": []}
    day = scheduled_on.isoformat()
    medications = list(await session.scalars(select(Medication).where(Medication.user_id == patient.id)
                                             .order_by(Medication.created_at)))
    active = [medication for medication in medications
              if medication.start_date <= day and (not medication.days or
                 scheduled_on <= date.fromisoformat(medication.start_date) + timedelta(days=medication.days - 1))]
    intakes = []
    if active:
        intakes = list(await session.scalars(select(MedicationIntake).where(
            MedicationIntake.user_id == patient.id,
            MedicationIntake.scheduled_on == day,
            MedicationIntake.medication_id.in_([medication.id for medication in active]),
        )))
    return {"shared": True, "medications": active, "intakes": intakes}


@router.get("/patients/{patient_id}/risk")
async def patient_risk(patient_id: str, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    patient = await linked_patient(patient_id, user, session)
    if not patient.health_profile:
        raise HTTPException(404, "Không tìm thấy hồ sơ được chia sẻ.")
    return risk_overview(AccountProfile.model_validate(patient.health_profile), await current_vital_score(patient.id, session))


@router.get("/patients/{patient_id}/weekly-bp", response_model=WeeklyBloodPressureSummary)
async def patient_weekly_blood_pressure(
    patient_id: str,
    timezone_offset: int = Query(default=0, ge=-720, le=840),
    user: User = Depends(current_user),
    session: AsyncSession = Depends(get_session),
):
    patient = await linked_patient(patient_id, user, session)
    return await weekly_bp_summary(patient.id, timezone_offset, session)


@router.get("/patients/{patient_id}/assessments", response_model=list[AssessmentHistoryItem])
async def patient_assessments(patient_id: str, limit: int = Query(default=100, ge=1, le=100),
                              user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    patient = await linked_patient(patient_id, user, session)
    return list(await session.scalars(select(Assessment).where(Assessment.user_id == patient.id)
                                      .order_by(Assessment.created_at.desc()).limit(limit)))


@router.get("/patients/{patient_id}/assessments/{assessment_id}", response_model=AssessmentResult)
async def patient_assessment(patient_id: str, assessment_id: str, user: User = Depends(current_user),
                             session: AsyncSession = Depends(get_session)):
    patient = await linked_patient(patient_id, user, session)
    record = await session.scalar(select(Assessment).where(Assessment.id == assessment_id, Assessment.user_id == patient.id))
    if not record:
        raise HTTPException(404, "Không tìm thấy lần theo dõi này.")
    return AssessmentResult.model_validate(record.result | {"id": record.id})
