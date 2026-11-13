"""Google sign-in for the iOS and Android apps, bound to the app that started it.

The app keeps a random verifier and sends only its SHA-256 (the challenge) to /start. After Google, the callback
re-keys the attempt under a fresh one-time code and sends the browser to genesense://auth?code=..., which only the
app on that phone receives. /redeem needs that code and the verifier, so a sign-in link sent to someone else
cannot log the sender in: the sender never sees the code, and the receiver's app does not hold the verifier.
"""
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import digest, issue_session, settings
from .database import get_session
from .models import AppLoginAttempt, User

router = APIRouter(prefix="/api/auth/mobile", tags=["Account"])

APP_CALLBACK = "genesense://auth"
ATTEMPT_MINUTES = 5
# ponytail: one shared cap on live attempts for the whole site (each lasts 5 minutes); add a per-address limit
# if someone keeps it full and real sign-ins start failing.
MAX_LIVE_ATTEMPTS = 300


class AppLoginStart(BaseModel):
    challenge: str = Field(pattern=r"^[a-f0-9]{64}$")


class AppLoginRedeem(BaseModel):
    code: str = Field(min_length=32, max_length=64)
    verifier: str = Field(pattern=r"^[a-f0-9]{64}$")


def _now():
    return datetime.now(timezone.utc)


@router.post("/start")
async def start(body: AppLoginStart, session: AsyncSession = Depends(get_session)):
    if not settings.google_enabled:
        raise HTTPException(503, "Máy chủ chưa cấu hình đăng nhập Google.")
    await session.execute(delete(AppLoginAttempt).where(AppLoginAttempt.expires_at <= _now()))
    if await session.scalar(select(func.count()).select_from(AppLoginAttempt)) >= MAX_LIVE_ATTEMPTS:
        await session.commit()
        raise HTTPException(429, "Đang có quá nhiều yêu cầu đăng nhập. Hãy thử lại sau ít phút.")
    attempt = AppLoginAttempt(id=secrets.token_urlsafe(32), challenge=body.challenge,
                              expires_at=_now() + timedelta(minutes=ATTEMPT_MINUTES))
    session.add(attempt)
    await session.commit()
    return {"url": settings.app_base_url.rstrip("/") + "/api/auth/google?mobile=" + attempt.id}


async def finish(session: AsyncSession, attempt_id: str, user: User) -> RedirectResponse:
    """Called by the Google callback: hand the app a fresh one-time code (the started id is never redeemable)."""
    attempt = await session.get(AppLoginAttempt, attempt_id)
    if not attempt or attempt.user_id or attempt.expires_at.replace(tzinfo=timezone.utc) <= _now():
        await session.commit()
        return RedirectResponse(APP_CALLBACK + "?" + urlencode({"error": "expired"}), status_code=303)
    code = secrets.token_urlsafe(32)
    session.add(AppLoginAttempt(id=code, challenge=attempt.challenge, user_id=user.id, expires_at=attempt.expires_at))
    await session.delete(attempt)
    await session.commit()
    return RedirectResponse(APP_CALLBACK + "?" + urlencode({"code": code}), status_code=303)


@router.post("/redeem")
async def redeem(body: AppLoginRedeem, request: Request, session: AsyncSession = Depends(get_session)):
    # One statement, so only one request can redeem a code, including concurrent retries.
    user_id = await session.scalar(delete(AppLoginAttempt).where(
        AppLoginAttempt.id == body.code, AppLoginAttempt.challenge == digest(body.verifier),
        AppLoginAttempt.user_id.is_not(None), AppLoginAttempt.expires_at > _now()
    ).returning(AppLoginAttempt.user_id).execution_options(synchronize_session=False))
    if not user_id:
        await session.commit()
        raise HTTPException(400, "Phiên đăng nhập đã hết hạn hoặc đã được dùng. Hãy thử lại.")
    user = await session.get(User, user_id)
    if not user:
        raise HTTPException(400, "Tài khoản không còn khả dụng.")
    return await issue_session(request, JSONResponse({"status": "authenticated"}), user, session)
