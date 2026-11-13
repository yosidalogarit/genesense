"""Browser OAuth handoff bound to a verifier held only by the initiating app."""
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import digest, issue_session, settings
from .database import get_session
from .models import AppLoginAttempt, User

router = APIRouter(prefix="/api/auth/mobile", tags=["Account"])


class AppLoginStart(BaseModel):
    challenge: str = Field(pattern=r"^[a-f0-9]{64}$")


class AppLoginPoll(BaseModel):
    id: str = Field(min_length=32, max_length=64)
    verifier: str = Field(pattern=r"^[a-f0-9]{64}$")


@router.post("/start")
async def start(body: AppLoginStart, session: AsyncSession = Depends(get_session)):
    if not settings.google_enabled:
        raise HTTPException(503, "Máy chủ chưa cấu hình đăng nhập Google.")
    now = datetime.now(timezone.utc)
    await session.execute(delete(AppLoginAttempt).where(AppLoginAttempt.expires_at <= now))
    attempt = AppLoginAttempt(id=secrets.token_urlsafe(32), challenge=body.challenge,
                              expires_at=now + timedelta(minutes=5))
    session.add(attempt)
    await session.commit()
    return {"id": attempt.id, "url": "/api/auth/google?mobile=" + attempt.id}


@router.post("/poll")
async def poll(body: AppLoginPoll, request: Request, session: AsyncSession = Depends(get_session)):
    attempt = await session.get(AppLoginAttempt, body.id)
    if (not attempt or attempt.expires_at.replace(tzinfo=timezone.utc) <= datetime.now(timezone.utc)
            or not secrets.compare_digest(attempt.challenge, digest(body.verifier))):
        raise HTTPException(400, "Phiên đăng nhập đã hết hạn. Hãy thử lại.")
    if not attempt.user_id:
        return {"status": "pending"}
    # Only one poll can redeem this attempt, including concurrent retries.
    user_id = await session.scalar(delete(AppLoginAttempt).where(
        AppLoginAttempt.id == body.id, AppLoginAttempt.challenge == digest(body.verifier),
        AppLoginAttempt.user_id.is_not(None), AppLoginAttempt.expires_at > datetime.now(timezone.utc)
    ).returning(AppLoginAttempt.user_id).execution_options(synchronize_session=False))
    if not user_id:
        raise HTTPException(400, "Phiên đăng nhập đã được sử dụng.")
    user = await session.get(User, user_id)
    if not user:
        raise HTTPException(400, "Tài khoản không còn khả dụng.")
    return await issue_session(request, JSONResponse({"status": "authenticated"}), user, session)


def completed_page():
    return HTMLResponse('<!doctype html><html lang="vi"><meta charset="utf-8">'
                        '<meta name="viewport" content="width=device-width,initial-scale=1">'
                        '<title>Đã đăng nhập GeneSense</title><h1>Đã đăng nhập Google</h1>'
                        '<p>Quay lại ứng dụng GeneSense để tiếp tục.</p></html>')
