"""GeneSense measuring devices (the UNIHIKER K10) linked to an account.

Pairing works like signing in a TV app: the device asks for a code, shows it with a QR code, and the
owner confirms it on a phone where they are signed in. The device then sends readings with its own
long-lived token. Only SHA-256 hashes of codes and tokens are stored.
"""
import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import current_user
from .care import CODE_ALPHABET, FAILED_WINDOW_SECONDS, MAX_FAILED_CODES
from .config import get_settings
from .database import get_session
from .models import CareCodeFailure, Device, DevicePairing, User

settings = get_settings()
router = APIRouter(prefix="/api/devices", tags=["devices"])
CODE_LENGTH = 8
PAIR_SECONDS = 10 * 60
POLL_SECONDS = 5
PAIRINGS_PER_HOUR = 300  # for the whole site: the start call needs no account


class PairStart(BaseModel):
    name: str = Field(default="Máy đo GeneSense", min_length=1, max_length=40)


class PairToken(BaseModel):
    device_code: str = Field(min_length=20, max_length=100)


class PairCode(BaseModel):
    code: str = Field(min_length=4, max_length=32)


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _normalize(code: str) -> str:
    return "".join(ch for ch in code.upper() if ch.isalnum())


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def current_device(request: Request, session: AsyncSession = Depends(get_session)) -> Device:
    header = request.headers.get("authorization", "")
    token = header[7:].strip() if header.lower().startswith("bearer ") else ""
    device = await session.scalar(select(Device).where(Device.token_hash == _digest(token))) if token else None
    if not device:
        raise HTTPException(401, "Máy đo chưa được kết nối hoặc đã bị ngắt kết nối.")
    return device


@router.post("/pair", status_code=201)
async def start_pairing(payload: PairStart, session: AsyncSession = Depends(get_session)):
    now = _now()
    await session.execute(delete(DevicePairing).where(DevicePairing.expires_at < now))
    recent = await session.scalar(select(func.count()).select_from(DevicePairing)
                                  .where(DevicePairing.created_at >= now - timedelta(hours=1)))
    if recent >= PAIRINGS_PER_HOUR:
        raise HTTPException(429, "Đang có quá nhiều yêu cầu kết nối. Hãy thử lại sau ít phút.")
    device_code = secrets.token_urlsafe(32)
    code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
    session.add(DevicePairing(device_code_hash=_digest(device_code), user_code_hash=_digest(code),
                              device_name=payload.name.strip()[:40] or "Máy đo GeneSense",
                              expires_at=now + timedelta(seconds=PAIR_SECONDS)))
    await session.commit()
    return {"device_code": device_code, "user_code": code,
            "verification_url": settings.app_base_url.rstrip("/") + "/#ket-noi-may?ma=" + code,
            "expires_in": PAIR_SECONDS, "interval": POLL_SECONDS}


@router.post("/pair/token")
async def pairing_token(payload: PairToken, session: AsyncSession = Depends(get_session)):
    """The device asks every few seconds; once the owner has confirmed, it gets its token (once)."""
    pairing = await session.get(DevicePairing, _digest(payload.device_code))
    if not pairing or _aware(pairing.expires_at) <= _now():
        raise HTTPException(404, "Mã kết nối đã hết hạn. Máy đo sẽ tạo mã mới.")
    if not pairing.user_id:
        return JSONResponse({"status": "pending"}, status_code=202)
    user = await session.get(User, pairing.user_id)
    token = secrets.token_urlsafe(32)
    session.add(Device(user_id=pairing.user_id, token_hash=_digest(token), name=pairing.device_name))
    await session.delete(pairing)  # the token is handed out once
    await session.commit()
    return {"status": "approved", "token": token, "display_name": user.display_name}


async def _pairing_for(code: str, user: User, session: AsyncSession) -> DevicePairing:
    """The live pairing for a code the owner typed or scanned. Wrong codes count against the same limit as sharing codes."""
    since = _now() - timedelta(seconds=FAILED_WINDOW_SECONDS)
    failures = await session.scalar(select(func.count()).select_from(CareCodeFailure).where(
        CareCodeFailure.user_id == user.id, CareCodeFailure.created_at >= since))
    if failures >= MAX_FAILED_CODES:
        raise HTTPException(429, "Bạn đã nhập sai mã quá nhiều lần. Hãy thử lại sau 15 phút.")
    pairing = await session.scalar(select(DevicePairing).where(DevicePairing.user_code_hash == _digest(_normalize(code))))
    if not pairing or _aware(pairing.expires_at) <= _now():
        session.add(CareCodeFailure(user_id=user.id))
        await session.commit()
        raise HTTPException(404, "Mã không đúng hoặc đã hết hạn. Hãy xem mã mới trên màn hình máy đo.")
    if pairing.user_id and pairing.user_id != user.id:
        raise HTTPException(409, "Máy đo này đang được kết nối với tài khoản khác.")
    return pairing


@router.get("/pair/{code}")
async def pairing_info(code: str, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    pairing = await _pairing_for(code, user, session)
    return {"device_name": pairing.device_name}


@router.post("/pair/approve")
async def approve_pairing(payload: PairCode, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    if not user.onboarding_completed or not user.health_profile:
        raise HTTPException(409, "Hãy hoàn thành hồ sơ sức khỏe trước khi kết nối máy đo.")
    pairing = await _pairing_for(payload.code, user, session)
    pairing.user_id = user.id
    await session.execute(delete(CareCodeFailure).where(CareCodeFailure.user_id == user.id))
    name = pairing.device_name
    await session.commit()
    return {"device_name": name}


@router.get("/me")
async def device_me(device: Device = Depends(current_device), session: AsyncSession = Depends(get_session)):
    """The device checks it is still linked and learns whose readings it records."""
    user = await session.get(User, device.user_id)
    device.last_seen_at = _now()
    await session.commit()
    return {"display_name": user.display_name, "device_name": device.name}


@router.delete("/me", status_code=204)
async def device_sign_out(device: Device = Depends(current_device), session: AsyncSession = Depends(get_session)):
    """"Đăng xuất" on the device itself: its token stops working."""
    await session.delete(device)
    await session.commit()
    return Response(status_code=204)


@router.get("")
async def list_devices(user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    rows = await session.scalars(select(Device).where(Device.user_id == user.id).order_by(Device.created_at))
    return [{"id": d.id, "name": d.name, "created_at": d.created_at, "last_seen_at": d.last_seen_at} for d in rows]


@router.delete("/{device_id}", status_code=204)
async def remove_device(device_id: str, user: User = Depends(current_user), session: AsyncSession = Depends(get_session)):
    result = await session.execute(delete(Device).where(Device.id == device_id, Device.user_id == user.id))
    if not result.rowcount:
        raise HTTPException(404, "Không tìm thấy máy đo này.")
    await session.commit()
    return Response(status_code=204)
