from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, JSON, LargeBinary, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    google_sub: Mapped[str | None] = mapped_column(String(255), unique=True, nullable=True)
    email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    display_name: Mapped[str] = mapped_column(String(100))
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)
    onboarding_completed: Mapped[bool] = mapped_column(Boolean, default=False)
    health_profile: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Avatar(Base):
    """The account's profile picture: one small JPEG, already cropped and shrunk by the browser."""

    __tablename__ = "avatars"

    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), primary_key=True)
    image: Mapped[bytes] = mapped_column(LargeBinary)


class LoginSession(Base):
    __tablename__ = "login_sessions"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class Assessment(Base):
    __tablename__ = "assessments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), index=True, nullable=True)
    client_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    profile: Mapped[dict] = mapped_column(JSON)
    family_history: Mapped[list] = mapped_column(JSON)
    vitals: Mapped[dict] = mapped_column(JSON)
    risk_level: Mapped[str] = mapped_column(String(20), index=True)
    overall_score: Mapped[float] = mapped_column(Float)
    pgrs_score: Mapped[float] = mapped_column(Float)
    brs_score: Mapped[float] = mapped_column(Float)
    vital_score: Mapped[float] = mapped_column(Float)
    result: Mapped[dict] = mapped_column(JSON)


class Feedback(Base):
    __tablename__ = "feedback"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    user_id: Mapped[str | None] = mapped_column(ForeignKey("users.id"), index=True, nullable=True)
    assessment_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    rating: Mapped[int] = mapped_column(Integer)
    message: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class MedicalRecord(Base):
    """AI-extracted health document data; the source image is never persisted."""

    __tablename__ = "medical_records"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    document_hash: Mapped[str] = mapped_column(String(64), index=True)
    analysis: Mapped[dict] = mapped_column(JSON)


class CareInvite(Base):
    """One-time code a patient gives to a relative. Only the hash is stored."""

    __tablename__ = "care_invites"

    code_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    patient_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class CareCodeFailure(Base):
    """A wrong sharing code typed by a user; counted to slow down guessing."""

    __tablename__ = "care_code_failures"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class CareLink(Base):
    """Read-only access for a caregiver to one patient's readings, profile and family history."""

    __tablename__ = "care_links"
    __table_args__ = (UniqueConstraint("patient_id", "caregiver_id"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    patient_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    caregiver_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Medication(Base):
    """One medicine on the user's schedule. It gets here only after the user typed it or checked it after a scan."""

    __tablename__ = "medications"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    name: Mapped[str] = mapped_column(String(160))
    strength: Mapped[str] = mapped_column(String(60), default="")
    amount: Mapped[str] = mapped_column(String(60), default="")
    morning: Mapped[bool] = mapped_column(Boolean, default=False)
    noon: Mapped[bool] = mapped_column(Boolean, default=False)
    afternoon: Mapped[bool] = mapped_column(Boolean, default=False)
    evening: Mapped[bool] = mapped_column(Boolean, default=False)
    meal: Mapped[str] = mapped_column(String(10), default="any")
    start_date: Mapped[str] = mapped_column(String(10))
    days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    note: Mapped[str] = mapped_column(String(200), default="")


class MedicationIntake(Base):
    """A user's daily record that one scheduled medicine was taken."""

    __tablename__ = "medication_intakes"
    __table_args__ = (UniqueConstraint("medication_id", "scheduled_on", "slot"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), index=True)
    medication_id: Mapped[str] = mapped_column(ForeignKey("medications.id"), index=True)
    scheduled_on: Mapped[str] = mapped_column(String(10), index=True)
    slot: Mapped[str] = mapped_column(String(12))
    taken_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
